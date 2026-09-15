import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/create";
import { paperCitations, papers, searchPapers, searchStages } from "@/lib/db/schema";
import { toBuffer } from "@/lib/embedding";
import { CrossEncoderUnavailable } from "@/lib/landscape/rank/cross-encoder";
import type { S2CitationLink } from "@/lib/landscape/sources/semantic-scholar";
import { cosineRelevance, logitRelevance } from "@/lib/landscape/rank/calibrate";
import {
  fakeVector,
  freshDb,
  makeCtx,
  pool,
  s2Paper,
  seedPoolPaper,
  seedSearch,
  seedTopic,
  stagesFor,
} from "./discover-helpers";

let db: Db;
beforeEach(() => {
  db = freshDb();
  seedTopic(db);
});
afterEach(() => db.$client.close());

const queries = [{ text: "sparse autoencoders", arxiv: "", categories: [] }];

function row(searchId: string, paperId: string) {
  return db
    .select()
    .from(searchPapers)
    .where(and(eq(searchPapers.searchId, searchId), eq(searchPapers.paperId, paperId)))
    .get()!;
}

describe("embed + prerank", () => {
  it("embeds missing vectors and writes bm25 / cosine / rrf, honouring exclude terms", async () => {
    const id = seedSearch(db, { queries });
    db.update(searchStages)
      .set({ checkpoint: { done: true, extras: { categories: [], mustTerms: [], excludeTerms: ["genomics"] } } })
      .where(and(eq(searchStages.searchId, id), eq(searchStages.stage, "expand")))
      .run();
    seedPoolPaper(db, id, { id: "a", title: "Sparse autoencoders find interpretable features" }, { sourceRank: 3 });
    seedPoolPaper(db, id, { id: "b", title: "Sparse autoencoders for genomics", abstract: "genomics genomics sparse autoencoders" }, { sourceRank: 0 });
    seedPoolPaper(db, id, { id: "c", title: "Protein folding with transformers" }, { sourceRank: 1 });

    const embedMany = vi.fn(async (texts: readonly string[]) => texts.map(fakeVector));
    const stages = stagesFor(db, { embedMany });
    const ectx = makeCtx(db, id, "embed");
    await stages.embed(ectx);
    expect(ectx.counters.embedded).toBe(3);
    expect(db.select().from(papers).all().every((p) => p.embedding)).toBe(true);

    await stages.prerank(makeCtx(db, id, "prerank"));
    const a = row(id, "a");
    const b = row(id, "b");
    const c = row(id, "c");
    expect(a.bm25!).toBeGreaterThan(b.bm25!);
    expect(c.bm25).toBe(0);
    expect(a.cosine!).toBeGreaterThan(c.cosine!);
    expect(a.rrf!).toBeGreaterThan(c.rrf!);

    // Re-embedding is a no-op.
    embedMany.mockClear();
    await stages.embed(makeCtx(db, id, "embed"));
    expect(embedMany).not.toHaveBeenCalled();
  });
});

function link(s2Id: string, title: string, isInfluential = false): S2CitationLink {
  return { paper: s2Paper(s2Id, title), isInfluential, intents: isInfluential ? ["methodology"] : [] };
}

