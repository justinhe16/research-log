import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import {
  paperCitations,
  paperExtractions,
  paperFulltext,
  papers,
  searchDocuments,
  searchEdges,
  searchPapers,
  searches,
  topics,
} from "@/lib/db/schema";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";
import {
  getPapersByIds,
  mergePapers,
  updatePaperMetrics,
  upsertPaper,
  upsertPapers,
} from "@/lib/landscape/papers/repo";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.$client.close();
});

const TITLE = "Attention Is All You Need For Everything";
const vaswani = [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }];

function count(table: typeof papers) {
  return db.select().from(table).all().length;
}

function get(id: string) {
  return db.select().from(papers).where(eq(papers.id, id)).get()!;
}

describe("upsertPaper", () => {
  it("inserts a new paper with normalized ids", () => {
    const id = upsertPaper(db, {
      title: TITLE,
      arxivId: "arXiv:1706.03762v7",
      doi: "https://doi.org/10.5555/ABC",
      openalexId: "https://openalex.org/W123",
      authors: vaswani,
      year: 2017,
    });
    const row = get(id);
    expect(row.arxivId).toBe("1706.03762");
    expect(row.doi).toBe("10.5555/abc");
    expect(row.openalexId).toBe("W123");
    expect(row.normTitle).toBe("attention is all you need for everything");
  });

  it.each([
    ["arxivId", { arxivId: "https://arxiv.org/abs/1706.03762" }],
    ["doi", { doi: "10.5555/ABC" }],
    ["s2Id", { s2Id: "s2-1" }],
    ["openalexId", { openalexId: "W123" }],
  ])("matches by %s", (_k, ids) => {
    const id = upsertPaper(db, {
      title: TITLE,
      arxivId: "1706.03762",
      doi: "10.5555/abc",
      s2Id: "s2-1",
      openalexId: "W123",
    });
    expect(upsertPaper(db, { title: "Totally different title", ...ids })).toBe(id);
    expect(count(papers)).toBe(1);
  });

  it("fills nulls, keeps max metrics, prefers arXiv abstract, unions author fields", () => {
    const id = upsertPaper(db, {
      title: TITLE,
      s2Id: "s2-1",
      abstract: "short s2 abstract",
      citationCount: 100,
      influentialCitationCount: 5,
      authors: [{ name: "Ashish Vaswani", hIndex: 30 }],
      source: "s2",
    });
    upsertPaper(db, {
      title: TITLE,
      s2Id: "s2-1",
      arxivId: "1706.03762",
      venue: "NeurIPS",
      abstract: "arxiv abstract",
      citationCount: 50,
      influentialCitationCount: 9,
      authors: [{ name: "Ashish Vaswani", s2Id: "a1", hIndex: 20 }],
      source: "arxiv",
    });
    let row = get(id);
    expect(row.arxivId).toBe("1706.03762");
    expect(row.venue).toBe("NeurIPS");
    expect(row.abstract).toBe("arxiv abstract");
    expect(row.citationCount).toBe(100);
    expect(row.influentialCitationCount).toBe(9);
    expect(row.authors).toEqual([{ name: "Ashish Vaswani", s2Id: "a1", hIndex: 30 }]);
    expect(row.metricsUpdatedAt).not.toBeNull();

    // A longer non-arXiv abstract does not replace an arXiv row's abstract.
    upsertPaper(db, { title: TITLE, s2Id: "s2-1", abstract: "a much longer openalex abstract text" });
    row = get(id);
    expect(row.abstract).toBe("arxiv abstract");
  });

  it("derives arxivId from an arXiv DOI and never stores it as the doi", () => {
    const id = upsertPaper(db, { title: "Short", arxivId: "2305.00001" });
    expect(upsertPaper(db, { title: "Short", doi: "https://doi.org/10.48550/arXiv.2305.00001" })).toBe(id);
    expect(get(id).doi).toBeNull();

    const other = upsertPaper(db, { title: "Other", doi: "10.48550/arXiv.2306.00002" });
    expect(get(other)).toMatchObject({ arxivId: "2306.00002", doi: null });
    expect(upsertPaper(db, { title: "Other", arxivId: "2306.00002", doi: "10.1145/Journal.1" })).toBe(other);
    expect(get(other)).toMatchObject({ arxivId: "2306.00002", doi: "10.1145/journal.1" });
    expect(count(papers)).toBe(2);
  });

  it("matches and upgrades a legacy row whose doi slot holds an arXiv DOI", () => {
    db.insert(papers).values({ id: "L", title: "Legacy", normTitle: "legacy", doi: "10.48550/arxiv.2307.00003" }).run();
    expect(upsertPaper(db, { title: "Legacy", arxivId: "2307.00003", doi: "10.1145/j.2" })).toBe("L");
    expect(get("L")).toMatchObject({ arxivId: "2307.00003", doi: "10.1145/j.2" });
  });

  it("treats empty-string ids as null", () => {
    const a = upsertPaper(db, { title: "Paper one about things", arxivId: "", doi: "", s2Id: " ", openalexId: "" });
    const b = upsertPaper(db, { title: "Paper two about stuff", arxivId: "", doi: "", s2Id: "", openalexId: "" });
    expect(a).not.toBe(b);
    const row = get(a);
    expect([row.arxivId, row.doi, row.s2Id, row.openalexId]).toEqual([null, null, null, null]);
  });

  describe("title fallback", () => {
    const base = { title: TITLE, authors: vaswani, year: 2017, s2Id: "s2-1" };

    it("matches on norm title + year ±1 + first author last name", () => {
      const id = upsertPaper(db, base);
      expect(
        upsertPaper(db, {
          title: "Attention is all you need, for everything!",
          authors: [{ name: "Vaswani, A." }],
          year: 2018,
          openalexId: "W9",
        }),
      ).toBe(id);
      expect(get(id).openalexId).toBe("W9");
    });

    it("rejects a different year", () => {
      const id = upsertPaper(db, base);
      expect(upsertPaper(db, { title: TITLE, authors: vaswani, year: 2019 })).not.toBe(id);
    });

    it("rejects a missing year", () => {
      const id = upsertPaper(db, base);
      expect(upsertPaper(db, { title: TITLE, authors: vaswani })).not.toBe(id);
    });

    it("rejects a different first author", () => {
      const id = upsertPaper(db, base);
      expect(upsertPaper(db, { title: TITLE, authors: [{ name: "Noam Shazeer" }], year: 2017 })).not.toBe(id);
    });

    it("skips short titles", () => {
      const id = upsertPaper(db, { ...base, title: "Deep Learning" });
      expect(upsertPaper(db, { title: "Deep Learning", authors: vaswani, year: 2017 })).not.toBe(id);
    });

    it("rejects conflicting external ids", () => {
      const id = upsertPaper(db, base);
      expect(upsertPaper(db, { ...base, s2Id: "s2-other" })).not.toBe(id);
    });
  });
});

