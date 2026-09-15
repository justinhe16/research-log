import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { papers, searchDocuments, searchPapers, searches, topics } from "@/lib/db/schema";
import { fromBuffer } from "@/lib/embedding";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";
import {
  createTopic,
  deleteTopic,
  getTopicByIdOrSlug,
  listTopicCards,
  refreshTopicDenormalized,
  updateTopic,
} from "@/lib/landscape/queries/topic-repo";
import type { SearchStatus } from "@/lib/landscape/types";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.$client.close();
});

const v = (...xs: number[]) => Float32Array.from(xs);

function seedSearch(
  id: string,
  topicId: string,
  status: SearchStatus,
  extra: Partial<typeof searches.$inferInsert> = {},
) {
  db.insert(searches)
    .values({ id, topicId, depth: "quick", config: DEPTH_PRESETS.quick, status, ...extra })
    .run();
}

function seedSelectedPapers(searchId: string, n: number, unselected = 0) {
  for (let i = 0; i < n + unselected; i++) {
    const pid = `${searchId}-p${i}`;
    db.insert(papers).values({ id: pid, title: pid, normTitle: pid }).onConflictDoNothing().run();
    db.insert(searchPapers).values({ searchId, paperId: pid, origin: "query", selected: i < n }).run();
  }
}

describe("createTopic / getTopicByIdOrSlug", () => {
  it("creates with a unique slug and stored embedding", () => {
    const a = createTopic(db, { name: "  RAG ", description: " retrieval ", depth: "deep", embedding: v(1, 2, 3) });
    const b = createTopic(db, { name: "rag", depth: "quick", embedding: null });
    expect(a).toMatchObject({
      slug: "rag",
      name: "RAG",
      description: "retrieval",
      defaultDepth: "deep",
      paperCount: 0,
      lastSearch: null,
      activeSearch: null,
      summary: null,
    });
    expect(b.slug).toBe("rag-2");

    const row = db.select().from(topics).where(eq(topics.id, a.id)).get()!;
    expect(fromBuffer(row.embedding!)).toEqual(v(1, 2, 3));

    expect(getTopicByIdOrSlug(db, a.id)?.id).toBe(a.id);
    expect(getTopicByIdOrSlug(db, "rag-2")?.id).toBe(b.id);
    expect(getTopicByIdOrSlug(db, "nope")).toBeNull();
  });
});

describe("updateTopic", () => {
  it("keeps the slug stable across renames", async () => {
    const t = createTopic(db, { name: "Diffusion", depth: "standard", embedding: null });
    const renamed = await updateTopic(db, t.id, { name: "Score-based Generative Models" });
    expect(renamed).toMatchObject({ id: t.id, slug: "diffusion", name: "Score-based Generative Models" });
    expect(renamed!.updatedAt).toMatch(/T/);
    expect(getTopicByIdOrSlug(db, "diffusion")?.id).toBe(t.id);
  });

  it("re-embeds on rename, leaves embedding on depth-only change", async () => {
    const t = createTopic(db, { name: "Diffusion", depth: "standard", embedding: v(1, 0) });
    const calls: string[] = [];
    const reembed = async (text: string) => {
      calls.push(text);
      return v(0, 1);
    };

    const depthOnly = await updateTopic(db, t.id, { defaultDepth: "deep" }, { reembed });
    expect(depthOnly?.defaultDepth).toBe("deep");
    expect(calls).toEqual([]);

    const renamed = await updateTopic(db, t.slug, { name: "Diffusion Models", description: "images" }, { reembed });
    expect(calls).toEqual(["Diffusion Models. images"]);
    expect(renamed).toMatchObject({ id: t.id, slug: "diffusion", description: "images" });
    const row = db.select().from(topics).where(eq(topics.id, t.id)).get()!;
    expect(fromBuffer(row.embedding!)).toEqual(v(0, 1));

    // A failing embedder clears the stale vector.
    await updateTopic(db, t.id, { name: "Other" }, { reembed: async () => Promise.reject(new Error("x")) });
    expect(db.select().from(topics).where(eq(topics.id, t.id)).get()!.embedding).toBeNull();

    expect(await updateTopic(db, "missing", { name: "x" })).toBeNull();
  });
});

