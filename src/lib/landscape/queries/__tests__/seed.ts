import type { Db } from "@/lib/db/create";
import {
  entries,
  paperExtractions,
  papers,
  searchClusters,
  searchDocuments,
  searchEdges,
  searchPapers,
  searches,
  topics,
} from "@/lib/db/schema";
import { DEPTH_PRESETS, EXTRACTION_VERSION } from "@/lib/landscape/constants";

/*
 * A small seeded landscape shared by the read-model tests:
 *
 *   topic t1 / search s1 (running, stage extract)
 *   p1..p4 selected (ranks 1..4), p5 unselected candidate
 *   p1 logged in Logs (by arXiv URL); p1 has abstract + fulltext extractions
 *   p2 linked to an abstract extraction via search_papers.extraction_id
 *   clusters 0 (p1,p2) and 1 (p3,p4)
 *   edges p2->p1 cites, p3->p1 builds_on, p1<->p5 similar (p5 unselected)
 *   documents: clusters valid, narrative valid (game-changer p3), tensions invalid, gaps error
 */
export function seedLandscape(db: Db) {
  const now = "2026-09-01T10:00:00.000Z";
  db.insert(topics)
    .values({ id: "t1", slug: "sae", name: "SAEs", description: "sparse autoencoders", summary: "Card summary", createdAt: now, updatedAt: now })
    .run();
  db.insert(searches)
    .values({
      id: "s1",
      topicId: "t1",
      kind: "initial",
      depth: "quick",
      config: DEPTH_PRESETS.quick,
      queries: [{ text: "sae", arxiv: "abs:sae", categories: ["cs.LG"] }],
      status: "running",
      stage: "extract",
      progress: 0.6,
      costUsd: 0.05,
      createdAt: now,
      startedAt: now,
    })
    .run();

  const paper = (n: number, extra: Partial<typeof papers.$inferInsert> = {}) => ({
    id: `p${n}`,
    title: `Paper ${n}`,
    normTitle: `paper ${n}`,
    abstract: `Abstract of paper ${n}. It has two sentences.`,
    authors: [{ name: `Author ${n}`, hIndex: 10 + n }, { name: `Second ${n}` }],
    year: 2020 + n,
    publishedAt: `${2020 + n}-01-15`,
    arxivId: `2401.0000${n}`,
    arxivUrl: `https://arxiv.org/abs/2401.0000${n}`,
    citationCount: 100 * n,
    ...extra,
  });
  db.insert(papers).values([paper(1), paper(2), paper(3), paper(4, { abstract: null }), paper(5)]).run();

  db.insert(entries).values({ id: "entry-1", url: "https://arxiv.org/abs/2401.00001v2" }).run();

  db.insert(paperExtractions)
    .values([
      { id: "x1a", paperId: "p1", version: EXTRACTION_VERSION, source: "abstract", sourceHash: "h1", model: "haiku", problem: "pa", method: "ma", results: "ra", contribution: "Abstract contribution 1", createdAt: "2026-09-01T10:01:00.000Z" },
      { id: "x1f", paperId: "p1", version: EXTRACTION_VERSION, source: "fulltext", sourceHash: "h1f", model: "haiku", problem: "pf", method: "mf", results: "rf", contribution: "Fulltext contribution 1", limitations: "lim", datasets: ["d1"], benchmarks: ["b1"], createdAt: "2026-09-01T10:00:30.000Z" },
      { id: "x2", paperId: "p2", version: EXTRACTION_VERSION, source: "abstract", sourceHash: "h2", model: "haiku", problem: "p", method: "m", results: "r", contribution: "Contribution 2" },
    ])
    .run();

  const sp = (n: number, extra: Partial<typeof searchPapers.$inferInsert>) => ({
    searchId: "s1",
    paperId: `p${n}`,
    origin: "query" as const,
    cosine: 0.5,
    ...extra,
  });
  db.insert(searchPapers)
    .values([
      sp(1, { selected: true, finalRank: 1, rerank: 8, pagerank: 0.02, influence: 0.9, clusterIdx: 0, foundational: true, citationCount: 90, velocity: 20 }),
      sp(2, { selected: true, finalRank: 2, rerank: 4, pagerank: 0.01, influence: 0.5, clusterIdx: 0, extractionId: "x2" }),
      sp(3, { selected: true, finalRank: 3, rerank: 2, pagerank: 0.04, influence: 0.4, clusterIdx: 1, gameChanger: false }),
      sp(4, { selected: true, finalRank: 4, rerank: 0, pagerank: 0, influence: 0.1, clusterIdx: 1, gameChanger: true, origin: "citation" }),
      sp(5, { selected: false, rerank: -2, pagerank: 0.01 }),
    ])
    .run();

  db.insert(searchClusters)
    .values([
      { searchId: "s1", idx: 0, label: "heuristic zero", keyTerms: ["a", "b"], size: 2, yearMin: 2021, yearMax: 2022 },
      { searchId: "s1", idx: 1, label: "heuristic one", summary: "row summary", keyTerms: ["c"], size: 2, yearMin: 2023, yearMax: 2024 },
    ])
    .run();

  db.insert(searchEdges)
    .values([
      { searchId: "s1", sourceId: "p2", targetId: "p1", kind: "cites", weight: 1 },
      { searchId: "s1", sourceId: "p3", targetId: "p1", kind: "builds_on", weight: 0.8 },
      { searchId: "s1", sourceId: "p1", targetId: "p5", kind: "similar", weight: 0.7 },
    ])
    .run();

  db.insert(searchDocuments)
    .values([
      {
        searchId: "s1",
        kind: "clusters",
        data: {
          topicSummary: "Synthesized summary",
          clusters: [{ idx: 0, name: "Named zero", summary: "doc summary", keyIdeas: ["k"], representativePaperIds: ["p1"] }],
        },
      },
      {
        searchId: "s1",
        kind: "narrative",
        data: {
          eras: [],
          gameChangers: [{ paperId: "p3", why: "w", evidence: "e" }],
          frontier: { summary: "f", paperIds: [] },
          outlook: "o",
          whatChanged: null,
        },
      },
      { searchId: "s1", kind: "tensions", data: { tensions: "not an array" } },
      { searchId: "s1", kind: "gaps", status: "error", data: null, error: "boom" },
    ])
    .run();
}