describe("citations", () => {
  function seedCitationPool(searchId: string) {
    const vec = toBuffer(fakeVector("sparse autoencoders"));
    for (const [i, pid] of ["seed1", "seed2", "other"].entries()) {
      seedPoolPaper(db, searchId, { id: pid, title: `Pool paper ${pid} about sparse autoencoders`, s2Id: `S2-${pid}` }, { rrf: 1 - i * 0.1 });
      db.update(papers).set({ embedding: vec }).where(eq(papers.id, pid)).run();
    }
  }

  it("is skipped at Quick depth", async () => {
    const id = seedSearch(db, { depth: "quick", queries });
    expect(await stagesFor(db).citations(makeCtx(db, id, "citations"))).toBe("skipped");
  });

  it("admits papers linked to >= 2 seeds or influentially, and stores edges only between known papers", async () => {
    const id = seedSearch(db, { queries, config: { citations: { hops: 1, seeds: 2, hop2Seeds: 0, maxAdmitted: 10, minSeedLinks: 2 } } });
    seedCitationPool(id);
    const s2References = vi.fn(async (seed: string) =>
      seed === "S2-seed1"
        ? [link("X-both", "Shared reference cited by both seeds"), link("X-once", "Reference cited once only"), link("S2-other", "Pool paper other")]
        : [link("X-both", "Shared reference cited by both seeds")],
    );
    const s2Citations = vi.fn(async (seed: string) => (seed === "S2-seed2" ? [link("X-infl", "Influential citing paper", true)] : []));
    const ctx = makeCtx(db, id, "citations");
    await stagesFor(db, { s2References, s2Citations }).citations(ctx);

    const origins = Object.fromEntries(pool(db, id).map((r) => [r.papers.s2Id, r.search_papers.origin]));
    expect(origins).toMatchObject({ "X-both": "citation", "X-infl": "citation" });
    expect(origins["X-once"]).toBeUndefined();
    expect(ctx.counters.citationAdmitted).toBe(2);
    expect(s2References).toHaveBeenCalledTimes(2);

    const edges = db.select().from(paperCitations).all();
    const byS2 = Object.fromEntries(db.select().from(papers).all().map((p) => [p.id, p.s2Id]));
    const pairs = edges.map((e) => `${byS2[e.citingId]}->${byS2[e.citedId]}`).sort();
    expect(pairs).toEqual(["S2-seed1->S2-other", "S2-seed1->X-both", "S2-seed2->X-both", "X-infl->S2-seed2"]);
    expect(edges.find((e) => byS2[e.citingId] === "X-infl")!.isInfluential).toBe(true);
    // New papers were embedded and preranked.
    const admitted = pool(db, id).filter((r) => r.search_papers.origin === "citation");
    expect(admitted.every((r) => r.papers.embedding && r.search_papers.rrf != null)).toBe(true);
  });

  it("respects maxAdmitted and resumes past finished hops", async () => {
    const id = seedSearch(db, { queries, config: { citations: { hops: 1, seeds: 2, hop2Seeds: 0, maxAdmitted: 1, minSeedLinks: 1 } } });
    seedCitationPool(id);
    const s2References = vi.fn(async () => [link("X1", "Candidate one paper title"), link("X2", "Candidate two paper title")]);
    const ctx = makeCtx(db, id, "citations");
    await stagesFor(db, { s2References }).citations(ctx);
    expect(pool(db, id).filter((r) => r.search_papers.origin === "citation")).toHaveLength(1);
    expect(ctx.checkpoint).toMatchObject({ hops: { "1": { done: true } } });

    s2References.mockClear();
    await stagesFor(db, { s2References }).citations(makeCtx(db, id, "citations"));
    expect(s2References).not.toHaveBeenCalled();
  });
});

describe("enrich", () => {
  it("updates metrics from S2, falls back to OpenAlex by DOI, and snapshots onto the pool", async () => {
    const id = seedSearch(db, { kind: "refresh", queries, baseSearchId: null });
    seedPoolPaper(db, id, { id: "p1", title: "Paper one on sparse autoencoders", arxivId: "2401.00001", citationCount: 3 }, { rrf: 0.5 });
    seedPoolPaper(db, id, { id: "p2", title: "Paper two on sparse autoencoders", doi: "10.1234/two" }, { rrf: 0.4 });
    const s2BatchPapers = vi.fn(async (...[ids]: [ids: string[], fields?: unknown, opts?: unknown]) =>
      ids.map((x) => (x === "ARXIV:2401.00001" ? s2Paper("S2P1", "Paper one on sparse autoencoders", { arxivId: "2401.00001", citationCount: 2, influentialCitationCount: 1 }) : null)),
    );
    const openAlexWorksByDoi = vi.fn(async () =>
      new Map([["10.1234/two", { title: "Paper two on sparse autoencoders", doi: "10.1234/two", openalexId: "W9", citationCount: 42, source: "openalex" as const }]]),
    );
    const ctx = makeCtx(db, id, "enrich");
    await stagesFor(db, { s2BatchPapers, openAlexWorksByDoi }).enrich(ctx);

    expect(s2BatchPapers.mock.calls[0][0]).toEqual(["ARXIV:2401.00001", "DOI:10.1234/two"]);
    expect(s2BatchPapers.mock.calls[0][2]).toMatchObject({ cache: { bypass: true } });
    const p1 = db.select().from(papers).where(eq(papers.id, "p1")).get()!;
    expect(p1.s2Id).toBe("S2P1");
    expect(p1.citationCount).toBe(2); // overwritten, not max'd
    expect(row(id, "p1").citationCount).toBe(2);
    expect(row(id, "p1").influentialCitationCount).toBe(1);
    expect(row(id, "p2").citationCount).toBe(42);
    expect(ctx.counters.enriched).toBe(2);
  });

  it("warns and continues when S2 fails", async () => {
    const id = seedSearch(db, { queries });
    seedPoolPaper(db, id, { id: "p1", title: "Paper one on sparse autoencoders", s2Id: "S1" }, { rrf: 0.5 });
    const ctx = makeCtx(db, id, "enrich");
    await stagesFor(db, { s2BatchPapers: async () => Promise.reject(new Error("429")) }).enrich(ctx);
    expect(ctx.warnings.some((w) => /metrics unavailable/.test(w))).toBe(true);
  });
});

