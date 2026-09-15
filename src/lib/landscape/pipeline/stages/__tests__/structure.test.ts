import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import {
  paperCitations,
  paperExtractions,
  paperFulltext,
  papers,
  searchClusters,
  searchDocuments,
  searchEdges,
  searchPapers,
  searches,
  topics,
} from "@/lib/db/schema";
import { toBuffer } from "@/lib/embedding";
import { DEPTH_PRESETS, EXTRACTION_VERSION } from "@/lib/landscape/constants";
import { sourceHash, type ExtractionFields } from "@/lib/landscape/llm/extract";
import type { RunSynthesisInput, RunSynthesisResult } from "@/lib/landscape/llm/synthesize";
import { DOCUMENT_SCHEMAS } from "@/lib/landscape/llm/synthesize/schemas";
import type { DepthConfig, SearchCounters, StageContext } from "@/lib/landscape/types";
import { createStructureStages, type StructureDeps } from "../structure";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const TOPIC = "topic-1";
const SEARCH = "search-1";
const DIM = 8;

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});
afterEach(() => {
  db.$client.close();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two well-separated groups: papers 0-4 near axis 0, 5-9 near axis 1. */
function vec(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i < 5 ? 0 : 1] = 1;
  v[2 + (i % 5)] = 0.15;
  return v;
}

function fakeCtx(overrides: Partial<StageContext> = {}) {
  const counters: SearchCounters = {};
  const logs: string[] = [];
  const controller = new AbortController();
  const ctx: StageContext = {
    searchId: SEARCH,
    topicId: TOPIC,
    kind: "initial",
    config: DEPTH_PRESETS.quick,
    baseSearchId: null,
    checkpoint: null,
    saveCheckpoint: () => {},
    updateCounters: (patch) => Object.assign(counters, patch),
    setStageProgress: () => {},
    throwIfCancelled: () => {},
    signal: controller.signal,
    recorder: { record: () => {} },
    hasS2Key: true,
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { ctx, counters, logs };
}

function seedTopic() {
  db.insert(topics).values({ id: TOPIC, slug: "sae", name: "Sparse autoencoders", description: "interp" }).run();
}

function seedSearch(id: string, extra: Partial<typeof searches.$inferInsert> = {}, config: DepthConfig = DEPTH_PRESETS.quick) {
  db.insert(searches)
    .values({ id, topicId: TOPIC, depth: config.depth, config, status: "running", createdAt: "2026-05-01T00:00:00.000Z", ...extra })
    .run();
}

function seedPapers(n = 10) {
  for (let i = 0; i < n; i++) {
    db.insert(papers)
      .values({
        id: `p${i}`,
        title: i < 5 ? `Sparse dictionary features paper ${i}` : `Circuit discovery attention heads ${i}`,
        normTitle: `p${i}`,
        abstract: i < 5 ? "sparse autoencoder dictionary learning features" : "circuit discovery attention heads patching",
        authors: [{ name: `A${i}`, s2Id: i % 2 === 0 ? `s2a${i}` : null, openalexId: i % 2 === 1 ? `A${i}` : null }],
        year: 2020 + (i % 5),
        publishedAt: `${2020 + (i % 5)}-06-01`,
        citationCount: (i + 1) * 10,
        influentialCitationCount: i,
        embedding: toBuffer(vec(i)),
        arxivId: `2401.0000${i}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  }
}

function seedSelection(searchId: string, ids: string[], unselected: string[] = []) {
  ids.forEach((id, i) =>
    db.insert(searchPapers).values({ searchId, paperId: id, origin: "query", selected: true, finalRank: i + 1 }).run(),
  );
  for (const id of unselected) db.insert(searchPapers).values({ searchId, paperId: id, origin: "query" }).run();
}

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `p${i + from}`);

const fields = (tag: string): ExtractionFields => ({
  problem: `problem ${tag}`,
  method: `method ${tag}`,
  results: `results ${tag}`,
  contribution: `contribution ${tag}`,
  limitations: null,
  datasets: [],
  benchmarks: [],
});

function deps(overrides: Partial<StructureDeps> = {}): Partial<StructureDeps> {
  const fail = (name: string) => async () => {
    throw new Error(`${name} should not be called`);
  };
  return {
    db,
    now: () => NOW,
    batchAuthors: fail("batchAuthors"),
    authorHIndex: fail("authorHIndex"),
    fetchPaperPdf: fail("fetchPaperPdf"),
    extractPdfText: fail("extractPdfText"),
    runExtractions: fail("runExtractions"),
    extractFulltext: fail("extractFulltext"),
    runSynthesis: fail("runSynthesis"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

describe("graph stage", () => {
  beforeEach(() => {
    seedTopic();
    seedSearch(SEARCH);
    seedPapers();
    seedSelection(SEARCH, ids(8), ["p8", "p9"]);
    // Everyone cites p0; p1 -> p2 influential; p8 (unselected) -> p1.
    const cites: [string, string, boolean][] = [
      ["p1", "p0", false],
      ["p2", "p0", false],
      ["p3", "p0", true],
      ["p5", "p0", false],
      ["p1", "p2", true],
      ["p8", "p1", false],
    ];
    for (const [citing, cited, isInfluential] of cites) db.insert(paperCitations).values({ citingId: citing, citedId: cited, isInfluential }).run();
  });

  it("stores max-normalized pagerank, velocity, h-index, influence, game changers and edges", async () => {
    const batchAuthors = vi.fn(async (authorIds: string[]) => {
      // S2 knows p0's and p2's authors; p4's author is unknown to S2 and has no OpenAlex id.
      return new Map(
        authorIds.filter((a) => a !== "s2a4" && a !== "s2a6").map((a) => [a, { authorId: a, hIndex: Number(a.slice(3)) + 20, citationCount: 1 }]),
      );
    });
    const authorHIndex = vi.fn(async (oa: string[]) => new Map(oa.map((a) => [a, 7])));
    const stages = createStructureStages(deps({ batchAuthors, authorHIndex }));
    const { ctx } = fakeCtx();
    await stages.graph!(ctx);

    expect(batchAuthors).toHaveBeenCalledTimes(1);
    expect(batchAuthors.mock.calls[0][0]).toEqual(["s2a0", "s2a2", "s2a4", "s2a6"]);
    expect(authorHIndex.mock.calls[0][0]).toEqual(["A1", "A3", "A5", "A7"]);

    const rows = db.select().from(searchPapers).where(eq(searchPapers.searchId, SEARCH)).all();
    const byId = new Map(rows.map((r) => [r.paperId, r]));
    const prs = rows.map((r) => r.pagerank!);
    expect(Math.max(...prs)).toBeCloseTo(1, 10);
    expect(byId.get("p0")!.pagerank).toBe(1);
    expect(prs.every((v) => v > 0 && v <= 1)).toBe(true);

    // Velocity: citations per year. p0: 10 cites, published 2020-06-01, now 2026-06-01 = 6y.
    expect(byId.get("p0")!.velocity).toBeCloseTo(10 / 6, 2);
    expect(rows.every((r) => r.influence! >= 0 && r.influence! <= 1)).toBe(true);
    expect(rows.filter((r) => r.gameChanger).every((r) => r.selected)).toBe(true);
    expect(rows.some((r) => r.gameChanger)).toBe(true);

    // h-index: S2 for even authors, OpenAlex fallback for odd ones.
    const p2 = db.select().from(papers).where(eq(papers.id, "p2")).get()!;
    expect(p2.maxAuthorHIndex).toBe(22);
    expect(p2.authors[0].hIndex).toBe(22);
    expect(db.select().from(papers).where(eq(papers.id, "p1")).get()!.maxAuthorHIndex).toBe(7);
    expect(db.select().from(papers).where(eq(papers.id, "p4")).get()!.maxAuthorHIndex).toBeNull();
    expect(byId.get("p2")!.maxAuthorHIndex).toBe(22);

    const edges = db.select().from(searchEdges).where(eq(searchEdges.searchId, SEARCH)).all();
    const citeEdges = edges.filter((e) => e.kind !== "similar");
    // Only citations among selected papers (p8 -> p1 excluded).
    expect(citeEdges).toHaveLength(5);
    expect(citeEdges.find((e) => e.sourceId === "p1" && e.targetId === "p2")!.kind).toBe("builds_on");
    expect(edges.some((e) => e.sourceId === "p8" || e.targetId === "p8")).toBe(false);

    // Idempotent: a second run replaces edges rather than duplicating them.
    await stages.graph!(ctx);
    expect(db.select().from(searchEdges).where(eq(searchEdges.searchId, SEARCH)).all()).toHaveLength(edges.length);
  });

  it("continues with a warning when both author lookups fail", async () => {
    const boom = async () => {
      throw new Error("503");
    };
    const stages = createStructureStages(deps({ batchAuthors: boom, authorHIndex: boom }));
    const { ctx, logs } = fakeCtx();
    await stages.graph!(ctx);
    expect(logs.some((l) => l.includes("author batch failed"))).toBe(true);
    const p0 = db.select().from(searchPapers).where(and(eq(searchPapers.searchId, SEARCH), eq(searchPapers.paperId, "p0"))).get()!;
    expect(p0.pagerank).toBe(1);
  });

  it("stores null PageRank (not a uniform 1.0) when there are no citation edges", async () => {
    db.delete(paperCitations).run();
    const none = async () => new Map();
    const stages = createStructureStages(deps({ batchAuthors: none, authorHIndex: none }));
    const { ctx, logs } = fakeCtx();
    await stages.graph!(ctx);
    const rows = db.select().from(searchPapers).where(eq(searchPapers.searchId, SEARCH)).all();
    expect(rows.every((r) => r.pagerank === null)).toBe(true);
    // Influence still spans 0..1 from citations / velocity / influential / h-index.
    expect(Math.max(...rows.map((r) => r.influence!))).toBeGreaterThan(0.9);
    expect(rows.some((r) => r.gameChanger)).toBe(true);
    expect(logs.some((l) => l.includes("0 local citations"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cluster
// ---------------------------------------------------------------------------

describe("cluster stage", () => {
  beforeEach(() => {
    seedTopic();
    seedPapers(12);
  });

  function snapshot(searchId: string) {
    const clusters = db
      .select({ idx: searchClusters.idx, label: searchClusters.label, size: searchClusters.size, keyTerms: searchClusters.keyTerms, yearMin: searchClusters.yearMin, yearMax: searchClusters.yearMax, base: searchClusters.baseClusterIdx, change: searchClusters.change })
      .from(searchClusters)
      .where(eq(searchClusters.searchId, searchId))
      .all();
    const assign = db
      .select({ paperId: searchPapers.paperId, idx: searchPapers.clusterIdx })
      .from(searchPapers)
      .where(eq(searchPapers.searchId, searchId))
      .all();
    return { clusters, assign };
  }

  it("clusters deterministically, writes key terms, sizes and year ranges", async () => {
    seedSearch(SEARCH);
    seedSelection(SEARCH, ids(10));
    const stages = createStructureStages(deps());
    const { ctx, counters } = fakeCtx();
    await stages.cluster!(ctx);
    const first = snapshot(SEARCH);

    expect(first.clusters).toHaveLength(2);
    expect(counters.clusters).toBe(2);
    expect(first.clusters.map((c) => c.size)).toEqual([5, 5]);
    for (const c of first.clusters) {
      expect(c.keyTerms.length).toBeGreaterThan(0);
      expect(c.label).not.toBe("Untitled cluster");
      expect(c.yearMin).toBe(2020);
      expect(c.yearMax).toBe(2024);
      expect(c.change).toBeNull();
    }
    const groupA = first.assign.filter((a) => ["p0", "p1", "p2", "p3", "p4"].includes(a.paperId)).map((a) => a.idx);
    expect(new Set(groupA).size).toBe(1);

    await stages.cluster!(ctx);
    expect(snapshot(SEARCH)).toEqual(first);
  });

  it("matches clusters against the base search on refresh", async () => {
    seedSearch("base", { status: "done" });
    seedSelection("base", ids(10));
    const stages = createStructureStages(deps());
    await stages.cluster!(fakeCtx({ searchId: "base" }).ctx);

    seedSearch(SEARCH, { kind: "refresh", baseSearchId: "base" });
    // Same two themes; p10 and p11 join the circuits theme (5 -> 7 papers).
    seedSelection(SEARCH, ["p0", "p1", "p2", "p3", "p4", "p10", "p5", "p6", "p7", "p8", "p9", "p11"]);
    await stages.cluster!(fakeCtx({ kind: "refresh", baseSearchId: "base" }).ctx);

    const base = snapshot("base");
    const cur = snapshot(SEARCH);
    expect(cur.clusters.every((c) => c.base !== null)).toBe(true);
    expect(cur.clusters.map((c) => [c.size, c.change])).toEqual([
      [7, "grew"],
      [5, "stable"],
    ]);
    // p0's cluster maps to p0's base cluster.
    const curIdx = cur.assign.find((a) => a.paperId === "p0")!.idx;
    const baseIdx = base.assign.find((a) => a.paperId === "p0")!.idx;
    expect(cur.clusters.find((c) => c.idx === curIdx)!.base).toBe(baseIdx);
  });
});

// ---------------------------------------------------------------------------
// fulltext + extract
// ---------------------------------------------------------------------------

describe("fulltext stage", () => {
  it("fetches the top M, skips existing rows, and warns per failure", async () => {
    seedTopic();
    const config = { ...DEPTH_PRESETS.standard, fulltextCount: 3 };
    seedSearch(SEARCH, {}, config);
    seedPapers(5);
    seedSelection(SEARCH, ids(5));
    db.insert(paperFulltext).values({ paperId: "p0", text: "existing", source: "arxiv", hash: sourceHash("existing") }).run();

    const fetchPaperPdf = vi.fn(async (p: { arxivId?: string | null }) => {
      if (p.arxivId === "2401.00002") throw new Error("404");
      return { bytes: new Uint8Array([1]), url: `https://arxiv.org/pdf/${p.arxivId}`, via: "arxiv" as const };
    });
    const extractPdfText = vi.fn(async () => ({ text: "body text ".repeat(100), pages: 3 }));
    const stages = createStructureStages(deps({ fetchPaperPdf, extractPdfText }));
    const { ctx, counters, logs } = fakeCtx({ config });
    await stages.fulltext!(ctx);

    expect(fetchPaperPdf).toHaveBeenCalledTimes(2); // p1, p2 (p0 existed, p3+ beyond M)
    const rows = db.select().from(paperFulltext).all();
    expect(rows.map((r) => r.paperId).sort()).toEqual(["p0", "p1"]);
    expect(rows.find((r) => r.paperId === "p1")!.hash).toBe(sourceHash("body text ".repeat(100).trim()));
    expect(counters.fulltextFetched).toBe(2);
    expect(logs.some((l) => l.includes("p2") && l.includes("404"))).toBe(true);
  });

  it("is skipped when the depth has no full-text budget", async () => {
    const stages = createStructureStages(deps());
    expect(await stages.fulltext!(fakeCtx().ctx)).toBe("skipped");
  });
});

