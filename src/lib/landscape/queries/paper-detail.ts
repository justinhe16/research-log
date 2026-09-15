import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import {
  paperExtractions,
  papers,
  searchClusters,
  searchEdges,
  searchPapers,
  type PaperExtractionRow,
} from "@/lib/db/schema";
import { loggedEntryIdFor, loggedIndex } from "../papers/logged";
import type { PaperDetail, PaperExtractionDTO, PaperRelation } from "../types";
import { currentExtractions, loadDocuments, refFor, scoreScales, tldrFor } from "./snapshot";

/*
 * `GET /papers/[paperId]?searchId=`: everything the paper sheet shows. Global
 * fields always; the `search` block only when `searchId` is given and the paper is
 * in that search's candidate pool.
 */

function toExtractionDTO(row: PaperExtractionRow): PaperExtractionDTO {
  return {
    source: row.source,
    model: row.model,
    problem: row.problem,
    method: row.method,
    results: row.results,
    contribution: row.contribution,
    limitations: row.limitations,
    datasets: row.datasets ?? [],
    benchmarks: row.benchmarks ?? [],
    createdAt: row.createdAt,
  };
}

export function getPaperDetail(db: Db, paperId: string, searchId?: string | null): PaperDetail | null {
  const p = db.select().from(papers).where(eq(papers.id, paperId)).get();
  if (!p) return null;

  const sp = searchId
    ? db
        .select()
        .from(searchPapers)
        .where(and(eq(searchPapers.searchId, searchId), eq(searchPapers.paperId, paperId)))
        .get()
    : undefined;

  // Extraction: current-version full text, else current-version abstract, else
  // whatever this search linked (possibly an older version).
  let extraction: PaperExtractionRow | null = currentExtractions(db, [paperId]).get(paperId) ?? null;
  if (!extraction && sp?.extractionId) {
    extraction = db.select().from(paperExtractions).where(eq(paperExtractions.id, sp.extractionId)).get() ?? null;
  }

  const scales = sp && searchId ? scoreScales(db, searchId) : null;
  let search: PaperDetail["search"] = null;
  if (sp && searchId && scales) {
    const cluster =
      sp.clusterIdx != null
        ? db
            .select({ label: searchClusters.label })
            .from(searchClusters)
            .where(and(eq(searchClusters.searchId, searchId), eq(searchClusters.idx, sp.clusterIdx)))
            .get()
        : undefined;
    const { documents } = loadDocuments(db, searchId);
    const docName = documents.clusters?.clusters.find((c) => c.idx === sp.clusterIdx)?.name?.trim();
    const gameChanger = documents.narrative
      ? documents.narrative.gameChangers.some((g) => g.paperId === paperId)
      : sp.gameChanger;

    search = {
      searchId,
      ref: refFor(sp.finalRank),
      rank: sp.finalRank,
      selected: sp.selected,
      relevance: scales.relevance(sp.rerank, sp.cosine),
      influence: Math.max(0, Math.min(1, sp.influence ?? 0)),
      clusterIdx: sp.clusterIdx,
      clusterLabel: docName || cluster?.label || null,
      origin: sp.origin,
      foundational: sp.foundational,
      gameChanger,
      relations: relationsFor(db, searchId, paperId),
    };
  }

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
    citationCount: sp?.citationCount ?? p.citationCount,
    influentialCitationCount: sp?.influentialCitationCount ?? p.influentialCitationCount,
    velocity: sp?.velocity ?? null,
    pagerank: sp && scales ? scales.pagerank(sp.pagerank) : null,
    maxAuthorHIndex: sp?.maxAuthorHIndex ?? p.maxAuthorHIndex,
    loggedEntryId: loggedEntryIdFor(loggedIndex(db), p),
    hasExtraction: extraction != null,
    tldr: tldrFor(extraction?.contribution, p.abstract),
    abstract: p.abstract,
    authorsDetailed: p.authors ?? [],
    extraction: extraction ? toExtractionDTO(extraction) : null,
    search,
  };
}

/** Edges touching `paperId` whose other endpoint is selected in the search. Sorted
 *  by kind (cites, builds_on, similar), then weight desc, then rank. */
function relationsFor(db: Db, searchId: string, paperId: string): PaperRelation[] {
  const edges = db
    .select()
    .from(searchEdges)
    .where(and(eq(searchEdges.searchId, searchId), or(eq(searchEdges.sourceId, paperId), eq(searchEdges.targetId, paperId))))
    .all();
  const otherIds = [...new Set(edges.map((e) => (e.sourceId === paperId ? e.targetId : e.sourceId)))];
  if (otherIds.length === 0) return [];

  const others = new Map(
    db
      .select({
        id: papers.id,
        title: papers.title,
        year: papers.year,
        clusterIdx: searchPapers.clusterIdx,
        rank: searchPapers.finalRank,
      })
      .from(searchPapers)
      .innerJoin(papers, eq(papers.id, searchPapers.paperId))
      .where(
        and(eq(searchPapers.searchId, searchId), eq(searchPapers.selected, true), inArray(searchPapers.paperId, otherIds)),
      )
      .all()
      .map((o) => [o.id, o]),
  );

  const kindOrder = { cites: 0, builds_on: 1, similar: 2 } as const;
  const relations: PaperRelation[] = [];
  for (const e of edges) {
    if (e.sourceId === e.targetId) continue;
    const direction = e.sourceId === paperId ? "out" : "in";
    const other = others.get(direction === "out" ? e.targetId : e.sourceId);
    if (!other) continue;
    relations.push({
      paper: { id: other.id, title: other.title, year: other.year, clusterIdx: other.clusterIdx, rank: other.rank ?? 0 },
      kind: e.kind,
      direction,
      weight: e.weight,
    });
  }
  return relations.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] ||
      b.weight - a.weight ||
      a.paper.rank - b.paper.rank ||
      a.paper.id.localeCompare(b.paper.id),
  );
}
