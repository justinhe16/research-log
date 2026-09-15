import { and, asc, desc, eq, inArray, max, min, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import {
  paperExtractions,
  papers,
  searchClusters,
  searchDocuments,
  searchEdges,
  searchPapers,
  searches,
  topics,
  type PaperExtractionRow,
} from "@/lib/db/schema";
import { CLUSTER_COLORS, EXTRACTION_VERSION } from "../constants";
import { DOCUMENT_SCHEMAS } from "../llm/synthesize/schemas";
import { loggedEntryIdFor, loggedIndex } from "../papers/logged";
import {
  DOCUMENT_KINDS,
  type ClusterDTO,
  type DocumentKind,
  type EdgeDTO,
  type LandscapeDocuments,
  type LandscapeSnapshot,
  type PaperLite,
} from "../types";
import { getSearchSummary } from "./searches";

/*
 * `GET /searches/[id]/snapshot`: the read model the topic page renders. Works for
 * any search state -- a running search simply has fewer selected papers, no
 * clusters yet, or null documents. Stored documents are re-validated on read; one
 * that no longer parses is reported as failed rather than breaking the page.
 */

// ---------------------------------------------------------------------------
// Shared helpers (also used by paper-detail.ts)
// ---------------------------------------------------------------------------

/** Dossier ref for a ranked paper. The synthesize stage assigns refs the same way. */
export function refFor(finalRank: number | null): string {
  return finalRank != null ? `P${finalRank}` : "";
}

const TLDR_MAX = 280;

/** Extraction contribution, else the head of the abstract (cut at a sentence when possible). */
export function tldrFor(contribution: string | null | undefined, abstract: string | null | undefined): string | null {
  const c = contribution?.trim();
  if (c) return c;
  const a = abstract?.replace(/\s+/g, " ").trim();
  if (!a) return null;
  if (a.length <= TLDR_MAX) return a;
  const head = a.slice(0, TLDR_MAX);
  const stop = head.lastIndexOf(". ");
  return stop > 80 ? head.slice(0, stop + 1) : `${head.replace(/\s+\S*$/, "")}…`;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

export type ScoreScales = {
  /** Raw rerank (else cosine) -> 0..1 within the search's candidate pool. */
  relevance(rerank: number | null, cosine: number | null): number;
  /** Raw pagerank -> 0..1 (divided by the pool max). */
  pagerank(value: number | null): number | null;
};

/** Min-max scales over the whole candidate pool, so a paper's normalized score
 *  does not depend on which subset is being rendered. */
export function scoreScales(db: Db, searchId: string): ScoreScales {
  const r = db
    .select({
      rerankMin: min(searchPapers.rerank),
      rerankMax: max(searchPapers.rerank),
      cosineMin: min(searchPapers.cosine),
      cosineMax: max(searchPapers.cosine),
      pagerankMax: max(searchPapers.pagerank),
    })
    .from(searchPapers)
    .where(eq(searchPapers.searchId, searchId))
    .get();

  const scale = (v: number, lo: number | null | undefined, hi: number | null | undefined) => {
    if (lo == null || hi == null) return clamp01(v);
    return hi > lo ? clamp01((v - lo) / (hi - lo)) : 1;
  };

  return {
    relevance(rerank, cosine) {
      if (rerank != null) return scale(rerank, r?.rerankMin, r?.rerankMax);
      if (cosine != null) return scale(cosine, r?.cosineMin, r?.cosineMax);
      return 0;
    },
    pagerank(value) {
      if (value == null) return null;
      const hi = r?.pagerankMax;
      return hi != null && hi > 0 ? clamp01(value / hi) : 0;
    },
  };
}

/** Best extraction per paper at the current EXTRACTION_VERSION: full text beats abstract, newest wins. */
export function currentExtractions(db: Db, paperIds: string[]): Map<string, PaperExtractionRow> {
  const out = new Map<string, PaperExtractionRow>();
  if (paperIds.length === 0) return out;
  const rows = db
    .select()
    .from(paperExtractions)
    .where(and(inArray(paperExtractions.paperId, paperIds), eq(paperExtractions.version, EXTRACTION_VERSION)))
    .orderBy(
      desc(sql`case when ${paperExtractions.source} = 'fulltext' then 1 else 0 end`),
      desc(sql`replace(${paperExtractions.createdAt}, ' ', 'T')`),
    )
    .all();
  for (const row of rows) if (!out.has(row.paperId)) out.set(row.paperId, row);
  return out;
}

export function clusterColor(idx: number): number {
  return (((idx % CLUSTER_COLORS) + CLUSTER_COLORS) % CLUSTER_COLORS) + 1;
}

const DOCUMENT_KEYS: Record<DocumentKind, keyof LandscapeDocuments> = {
  clusters: "clusters",
  tensions: "tensions",
  gaps: "gaps",
  narrative: "narrative",
  reading_path: "readingPath",
  diff: "diff",
};

/** Parse every stored document. Error rows and rows failing validation are failed. */
export function loadDocuments(db: Db, searchId: string): { documents: LandscapeDocuments; failed: DocumentKind[] } {
  const documents: LandscapeDocuments = {
    clusters: null,
    tensions: null,
    gaps: null,
    narrative: null,
    readingPath: null,
    diff: null,
  };
  const failed = new Set<DocumentKind>();
  const rows = db.select().from(searchDocuments).where(eq(searchDocuments.searchId, searchId)).all();
  for (const row of rows) {
    if (!(DOCUMENT_KINDS as readonly string[]).includes(row.kind)) continue;
    if (row.status === "error") {
      failed.add(row.kind);
      continue;
    }
    const parsed = DOCUMENT_SCHEMAS[row.kind].safeParse(row.data);
    if (parsed.success) {
      (documents as Record<string, unknown>)[DOCUMENT_KEYS[row.kind]] = parsed.data;
    } else {
      console.warn(`[landscape] invalid ${row.kind} document for search ${searchId}: ${parsed.error.message}`);
      failed.add(row.kind);
    }
  }
  return { documents, failed: DOCUMENT_KINDS.filter((k) => failed.has(k)) };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function getLandscapeSnapshot(db: Db, searchId: string): LandscapeSnapshot | null {
  const search = db.select().from(searches).where(eq(searches.id, searchId)).get();
  if (!search) return null;
  const topic = db.select().from(topics).where(eq(topics.id, search.topicId)).get();
  if (!topic) return null;
  const summary = getSearchSummary(db, searchId);
  if (!summary) return null;

  const { documents, failed } = loadDocuments(db, searchId);

  // --- papers -------------------------------------------------------------
  const rows = db
    .select({ sp: searchPapers, p: papers, linked: paperExtractions })
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .leftJoin(paperExtractions, eq(paperExtractions.id, searchPapers.extractionId))
    .where(and(eq(searchPapers.searchId, searchId), eq(searchPapers.selected, true)))
    .orderBy(sql`coalesce(${searchPapers.finalRank}, 1e9)`, asc(papers.title), asc(papers.id))
    .all();

  const scales = scoreScales(db, searchId);
  const current = currentExtractions(
    db,
    rows.filter((r) => !r.linked).map((r) => r.p.id),
  );
  const logged = loggedIndex(db);
  const narrativeGameChangers = documents.narrative
    ? new Set(documents.narrative.gameChangers.map((g) => g.paperId))
    : null;

  const paperList: PaperLite[] = rows.map(({ sp, p, linked }, i) => {
    const extraction = linked ?? current.get(p.id) ?? null;
    const rank = sp.finalRank ?? i + 1;
    return {
      id: p.id,
      title: p.title,
      authors: (p.authors ?? []).map((a) => a.name),
      year: p.year,
      publishedAt: p.publishedAt,
      venue: p.venue,
      arxivId: p.arxivId,
      doi: p.doi,
      arxivUrl: p.arxivUrl,
      pdfUrl: p.pdfUrl,
      ref: refFor(rank),
      rank,
      relevance: scales.relevance(sp.rerank, sp.cosine),
      influence: clamp01(sp.influence ?? 0),
      citationCount: sp.citationCount ?? p.citationCount,
      influentialCitationCount: sp.influentialCitationCount ?? p.influentialCitationCount,
      velocity: sp.velocity,
      pagerank: scales.pagerank(sp.pagerank),
      maxAuthorHIndex: sp.maxAuthorHIndex ?? p.maxAuthorHIndex,
      clusterIdx: sp.clusterIdx,
      origin: sp.origin,
      foundational: sp.foundational,
      // Synthesis picks the final game-changers from the graph stage's candidates;
      // until the narrative exists, show the candidates.
      gameChanger: narrativeGameChangers ? narrativeGameChangers.has(p.id) : sp.gameChanger,
      loggedEntryId: loggedEntryIdFor(logged, p),
      hasExtraction: extraction != null,
      tldr: tldrFor(extraction?.contribution, p.abstract),
    };
  });

  // --- clusters -----------------------------------------------------------
  const docClusters = new Map((documents.clusters?.clusters ?? []).map((c) => [c.idx, c]));
  const clusterRows = db
    .select()
    .from(searchClusters)
    .where(eq(searchClusters.searchId, searchId))
    .orderBy(asc(searchClusters.idx))
    .all();
  const clusters: ClusterDTO[] = clusterRows.map((c) => {
    const doc = docClusters.get(c.idx);
    return {
      idx: c.idx,
      label: doc?.name?.trim() || c.label,
      summary: doc?.summary?.trim() || c.summary || null,
      keyTerms: c.keyTerms ?? [],
      size: c.size,
      yearMin: c.yearMin,
      yearMax: c.yearMax,
      paperIds: paperList.filter((p) => p.clusterIdx === c.idx).map((p) => p.id),
      color: clusterColor(c.idx),
      baseClusterIdx: c.baseClusterIdx,
      change: c.change ?? null,
    };
  });

  // --- edges among selected papers ---------------------------------------
  const selectedIds = new Set(paperList.map((p) => p.id));
  const edges: EdgeDTO[] = db
    .select({
      source: searchEdges.sourceId,
      target: searchEdges.targetId,
      kind: searchEdges.kind,
      weight: searchEdges.weight,
    })
    .from(searchEdges)
    .where(eq(searchEdges.searchId, searchId))
    .all()
    .filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target));

  return {
    topic: {
      id: topic.id,
      slug: topic.slug,
      name: topic.name,
      description: topic.description,
      // This search's own synthesis beats the card field (which tracks the latest search).
      summary: documents.clusters?.topicSummary?.trim() || topic.summary || null,
    },
    search: {
      ...summary,
      queries: search.queries ?? [],
      since: search.since,
      baseSearchId: search.baseSearchId,
    },
    papers: paperList,
    clusters,
    edges,
    documents,
    failedDocuments: failed,
  };
}
