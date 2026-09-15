import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CachedHttpOptions } from "@/lib/landscape/sources/http";
import {
  batchAuthors,
  batchPapers,
  citations,
  parseS2Paper,
  references,
  s2YearParam,
  searchS2,
  type S2FetchJson,
} from "@/lib/landscape/sources/semantic-scholar";

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

type Call = { url: string; opts: CachedHttpOptions };

/** Fake fetcher: `respond` builds a response per call. */
function fake(respond: (url: URL, call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const fetchJson = (async (url: string, opts: CachedHttpOptions) => {
    const call = { url, opts };
    calls.push(call);
    return respond(new URL(url), call, calls.length - 1);
  }) as S2FetchJson;
  return { calls, fetchJson };
}

function rawPaper(i: number) {
  return { paperId: `p${i}`, title: `Paper ${i}`, externalIds: {}, authors: [] };
}

describe("parseS2Paper", () => {
  it("parses a full search hit", () => {
    const p = parseS2Paper(fixture("s2-search.json").data[0])!;
    expect(p).toMatchObject({
      title: "Sparse Autoencoders Find Highly Interpretable Features in Language Models",
      s2Id: "e3ce36b9deb47aa6bb2aa19c4bfa71283b505025",
      arxivId: "2309.08600",
      doi: null,
      year: 2023,
      publishedAt: "2023-09-15",
      venue: "International Conference on Learning Representations",
      arxivUrl: "https://arxiv.org/abs/2309.08600",
      pdfUrl: "https://arxiv.org/pdf/2309.08600",
      citationCount: 412,
      influentialCitationCount: 71,
      referenceCount: 58,
      maxAuthorHIndex: null,
      source: "s2",
    });
    expect(p.authors).toEqual([
      { name: "Hoagy Cunningham", s2Id: "2241404574" },
      { name: "Aidan Ewart", s2Id: "2073406233" },
      { name: "Logan Riggs", s2Id: null },
    ]);
  });

  it("handles null externalIds / abstract / venue and derives year from the date", () => {
    const p = parseS2Paper(fixture("s2-search.json").data[1])!;
    expect(p.title).toBe("Towards Monosemanticity: Decomposing Language Models With Dictionary Learning");
    expect(p.arxivId).toBeNull();
    expect(p.doi).toBeNull();
    expect(p.abstract).toBeNull();
    expect(p.venue).toBeNull();
    expect(p.year).toBe(2023);
    expect(p.pdfUrl).toBeNull();
    expect(p.influentialCitationCount).toBeNull();
    expect(p.authors).toEqual([]);
  });

  it("normalizes versioned arXiv ids, DOIs, author h-index, and venue fallbacks", () => {
    const [attn, missing, bert] = fixture("s2-batch.json").map(parseS2Paper);
    expect(missing).toBeNull();
    expect(attn).toMatchObject({ arxivId: "1706.03762", doi: "10.48550/arxiv.1706.03762", pdfUrl: null, maxAuthorHIndex: 45 });
    expect(attn!.authors![0]).toEqual({ name: "Ashish Vaswani", s2Id: "40348417", hIndex: 30 });
    expect(bert).toMatchObject({
      doi: "10.18653/v1/n19-1423",
      arxivId: null,
      venue: "North American Chapter of the Association for Computational Linguistics",
      publishedAt: null,
      year: 2019,
    });
  });

  it("rejects non-objects and untitled papers", () => {
    expect(parseS2Paper(null)).toBeNull();
    expect(parseS2Paper("x")).toBeNull();
    expect(parseS2Paper({ paperId: "a", title: "  " })).toBeNull();
  });
});

describe("searchS2", () => {
  it("paginates by offset until the limit and sends year/date filters", async () => {
    const { calls, fetchJson } = fake((url) => {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return { total: 1000, offset, next: offset + limit, data: Array.from({ length: limit }, (_, i) => rawPaper(offset + i)) };
    });
    const out = await searchS2("sparse autoencoders", {
      limit: 250,
      since: "2025-01-01",
      yearRange: { from: 2020 },
      fetchJson,
      cache: { ttlMs: 5 },
    });
    expect(out).toHaveLength(250);
    expect(out[249].s2Id).toBe("p249");
    expect(calls.map((c) => new URL(c.url).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("limit"))).toEqual(["100", "100", "50"]);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/graph/v1/paper/search");
    expect(u.searchParams.get("query")).toBe("sparse autoencoders");
    expect(u.searchParams.get("year")).toBe("2020-");
    expect(u.searchParams.get("publicationDateOrYear")).toBe("2025-01-01:");
    expect(u.searchParams.get("fields")).toContain("externalIds");
    expect(calls[0].opts).toMatchObject({ host: "s2", cache: { source: "s2", ttlMs: 5 } });
  });

  it("stops when `next` is absent", async () => {
    const { calls, fetchJson } = fake(() => fixture("s2-search.json"));
    const once = fake(() => ({ ...fixture("s2-search.json"), next: undefined }));
    expect(await searchS2("q", { limit: 50, fetchJson: once.fetchJson })).toHaveLength(2);
    expect(once.calls).toHaveLength(1);
    // With next=2 the second page repeats the fixture; still bounded by the limit.
    expect(await searchS2("q", { limit: 3, fetchJson })).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("clamps to the 1000-result window and ignores empty queries", async () => {
    const { calls, fetchJson } = fake((url) => {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return { next: offset + limit, data: Array.from({ length: limit }, (_, i) => rawPaper(offset + i)) };
    });
    const out = await searchS2("q", { limit: 5000, fetchJson });
    expect(out).toHaveLength(999);
    const last = new URL(calls.at(-1)!.url);
    expect(Number(last.searchParams.get("offset")) + Number(last.searchParams.get("limit"))).toBeLessThan(1000);
    expect(await searchS2("  ", { limit: 10, fetchJson })).toEqual([]);
  });

  it("formats year ranges", () => {
    expect(s2YearParam(null)).toBeNull();
    expect(s2YearParam({ from: 2019, to: 2023 })).toBe("2019-2023");
    expect(s2YearParam({ to: 2015 })).toBe("-2015");
    expect(s2YearParam({ from: 2020, to: 2020 })).toBe("2020");
  });
});

describe("batchPapers", () => {
  it("POSTs chunks and returns results aligned with ids", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => (i === 0 ? "ARXIV:1706.03762" : `id${i}`));
    const { calls, fetchJson } = fake((_url, call) => {
      const body = call.opts.json as { ids: string[] };
      return body.ids.map((id, i) => (i % 2 ? null : { paperId: id, title: `T ${id}` }));
    });
    const out = await batchPapers(ids, ["title", "paperId"], { fetchJson });
    expect(out).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect((calls[0].opts.json as { ids: string[] }).ids).toHaveLength(100);
    expect(calls[0].opts.method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/graph/v1/paper/batch");
    expect(new URL(calls[0].url).searchParams.get("fields")).toBe("title,paperId");
    expect(out[0]?.s2Id).toBe("ARXIV:1706.03762");
    expect(out[1]).toBeNull();
    expect(out[200]?.title).toBe("T id200");
  });

  it("parses the batch fixture", async () => {
    const { fetchJson } = fake(() => fixture("s2-batch.json"));
    const out = await batchPapers(["a", "b", "c"], undefined, { fetchJson });
    expect(out.map((p) => p?.title ?? null)).toEqual([
      "Attention is All you Need",
      null,
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    ]);
  });
});

describe("references / citations", () => {
  it("parses links, skipping unresolved papers", async () => {
    const { calls, fetchJson } = fake(() => ({ ...fixture("s2-references.json"), next: undefined }));
    const out = await references("seed1", { limit: 100, fetchJson });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ isInfluential: true, intents: ["methodology"], paper: { arxivId: "1706.03762" } });
    expect(out[1]).toMatchObject({ isInfluential: false, intents: [], paper: { doi: "10.1162/neco.1997.9.8.1735" } });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/graph/v1/paper/seed1/references");
    expect(u.searchParams.get("fields")!.split(",")).toEqual(expect.arrayContaining(["isInfluential", "intents", "title"]));
  });

  it("paginates citations and caps at the limit", async () => {
    const { calls, fetchJson } = fake((url) => {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const data = Array.from({ length: limit }, (_, i) => ({
        isInfluential: false,
        intents: ["background"],
        citingPaper: rawPaper(offset + i),
      }));
      return { offset, next: offset + limit, data };
    });
    const out = await citations("seed", { limit: 1500, fetchJson });
    expect(out).toHaveLength(1500);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).pathname).toBe("/graph/v1/paper/seed/citations");
    expect(calls.map((c) => new URL(c.url).searchParams.get("limit"))).toEqual(["1000", "500"]);
    expect(calls[1].url).toContain("offset=1000");
  });
});

describe("batchAuthors", () => {
  it("maps author ids to metrics and dedupes input", async () => {
    const { calls, fetchJson } = fake(() => fixture("s2-authors.json"));
    const out = await batchAuthors(["40348417", "999", "39172707", "40348417"], { fetchJson });
    expect((calls[0].opts.json as { ids: string[] }).ids).toEqual(["40348417", "999", "39172707"]);
    expect(new URL(calls[0].url).searchParams.get("fields")).toContain("hIndex");
    expect(out.get("40348417")).toEqual({ authorId: "40348417", hIndex: 30, citationCount: 150000 });
    expect(out.get("39172707")).toEqual({ authorId: "39172707", hIndex: 25, citationCount: null });
    expect(out.has("999")).toBe(false);
  });
});