describe("rerank", () => {
  function seedRerankPool(searchId: string, n: number) {
    for (let i = 0; i < n; i++) {
      seedPoolPaper(
        db,
        searchId,
        { id: `p${i}`, title: `Paper ${i} about sparse autoencoders`, citationCount: i * 10 },
        { rrf: 1 - i / 100, cosine: 1 - i / 10 },
      );
    }
  }

  it("scores the top-N with the cross-encoder and selects", async () => {
    const id = seedSearch(db, { queries, config: { rerankTopN: 5, selectCount: 3, foundationalReserve: 0 } });
    seedRerankPool(id, 6);
    // Reverse relevance: later papers score higher.
    const scorePairs = vi.fn(async (_q: string, docs: readonly string[]) => docs.map((d) => Number(d.match(/Paper (\d)/)![1]) / 10));
    const ctx = makeCtx(db, id, "rerank");
    await stagesFor(db, { scorePairs }).rerank(ctx);
    expect(scorePairs.mock.calls[0][0]).toBe("sparse autoencoders: interpretability of language models");
    const selected = pool(db, id)
      .filter((r) => r.search_papers.selected)
      .sort((a, b) => a.search_papers.finalRank! - b.search_papers.finalRank!)
      .map((r) => r.papers.id);
    expect(selected).toEqual(["p4", "p3", "p2"]);
    expect(row(id, "p5").rerank).toBeNull();
    expect(row(id, "p5").finalRank).toBeNull();
    expect(ctx.counters).toMatchObject({ reranked: 5, selected: 3 });
    expect(ctx.checkpoint).toMatchObject({ mode: "cross-encoder" });
  });

  it("falls back to cosine with a warning when the cross-encoder is unavailable", async () => {
    const id = seedSearch(db, { queries, config: { rerankTopN: 4, selectCount: 2, foundationalReserve: 0 } });
    seedRerankPool(id, 4);
    let calls = 0;
    const scorePairs = async (_q: string, docs: readonly string[]) => {
      if (calls++ > 0) throw new CrossEncoderUnavailable("model failed to load");
      return docs.map(() => 0.99);
    };
    const ctx = makeCtx(db, id, "rerank");
    await stagesFor(db, { scorePairs, rerankChunk: 2 }).rerank(ctx);
    expect(ctx.warnings[0]).toMatch(/cross-encoder unavailable/);
    expect(row(id, "p0").rerank).toBeCloseTo(cosineRelevance(1));
    expect(row(id, "p1").rerank).toBeCloseTo(cosineRelevance(0.9)); // overwritten: no mixed scales
    expect(ctx.checkpoint).toMatchObject({ mode: "cosine" });
  });

  it("resumes by scoring only rows without a rerank score", async () => {
    const id = seedSearch(db, { queries, config: { rerankTopN: 4, selectCount: 2, foundationalReserve: 0 } });
    seedRerankPool(id, 4);
    db.update(searchPapers).set({ rerank: 0.5 }).where(eq(searchPapers.paperId, "p0")).run();
    db.update(searchPapers).set({ rerank: 0.4 }).where(eq(searchPapers.paperId, "p1")).run();
    const scorePairs = vi.fn(async (_q: string, docs: readonly string[]) => docs.map(() => 0.1));
    await stagesFor(db, { scorePairs }).rerank(makeCtx(db, id, "rerank"));
    expect(scorePairs.mock.calls.flatMap((c) => c[1] as string[])).toHaveLength(2);
    expect(row(id, "p0").rerank).toBe(0.5);
  });

  it("stores calibrated relevance and lets a cited on-topic classic beat uncited near-ties", async () => {
    const id = seedSearch(db, { queries, config: { rerankTopN: 6, selectCount: 3, foundationalReserve: 1, frontierReserve: 0 } });
    // [id, logit, citations, year]
    const spec: [string, number, number, number][] = [
      ["n0", 9.6, 0, 2025],
      ["n1", 9.5, 1, 2025],
      ["n2", 9.4, 2, 2025],
      ["n3", 9.3, 0, 2025],
      ["classic", 8.3, 1500, 2023],
      ["offtopic", -3, 99_999, 2020],
    ];
    spec.forEach(([pid, , cites, year], i) =>
      seedPoolPaper(db, id, { id: pid, title: `Paper ${pid} about sparse autoencoders`, citationCount: cites, year }, { rrf: 1 - i / 100, cosine: 0.6 }),
    );
    const logit = new Map(spec.map(([pid, l]) => [pid, l]));
    const scorePairs = async (_q: string, docs: readonly string[]) => docs.map((d) => logit.get(d.match(/Paper (\S+)/)![1])!);
    const ctx = makeCtx(db, id, "rerank");
    await stagesFor(db, { scorePairs }).rerank(ctx);
    expect(row(id, "n0").rerank).toBeCloseTo(logitRelevance(9.6));
    expect(row(id, "n0").rerank! - row(id, "classic").rerank!).toBeGreaterThan(0.05);
    const foundational = pool(db, id).filter((r) => r.search_papers.foundational).map((r) => r.papers.id);
    expect(foundational).toEqual(["classic"]);
    expect(row(id, "classic").finalRank).toBe(1);
    expect(row(id, "offtopic").selected).toBe(false);
    expect(ctx.checkpoint).toMatchObject({ foundational: 1, frontier: 0 });
  });

  it("always scores canonical-recall admissions, even outside the prerank top-N", async () => {
    const id = seedSearch(db, { queries, config: { rerankTopN: 2, selectCount: 2, foundationalReserve: 0 } });
    seedRerankPool(id, 5);
    db.update(searchStages)
      .set({ checkpoint: { canonicalIds: ["p4"] } })
      .where(and(eq(searchStages.searchId, id), eq(searchStages.stage, "collect")))
      .run();
    const scorePairs = vi.fn(async (_q: string, docs: readonly string[]) => docs.map((d) => (d.includes("Paper 4") ? 9 : 1)));
    await stagesFor(db, { scorePairs }).rerank(makeCtx(db, id, "rerank"));
    expect(scorePairs.mock.calls.flatMap((c) => c[1] as string[])).toHaveLength(3);
    expect(row(id, "p4").rerank).toBeCloseTo(logitRelevance(9));
    expect(row(id, "p4").selected).toBe(true);
    expect(row(id, "p3").rerank).toBeNull();
  });

  it("refresh reuses base cross-encoder scores when the query hash matches", async () => {
    seedSearch(db, { id: "base", status: "done", queries, config: { rerankTopN: 3, selectCount: 2, foundationalReserve: 0 } });
    seedRerankPool("base", 3);
    const first = vi.fn(async (_q: string, docs: readonly string[]) => docs.map(() => 0.7));
    await stagesFor(db, { scorePairs: first }).rerank(makeCtx(db, "base", "rerank"));

    const id = seedSearch(db, { id: "r", kind: "refresh", baseSearchId: "base", queries, config: { rerankTopN: 3, selectCount: 2, foundationalReserve: 0 } });
    for (let i = 0; i < 3; i++) db.insert(searchPapers).values({ searchId: id, paperId: `p${i}`, origin: "carryover", rrf: 1 - i / 100, cosine: 0.2 }).run();
    const second = vi.fn(async (_q: string, docs: readonly string[]) => docs.map(() => 0.1));
    await stagesFor(db, { scorePairs: second }).rerank(makeCtx(db, id, "rerank"));
    expect(second).not.toHaveBeenCalled();
    expect(row(id, "p1").rerank).toBeCloseTo(logitRelevance(0.7));
  });
});