describe("deleteTopic", () => {
  it("refuses while a search is active, then deletes", () => {
    const t = createTopic(db, { name: "GNNs", depth: "quick", embedding: null });
    seedSearch("s1", t.id, "running");

    expect(deleteTopic(db, t.id)).toEqual({ ok: false, reason: "active_search", searchId: "s1" });
    expect(getTopicByIdOrSlug(db, t.id)).not.toBeNull();

    db.update(searches).set({ status: "done" }).where(eq(searches.id, "s1")).run();
    expect(deleteTopic(db, t.slug)).toEqual({ ok: true, id: t.id });
    expect(getTopicByIdOrSlug(db, t.id)).toBeNull();
    expect(db.select().from(searches).all()).toEqual([]);
    expect(deleteTopic(db, t.id)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("listTopicCards / refreshTopicDenormalized", () => {
  it("includes last and active searches with paper counts", () => {
    const a = createTopic(db, { name: "A", depth: "quick", embedding: null });
    const b = createTopic(db, { name: "B", depth: "standard", embedding: null });

    seedSearch("a-old", a.id, "done", { createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T01:00:00.000Z" });
    seedSearch("a-new", a.id, "done", { createdAt: "2026-02-01T00:00:00.000Z", finishedAt: "2026-02-01T01:00:00.000Z" });
    seedSearch("a-err", a.id, "error", { createdAt: "2026-03-01T00:00:00.000Z" });
    seedSearch("a-run", a.id, "running", { stage: "extract", progress: 0.4, kind: "refresh" });
    seedSelectedPapers("a-new", 3, 2);
    db.insert(searchDocuments)
      .values({ searchId: "a-new", kind: "clusters", data: { topicSummary: "The field in brief." } })
      .run();

    refreshTopicDenormalized(db, a.id);
    refreshTopicDenormalized(db, b.id);

    const cards = listTopicCards(db);
    expect(cards.map((c) => c.id)).toEqual([b.id, a.id]); // b created now > a's lastSearchAt (Feb)

    const ca = cards.find((c) => c.id === a.id)!;
    expect(ca).toMatchObject({
      paperCount: 3,
      lastSearchAt: "2026-02-01T01:00:00.000Z",
      summary: "The field in brief.",
    });
    expect(ca.lastSearch).toMatchObject({ id: "a-new", status: "done", paperCount: 3, depth: "quick" });
    expect(ca.activeSearch).toMatchObject({
      id: "a-run",
      status: "running",
      stage: "extract",
      progress: 0.4,
      kind: "refresh",
      paperCount: 0,
    });

    const cb = cards.find((c) => c.id === b.id)!;
    expect(cb).toMatchObject({ paperCount: 0, lastSearch: null, activeSearch: null, lastSearchAt: null });

    // Partial unique index: a second active search for the same topic is rejected.
    expect(() => seedSearch("a-q", a.id, "queued")).toThrow(/UNIQUE/);

    // Card via getTopicByIdOrSlug matches the list.
    expect(getTopicByIdOrSlug(db, a.id)).toEqual(ca);
  });

  it("rewrites leaked refs in the card summary against the latest search", () => {
    const a = createTopic(db, { name: "A", depth: "quick", embedding: null });
    seedSearch("a-new", a.id, "done", { createdAt: "2026-02-01T00:00:00.000Z", finishedAt: "2026-02-01T01:00:00.000Z" });
    seedSelectedPapers("a-new", 1, 0);
    db.insert(searchDocuments)
      .values({ searchId: "a-new", kind: "clusters", data: { topicSummary: "Led by P1 (P7); a P100 GPU." } })
      .run();
    refreshTopicDenormalized(db, a.id);
    const card = listTopicCards(db).find((c) => c.id === a.id)!;
    expect(card.summary).toBe("Led by a-new-p0; a P100 GPU.");
  });

  it("resets denormalized fields when no done search remains", () => {
    const t = createTopic(db, { name: "T", depth: "quick", embedding: null });
    seedSearch("s1", t.id, "done", { finishedAt: "2026-02-01T00:00:00.000Z" });
    seedSelectedPapers("s1", 2);
    refreshTopicDenormalized(db, t.id);
    expect(getTopicByIdOrSlug(db, t.id)).toMatchObject({ paperCount: 2, lastSearchAt: "2026-02-01T00:00:00.000Z" });

    db.delete(searches).where(eq(searches.id, "s1")).run();
    refreshTopicDenormalized(db, t.id);
    const row = db.select().from(topics).where(eq(topics.id, t.id)).get()!;
    expect(row).toMatchObject({ paperCount: 0, lastSearchAt: null, lastSearchId: null });
  });
});

describe("timestamp ordering", () => {
  it("orders SQLite-default timestamps correctly next to ISO ones", () => {
    // Same day: "2026-02-01 05:00:00" is later than "2026-02-01T01:00:00.000Z",
    // but a raw string compare puts the space form first.
    db.insert(topics).values({ id: "legacy", slug: "legacy", name: "Legacy", createdAt: "2026-02-01 05:00:00" }).run();
    db.insert(topics).values({ id: "iso", slug: "iso", name: "Iso", createdAt: "2026-02-01T01:00:00.000Z" }).run();
    expect(listTopicCards(db).map((c) => c.id)).toEqual(["legacy", "iso"]);

    seedSearch("s-iso", "iso", "done", { createdAt: "2026-03-01T00:00:00.000Z", finishedAt: "2026-03-01T01:00:00.000Z" });
    seedSearch("s-legacy", "iso", "done", { createdAt: "2026-03-01 00:00:00", finishedAt: "2026-03-01 05:00:00" });
    refreshTopicDenormalized(db, "iso");
    expect(getTopicByIdOrSlug(db, "iso")).toMatchObject({
      lastSearchAt: "2026-03-01T05:00:00",
      lastSearch: { id: "s-legacy" },
    });
  });
});
