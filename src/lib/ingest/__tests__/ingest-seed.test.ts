import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { entries } from "@/lib/db/schema";
import type { ExtractedContent } from "@/lib/ingest/extract";
import type { Extraction } from "@/lib/ingest/summarize";

const h = vi.hoisted(() => ({
  db: null as Db | null,
  extractContent: vi.fn<(url: string) => Promise<ExtractedContent>>(),
  summarize: vi.fn<(content: ExtractedContent) => Promise<Extraction>>(),
  runIngest: null as null | ((id: string, opts?: unknown) => Promise<void>),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
}));
vi.mock("@/lib/embedding", () => ({
  embed: vi.fn(async () => new Float32Array([0.1, 0.2])),
  toBuffer: (v: Float32Array) => Buffer.from(v.buffer),
}));
vi.mock("@/lib/ingest/extract", async (orig) => ({
  ...(await orig<typeof import("@/lib/ingest/extract")>()),
  extractContent: h.extractContent,
}));
vi.mock("@/lib/ingest/summarize", () => ({ summarize: h.summarize }));

const { runIngest } = await import("@/lib/ingest");
const { contentFromSeed } = await import("@/lib/ingest/extract");
const { POST } = await import("@/app/api/entries/route");

const analysis = (over: Partial<Extraction> = {}): Extraction => ({
  title: "Model title",
  summary: "Summary.",
  keyClaims: ["claim"],
  tags: ["sae"],
  authors: ["Model Guess"],
  org: null,
  venue: null,
  publishedAt: null,
  contentType: "blog",
  category: "Interpretability",
  ...over,
});

const seed = {
  title: "Scaling and evaluating sparse autoencoders",
  authors: ["Leo Gao", "Jeff Wu"],
  publishedAt: "2024-06-06",
  venue: "ICLR",
  abstract: "Sparse autoencoders provide a promising unsupervised approach.",
};

function insertEntry(over: Partial<typeof entries.$inferInsert> = {}) {
  const now = new Date().toISOString();
  h.db!.insert(entries).values({ id: "e1", url: "https://arxiv.org/abs/2406.04093", createdAt: now, updatedAt: now, ...over }).run();
}
const row = () => h.db!.select().from(entries).where(eq(entries.id, "e1")).get()!;

beforeEach(() => {
  h.db = createDb(":memory:");
  h.extractContent.mockReset();
  h.summarize.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  h.db!.$client.close();
  vi.restoreAllMocks();
});

describe("contentFromSeed", () => {
  it("needs an abstract", () => {
    expect(contentFromSeed("u", null)).toBeNull();
    expect(contentFromSeed("u", { title: "t", abstract: "  " })).toBeNull();
  });

  it("builds paper content from title, authors, venue and abstract", () => {
    const c = contentFromSeed("https://x", seed)!;
    expect(c).toMatchObject({ url: "https://x", title: seed.title, contentType: "paper", authors: seed.authors, venue: "ICLR", publishedAt: "2024-06-06" });
    expect(c.text).toContain(`Title: ${seed.title}`);
    expect(c.text).toContain(`Abstract:\n${seed.abstract}`);
  });
});

describe("runIngest with seed metadata", () => {
  it("summarizes from the seeded abstract when fetching fails", async () => {
    insertEntry({ title: seed.title });
    h.extractContent.mockRejectedValue(new Error("Network error fetching arXiv"));
    h.summarize.mockResolvedValue(analysis());

    await runIngest("e1", { seed });

    expect(h.summarize).toHaveBeenCalledTimes(1);
    const content = h.summarize.mock.calls[0][0];
    expect(content.contentType).toBe("paper");
    expect(content.text).toContain(seed.abstract);
    expect(row()).toMatchObject({
      ingestStatus: "done",
      ingestError: null,
      title: seed.title,
      authors: seed.authors,
      venue: "ICLR",
      publishedAt: "2024-06-06",
      contentType: "paper",
      summary: "Summary.",
    });
  });

  it("uses fetched content when fetching works", async () => {
    insertEntry({ title: seed.title });
    const fetched: ExtractedContent = { url: "u", title: "T", text: "full text", contentType: "paper", authors: [], publishedAt: null, venue: null, org: "arXiv" };
    h.extractContent.mockResolvedValue(fetched);
    h.summarize.mockResolvedValue(analysis());
    await runIngest("e1", { seed });
    expect(h.summarize.mock.calls[0][0]).toBe(fetched);
    expect(row()).toMatchObject({ ingestStatus: "done", authors: seed.authors, contentType: "paper" });
  });

  it("still fails without a seed (existing behaviour)", async () => {
    insertEntry();
    h.extractContent.mockRejectedValue(new Error("HTTP 503"));
    await runIngest("e1");
    expect(h.summarize).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ ingestStatus: "error", ingestError: "HTTP 503", title: "" });
  });

  it("fails when the seed has no abstract", async () => {
    insertEntry();
    h.extractContent.mockRejectedValue(new Error("HTTP 503"));
    await runIngest("e1", { seed: { ...seed, abstract: null } });
    expect(row()).toMatchObject({ ingestStatus: "error", ingestError: "HTTP 503" });
  });

  it("keeps the model's metadata without a seed", async () => {
    insertEntry();
    h.extractContent.mockResolvedValue({ url: "u", title: "T", text: "x", contentType: "blog", authors: [], publishedAt: null, venue: null, org: null });
    h.summarize.mockResolvedValue(analysis({ venue: "Blog" }));
    await runIngest("e1");
    expect(row()).toMatchObject({ title: "Model title", authors: ["Model Guess"], venue: "Blog", contentType: "blog" });
  });
});

describe("POST /api/entries seed", () => {
  const post = (body: unknown) =>
    POST(new Request("http://localhost/api/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("stores seeded metadata immediately", async () => {
    h.extractContent.mockRejectedValue(new Error("offline"));
    h.summarize.mockResolvedValue(analysis());
    const res = await post({ url: "https://arxiv.org/abs/2406.04093", seed: { ...seed, publishedAt: "not a date" } });
    expect(res.status).toBe(201);
    const { entry } = (await res.json()) as { entry: { id: string; title: string; authors: string[]; venue: string; publishedAt: string | null; contentType: string } };
    expect(entry).toMatchObject({ title: seed.title, authors: seed.authors, venue: "ICLR", publishedAt: null, contentType: "paper" });
  });

  it("rejects oversized seed fields", async () => {
    const res = await post({ url: "https://x.org", seed: { title: "t".repeat(501) } });
    expect(res.status).toBe(400);
    const res2 = await post({ url: "https://x.org", seed: { authors: Array.from({ length: 101 }, () => "A") } });
    expect(res2.status).toBe(400);
  });

  it("accepts entries without a seed", async () => {
    h.extractContent.mockRejectedValue(new Error("offline"));
    const res = await post({ url: "https://x.org" });
    expect(res.status).toBe(201);
    const { entry } = (await res.json()) as { entry: { title: string; contentType: string } };
    expect(entry).toMatchObject({ title: "", contentType: "other" });
  });
});