describe("extract stage", () => {
  beforeEach(() => {
    seedTopic();
    seedSearch(SEARCH);
    seedPapers(10);
    seedSelection(SEARCH, ids(10));
  });

  it("uses cached extractions without calling the LLM and prefers full text", async () => {
    // p0: cached abstract extraction. p1: full text available (uncached).
    const abs0 = db.select().from(papers).where(eq(papers.id, "p0")).get()!.abstract!;
    db.insert(paperExtractions)
      .values({ id: "x0", paperId: "p0", version: EXTRACTION_VERSION, source: "abstract", sourceHash: sourceHash(abs0), model: "m", method: "cached", contribution: "cached" })
      .run();
    const ftText = "full text of paper one ".repeat(50);
    db.insert(paperFulltext).values({ paperId: "p1", text: ftText, source: "arxiv", hash: sourceHash(ftText) }).run();

    const runExtractions = vi.fn<NonNullable<StructureDeps["runExtractions"]>>(async (input, opts) => {
      const results = new Map<string, ExtractionFields>();
      for (const p of input) {
        results.set(p.paperId, fields(p.paperId));
        await opts?.onResult?.(p.paperId, fields(p.paperId));
      }
      return { results, failures: [] };
    });
    const extractFulltext = vi.fn(async () => fields("ft"));
    const recorder = { record: vi.fn() };
    const stages = createStructureStages(deps({ runExtractions, extractFulltext }));
    const { ctx, counters } = fakeCtx({ recorder });
    await stages.extract!(ctx);

    expect(extractFulltext).toHaveBeenCalledTimes(1);
    expect(runExtractions).toHaveBeenCalledTimes(1);
    const sent = runExtractions.mock.calls[0][0].map((p) => p.paperId);
    expect(sent).toEqual(ids(8, 2));
    expect(runExtractions.mock.calls[0][1]!.recorder).toBe(recorder);
    expect(counters).toMatchObject({ extracted: 10, extractionCacheHits: 1, extractionFailed: 0 });

    const sp = db.select().from(searchPapers).where(eq(searchPapers.searchId, SEARCH)).all();
    expect(sp.every((r) => r.extractionId)).toBe(true);
    expect(sp.find((r) => r.paperId === "p0")!.extractionId).toBe("x0");
    const x1 = db.select().from(paperExtractions).where(eq(paperExtractions.paperId, "p1")).get()!;
    expect(x1).toMatchObject({ source: "fulltext", sourceHash: sourceHash(ftText), version: EXTRACTION_VERSION });

    // Second run: everything is a cache hit.
    runExtractions.mockClear();
    extractFulltext.mockClear();
    const again = fakeCtx();
    await stages.extract!(again.ctx);
    expect(runExtractions).not.toHaveBeenCalled();
    expect(extractFulltext).not.toHaveBeenCalled();
    expect(again.counters.extractionCacheHits).toBe(10);
  });

  it("fails only when more than 30% of papers fail", async () => {
    const failing = (n: number) =>
      vi.fn<NonNullable<StructureDeps["runExtractions"]>>(async (input, opts) => {
        const results = new Map<string, ExtractionFields>();
        const failures = [];
        for (const [i, p] of input.entries()) {
          if (i < n) failures.push({ paperId: p.paperId, error: "bad" });
          else {
            results.set(p.paperId, fields(p.paperId));
            await opts?.onResult?.(p.paperId, fields(p.paperId));
          }
        }
        return { results, failures };
      });

    await expect(createStructureStages(deps({ runExtractions: failing(3) })).extract!(fakeCtx().ctx)).resolves.toBeUndefined();
    // The 3 failed papers are retried; 4 of them failing now is 40% of 10.
    db.update(searchPapers).set({ extractionId: null }).run();
    db.delete(paperExtractions).run();
    const { ctx, counters } = fakeCtx();
    await expect(createStructureStages(deps({ runExtractions: failing(4) })).extract!(ctx)).rejects.toThrow(/4 of 10/);
    expect(counters.extractionFailed).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// diff, synthesize, finalize
// ---------------------------------------------------------------------------

describe("diff stage", () => {
  it("is skipped without a base search", async () => {
    expect(await createStructureStages(deps()).diff!(fakeCtx().ctx)).toBe("skipped");
  });

  it("stores a valid diff document", async () => {
    seedTopic();
    seedPapers(12);
    seedSearch("base", { status: "done", startedAt: "2026-01-01T00:00:00.000Z" });
    seedSelection("base", ids(10));
    db.update(searchPapers).set({ citationCount: 10 }).where(eq(searchPapers.searchId, "base")).run();
    const stages = createStructureStages(deps());
    await stages.cluster!(fakeCtx({ searchId: "base" }).ctx);

    seedSearch(SEARCH, { kind: "refresh", baseSearchId: "base", since: "2026-01-01" });
    seedSelection(SEARCH, [...ids(9), "p10"]);
    db.update(searchPapers).set({ citationCount: 12 }).where(eq(searchPapers.searchId, SEARCH)).run();
    db.update(searchPapers).set({ citationCount: 30 }).where(and(eq(searchPapers.searchId, SEARCH), eq(searchPapers.paperId, "p3"))).run();
    const { ctx, counters } = fakeCtx({ kind: "refresh", baseSearchId: "base" });
    await stages.cluster!(ctx);
    await stages.diff!(ctx);

    const row = db.select().from(searchDocuments).where(eq(searchDocuments.searchId, SEARCH)).get()!;
    expect(row).toMatchObject({ kind: "diff", status: "done" });
    const doc = DOCUMENT_SCHEMAS.diff.parse(row.data);
    expect(doc).toMatchObject({ baseSearchId: "base", since: "2026-01-01", newPaperIds: ["p10"], droppedPaperIds: ["p9"] });
    expect(doc.rising).toEqual([{ paperId: "p3", citationsBefore: 10, citationsAfter: 30, delta: 20 }]);
    expect(doc.clusterChanges.length).toBeGreaterThan(0);
    expect(counters.newPapers).toBe(1);
  });
});

describe("synthesize stage", () => {
  beforeEach(async () => {
    seedTopic();
    seedSearch(SEARCH, { startedAt: "2026-05-01T00:00:00.000Z" });
    seedPapers(10);
    seedSelection(SEARCH, ids(10));
    await createStructureStages(deps()).cluster!(fakeCtx().ctx);
  });

  it("stores per-kind results, keeps going on partial failure, and resumes only failed kinds", async () => {
    const calls: RunSynthesisInput[] = [];
    let attempt = 0;
    const runSynthesis = vi.fn(async (input: RunSynthesisInput): Promise<RunSynthesisResult> => {
      calls.push(input);
      attempt++;
      const refMap = input.dossier.refMap as Record<string, string>;
      const result: RunSynthesisResult = { documents: {}, errors: {}, topicSummary: null, clusterLabels: {} };
      for (const kind of input.kinds ?? []) {
        if (kind === "clusters") {
          result.documents.clusters = {
            topicSummary: "SAEs decompose activations.",
            clusters: [{ idx: 0, name: "Dictionary learning", summary: "Features.", keyIdeas: ["sparsity"], representativePaperIds: [refMap.P1] }],
          };
        } else if (kind === "tensions") {
          result.documents.tensions = { tensions: [] };
        } else if (attempt === 1) {
          result.errors[kind] = `${kind} exploded`;
        } else if (kind === "gaps") {
          result.documents.gaps = { gaps: [] };
        } else if (kind === "narrative") {
          result.documents.narrative = { eras: [], gameChangers: [], frontier: { summary: "x", paperIds: [] }, outlook: "y", whatChanged: null };
        } else if (kind === "reading_path") {
          result.documents.reading_path = { steps: [{ phase: "foundations", paperId: refMap.P2, reason: "start" }] };
        }
      }
      return result;
    });
    const stages = createStructureStages(deps({ runSynthesis }));
    const { ctx, counters, logs } = fakeCtx();
    await expect(stages.synthesize!(ctx)).resolves.toBeUndefined();

    // Refs are P{final_rank}, matching the snapshot read model.
    const ranks = db.select({ paperId: searchPapers.paperId, finalRank: searchPapers.finalRank }).from(searchPapers).where(eq(searchPapers.searchId, SEARCH)).all();
    expect(calls[0].dossier.refMap).toEqual(Object.fromEntries(ranks.map((r) => [`P${r.finalRank}`, r.paperId])));
    expect(calls[0].dossier.refMap).toMatchObject({ P1: "p0", P2: "p1", P10: "p9" });
    expect(calls[0].depthSynthCalls).toBe(3);
    expect(calls[0].kinds).toEqual(["clusters", "tensions", "gaps", "narrative", "reading_path"]);

    const docs = () => new Map(db.select().from(searchDocuments).where(eq(searchDocuments.searchId, SEARCH)).all().map((d) => [d.kind, d]));
    let stored = docs();
    expect(stored.get("clusters")!.status).toBe("done");
    expect(stored.get("tensions")!.status).toBe("done");
    expect(stored.get("gaps")).toMatchObject({ status: "error", error: "gaps exploded", data: null });
    expect(stored.get("narrative")!.status).toBe("error");
    expect(counters).toMatchObject({ documentsDone: 2, documentsFailed: 3 });
    expect(logs.some((l) => l.includes("3 document(s) failed"))).toBe(true);

    const c0 = db.select().from(searchClusters).where(and(eq(searchClusters.searchId, SEARCH), eq(searchClusters.idx, 0))).get()!;
    expect(c0).toMatchObject({ label: "Dictionary learning", summary: "Features." });

    // Resume: only the failed kinds run; the dossier is byte-identical.
    await stages.synthesize!(ctx);
    expect(calls[1].kinds).toEqual(["gaps", "narrative", "reading_path"]);
    expect(calls[1].dossier.text).toBe(calls[0].dossier.text);
    stored = docs();
    for (const d of stored.values()) expect(d.status).toBe("done");
    expect(DOCUMENT_SCHEMAS.reading_path.parse(stored.get("reading_path")!.data).steps[0].paperId).toBe("p1");
    expect(counters).toMatchObject({ documentsDone: 5, documentsFailed: 0 });

    // Nothing left: no call.
    await stages.synthesize!(ctx);
    expect(runSynthesis).toHaveBeenCalledTimes(2);
  });
});

describe("synthesize stage (empty-diff refresh)", () => {
  const BASE = "base-search";
  const baseDocs = {
    clusters: { topicSummary: "SAEs.", clusters: [{ idx: 0, name: "Dictionary learning", summary: "Features.", keyIdeas: [], representativePaperIds: ["p0"] }] },
    tensions: { tensions: [] },
    gaps: { gaps: [] },
    narrative: { eras: [], gameChangers: [], frontier: { summary: "x", paperIds: [] }, outlook: "y", whatChanged: null },
    reading_path: { steps: [{ phase: "foundations", paperId: "p1", reason: "start" }] },
  };

  function setup(opts: { newPaper?: boolean } = {}) {
    seedTopic();
    seedPapers(6);
    seedSearch(BASE, { status: "done", startedAt: "2026-04-01T00:00:00.000Z" });
    seedSelection(BASE, ids(5));
    seedSearch(SEARCH, { kind: "refresh", baseSearchId: BASE, startedAt: "2026-05-01T00:00:00.000Z" });
    seedSelection(SEARCH, opts.newPaper ? [...ids(4), "p5"] : ids(5));
    for (const sid of [BASE, SEARCH]) {
      db.update(searchPapers).set({ clusterIdx: 0 }).where(eq(searchPapers.searchId, sid)).run();
    }
    for (const [kind, data] of Object.entries(baseDocs)) {
      db.insert(searchDocuments).values({ searchId: BASE, kind: kind as never, status: "done", data, model: "claude-sonnet-5" }).run();
    }
    const diff = {
      baseSearchId: BASE,
      since: "2026-04-01",
      newPaperIds: opts.newPaper ? ["p5"] : [],
      droppedPaperIds: opts.newPaper ? ["p4"] : [],
      rising: [],
      clusterChanges: [{ idx: 0, baseIdxs: [0], change: "stable", label: "c0", sizeBefore: 5, sizeAfter: 5 }],
    };
    db.insert(searchDocuments).values({ searchId: SEARCH, kind: "diff", status: "done", data: diff }).run();
  }

  it("copies the base documents without calling the LLM when nothing changed", async () => {
    setup();
    const runSynthesis = vi.fn<StructureDeps["runSynthesis"]>();
    const { ctx, counters, logs } = fakeCtx({ kind: "refresh", baseSearchId: BASE });
    await createStructureStages(deps({ runSynthesis })).synthesize!(ctx);
    expect(runSynthesis).not.toHaveBeenCalled();
    const docs = new Map(db.select().from(searchDocuments).where(eq(searchDocuments.searchId, SEARCH)).all().map((d) => [d.kind, d]));
    expect(docs.get("reading_path")).toMatchObject({ status: "done", data: baseDocs.reading_path, model: "claude-sonnet-5" });
    expect(DOCUMENT_SCHEMAS.narrative.parse(docs.get("narrative")!.data).whatChanged).toMatch(/Nothing material changed/);
    expect(counters).toMatchObject({ synthesisReused: 5, documentsDone: 5, documentsFailed: 0 });
    expect(logs.some((l) => l.includes("reused 5 document(s)"))).toBe(true);
  });

  it("synthesizes normally when the selection changed", async () => {
    setup({ newPaper: true });
    const runSynthesis = vi.fn<StructureDeps["runSynthesis"]>(async () => ({ documents: {}, errors: {}, topicSummary: null, clusterLabels: {} }));
    const { ctx, counters } = fakeCtx({ kind: "refresh", baseSearchId: BASE });
    await createStructureStages(deps({ runSynthesis })).synthesize!(ctx);
    expect(runSynthesis).toHaveBeenCalledTimes(1);
    expect(counters.synthesisReused).toBeUndefined();
  });
});

describe("synthesize stage (retry checkpoint)", () => {
  it("honours { retryKinds } from the checkpoint and still skips done kinds", async () => {
    seedTopic();
    seedSearch(SEARCH);
    seedPapers(4);
    // Non-contiguous ranks to show refs are P{final_rank}, not positions.
    [["p0", 2], ["p1", 5], ["p2", 7], ["p3", 9]].forEach(([id, rank]) =>
      db.insert(searchPapers).values({ searchId: SEARCH, paperId: id as string, origin: "query", selected: true, finalRank: rank as number }).run(),
    );
    db.insert(searchDocuments).values({ searchId: SEARCH, kind: "gaps", status: "done", data: { gaps: [] } }).run();
    db.insert(searchDocuments).values({ searchId: SEARCH, kind: "tensions", status: "error", error: "old" }).run();

    const runSynthesis = vi.fn<StructureDeps["runSynthesis"]>(async () => ({
      documents: { tensions: { tensions: [] } },
      errors: {},
      topicSummary: null,
      clusterLabels: {},
    }));
    const { ctx, counters } = fakeCtx({ checkpoint: { retryKinds: ["tensions", "gaps"] } });
    await createStructureStages(deps({ runSynthesis })).synthesize!(ctx);

    expect(runSynthesis).toHaveBeenCalledTimes(1);
    const input = runSynthesis.mock.calls[0][0];
    expect(input.kinds).toEqual(["tensions"]);
    expect(input.dossier.refMap).toEqual({ P2: "p0", P5: "p1", P7: "p2", P9: "p3" });
    const tensions = db.select().from(searchDocuments).where(and(eq(searchDocuments.searchId, SEARCH), eq(searchDocuments.kind, "tensions"))).get()!;
    expect(tensions).toMatchObject({ status: "done", error: null });
    expect(counters).toMatchObject({ documentsDone: 2, documentsFailed: 0 });
  });
});

describe("finalize stage", () => {
  it("writes the topic card fields and final counters", async () => {
    seedTopic();
    seedSearch(SEARCH);
    seedPapers(6);
    seedSelection(SEARCH, ids(4), ["p4", "p5"]);
    db.insert(searchDocuments)
      .values({ searchId: SEARCH, kind: "clusters", status: "done", data: { topicSummary: "  The field in brief. ", clusters: [] } })
      .run();
    db.insert(searchDocuments).values({ searchId: SEARCH, kind: "gaps", status: "error", error: "x" }).run();

    const { ctx, counters } = fakeCtx();
    await createStructureStages(deps()).finalize!(ctx);

    const topic = db.select().from(topics).where(eq(topics.id, TOPIC)).get()!;
    expect(topic).toMatchObject({ lastSearchId: SEARCH, lastSearchAt: NOW.toISOString(), paperCount: 4, summary: "The field in brief." });
    expect(counters).toMatchObject({ selected: 4, documentsDone: 1, documentsFailed: 1, extracted: 0 });
  });

  it("does not steal the card from a newer done search (document retry on an old search)", async () => {
    seedTopic();
    seedSearch("newer", { status: "done", createdAt: "2026-05-10T00:00:00.000Z", finishedAt: "2026-05-10T01:00:00.000Z" });
    seedSearch(SEARCH, { createdAt: "2026-05-01T00:00:00.000Z" });
    seedPapers(3);
    seedSelection("newer", ids(2));
    seedSelection(SEARCH, ids(3));
    await createStructureStages(deps()).finalize!(fakeCtx().ctx);
    const topic = db.select().from(topics).where(eq(topics.id, TOPIC)).get()!;
    expect(topic).toMatchObject({ lastSearchId: "newer", paperCount: 2 });
  });

  it("defers to refreshTopicDenormalized when the search is already done", async () => {
    seedTopic();
    seedSearch(SEARCH, { status: "done", finishedAt: "2026-05-02T00:00:00.000Z" });
    seedPapers(3);
    seedSelection(SEARCH, ids(3));
    await createStructureStages(deps()).finalize!(fakeCtx().ctx);
    const topic = db.select().from(topics).where(eq(topics.id, TOPIC)).get()!;
    expect(topic).toMatchObject({ lastSearchId: SEARCH, lastSearchAt: "2026-05-02T00:00:00.000Z", paperCount: 3 });
  });
});