describe("mergePapers", () => {
  function seed() {
    db.insert(topics).values({ id: "t1", slug: "t1", name: "T" }).run();
    for (const s of ["s1", "s2"]) {
      db.insert(searches).values({ id: s, topicId: "t1", depth: "quick", config: DEPTH_PRESETS.quick, status: "done" }).run();
    }
    db.insert(papers)
      .values([
        { id: "A", title: TITLE, normTitle: "a", arxivId: "1706.03762", createdAt: "2024-01-01 00:00:00", citationCount: 10 },
        { id: "B", title: TITLE, normTitle: "b", doi: "10.5555/abc", createdAt: "2024-02-01 00:00:00", venue: "NeurIPS", citationCount: 40 },
        { id: "C", title: TITLE, normTitle: "c", s2Id: "s2-1", createdAt: "2024-03-01 00:00:00", abstract: "abs" },
        { id: "X", title: "Other", normTitle: "other", createdAt: "2024-01-01 00:00:00" },
      ])
      .run();

    // search_papers: s1 has both A and B (conflict), s2 has only C.
    db.insert(searchPapers)
      .values([
        { searchId: "s1", paperId: "A", origin: "query", finalRank: 5 },
        { searchId: "s1", paperId: "B", origin: "query", selected: true, finalRank: 2 },
        { searchId: "s2", paperId: "C", origin: "citation" },
        { searchId: "s2", paperId: "X", origin: "query" },
      ])
      .run();

    // extractions: A and B share a cache key (conflict); C has a distinct one.
    db.insert(paperExtractions)
      .values([
        { id: "eA", paperId: "A", version: 1, source: "abstract", sourceHash: "h1", model: "m" },
        { id: "eB", paperId: "B", version: 1, source: "abstract", sourceHash: "h1", model: "m" },
        { id: "eC", paperId: "C", version: 1, source: "fulltext", sourceHash: "h2", model: "m" },
      ])
      .run();
    db.update(searchPapers).set({ extractionId: "eB" }).where(eq(searchPapers.paperId, "B")).run();
    db.update(searchPapers).set({ extractionId: "eC" }).where(eq(searchPapers.paperId, "C")).run();

    // citations: A->X and B->X conflict; B->A becomes a self-loop; X->C repoints; C->B self-loop.
    db.insert(paperCitations)
      .values([
        { citingId: "A", citedId: "X" },
        { citingId: "B", citedId: "X", isInfluential: true },
        { citingId: "B", citedId: "A" },
        { citingId: "X", citedId: "C" },
        { citingId: "X", citedId: "A" },
        { citingId: "C", citedId: "B" },
      ])
      .run();

    // fulltext: B and C both have one (conflict on keeper after the first move).
    db.insert(paperFulltext)
      .values([
        { paperId: "B", text: "b text", source: "arxiv", hash: "hb" },
        { paperId: "C", text: "c text", source: "s2", hash: "hc" },
      ])
      .run();

    db.insert(searchEdges)
      .values([
        { searchId: "s1", sourceId: "A", targetId: "X", kind: "cites" },
        { searchId: "s1", sourceId: "B", targetId: "X", kind: "cites", weight: 3 },
        { searchId: "s2", sourceId: "X", targetId: "X", kind: "similar" },
        { searchId: "s1", sourceId: "C", targetId: "A", kind: "similar" },
      ])
      .run();
  }

  it("upsert with ids spanning three rows merges into the oldest without constraint errors", () => {
    seed();
    const id = upsertPaper(db, {
      title: TITLE,
      arxivId: "1706.03762",
      doi: "10.5555/abc",
      s2Id: "s2-1",
      citationCount: 20,
    });
    expect(id).toBe("A");

    const all = db.select().from(papers).all();
    expect(all.map((p) => p.id).sort()).toEqual(["A", "X"]);
    const a = get("A");
    expect([a.arxivId, a.doi, a.s2Id]).toEqual(["1706.03762", "10.5555/abc", "s2-1"]);
    expect(a.venue).toBe("NeurIPS");
    expect(a.abstract).toBe("abs");
    expect(a.citationCount).toBe(40);

    const sp = db.select().from(searchPapers).all();
    const s1 = sp.filter((r) => r.searchId === "s1");
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ paperId: "A", selected: true, finalRank: 2, extractionId: "eA" });
    expect(sp.find((r) => r.searchId === "s2" && r.paperId === "A")).toMatchObject({ extractionId: "eC" });

    const ex = db.select().from(paperExtractions).all();
    expect(ex.map((e) => [e.id, e.paperId]).sort()).toEqual([
      ["eA", "A"],
      ["eC", "A"],
    ]);

    const cites = db.select().from(paperCitations).all();
    expect(cites.every((c) => c.citingId !== c.citedId)).toBe(true);
    expect(cites.map((c) => `${c.citingId}->${c.citedId}`).sort()).toEqual(["A->X", "X->A"]);
    expect(cites.find((c) => c.citingId === "A")!.isInfluential).toBe(true);

    const ft = db.select().from(paperFulltext).all();
    expect(ft).toHaveLength(1);
    expect(ft[0]).toMatchObject({ paperId: "A", text: "b text" });

    const edges = db.select().from(searchEdges).all();
    // Unrelated pre-existing self-loops are untouched; the merged edge keeps the max weight.
    expect(edges.map((e) => `${e.sourceId}->${e.targetId}:${e.kind}`).sort()).toEqual(["A->X:cites", "X->X:similar"]);
    expect(edges.find((e) => e.sourceId === "A")!.weight).toBe(3);
  });

  it("mergePapers can be called directly and ignores the keeper in dropIds", () => {
    seed();
    mergePapers(db, "A", ["A", "C"]);
    expect(db.select().from(papers).all().map((p) => p.id).sort()).toEqual(["A", "B", "X"]);
    expect(get("A").s2Id).toBe("s2-1");
  });

  it("rewrites paper ids inside search_documents JSON, leaving unrelated documents alone", () => {
    seed();
    const untouchedAt = "2026-01-01T00:00:00.000Z";
    db.insert(searchDocuments)
      .values([
        {
          searchId: "s1",
          kind: "reading_path",
          data: { steps: [
            { phase: "foundations", paperId: "B", reason: "r1" },
            { phase: "core", paperId: "A", reason: "r2" },
            { phase: "frontier", paperId: "X", reason: "r3" },
          ] },
          createdAt: untouchedAt,
          updatedAt: untouchedAt,
        },
        {
          searchId: "s2",
          kind: "gaps",
          data: { gaps: [{ title: "g", description: "d", evidencePaperIds: ["C", "X"], directions: [] }] },
          createdAt: untouchedAt,
          updatedAt: untouchedAt,
        },
        {
          searchId: "s1",
          kind: "clusters",
          data: { topicSummary: "t", clusters: [{ idx: 0, name: "n", summary: "s", keyIdeas: [], representativePaperIds: ["X"] }] },
          createdAt: untouchedAt,
          updatedAt: untouchedAt,
        },
      ])
      .run();

    mergePapers(db, "A", ["B", "C"]);

    const doc = (searchId: string, kind: "reading_path" | "gaps" | "clusters") =>
      db.select().from(searchDocuments).all().find((d) => d.searchId === searchId && d.kind === kind)!;
    // B -> A collapses onto the existing A step (first occurrence wins).
    expect(doc("s1", "reading_path").data).toEqual({ steps: [
      { phase: "foundations", paperId: "A", reason: "r1" },
      { phase: "frontier", paperId: "X", reason: "r3" },
    ] });
    expect((doc("s2", "gaps").data as { gaps: { evidencePaperIds: string[] }[] }).gaps[0].evidencePaperIds).toEqual(["A", "X"]);
    expect(doc("s1", "clusters").updatedAt).toBe(untouchedAt);
  });
});

describe("batch helpers", () => {
  it("upsertPapers returns ids in order, deduping within the batch", () => {
    const inputs = Array.from({ length: 450 }, (_, i) => ({ title: `Paper number ${i % 300} here`, s2Id: `s${i % 300}` }));
    const ids = upsertPapers(db, inputs);
    expect(ids).toHaveLength(450);
    expect(ids[310]).toBe(ids[10]);
    expect(new Set(ids).size).toBe(300);
  });

  it("updatePaperMetrics overwrites provided values; getPapersByIds keeps order", () => {
    const a = upsertPaper(db, { title: "First paper title here", citationCount: 10, maxAuthorHIndex: 4 });
    const b = upsertPaper(db, { title: "Second paper title here" });
    updatePaperMetrics(db, a, { citationCount: 7, maxAuthorHIndex: null });
    expect(get(a)).toMatchObject({ citationCount: 7, maxAuthorHIndex: 4 });
    expect(getPapersByIds(db, [b, "missing", a]).map((p) => p.id)).toEqual([b, a]);
  });
});
