/*
 * Stage 9 (graph): author h-index, velocity, PageRank, influence, game-changer
 * candidates and landscape edges. Metrics are snapshotted into search_papers.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { paperCitations, papers, searchEdges, searchPapers } from "@/lib/db/schema";
import { fromBuffer } from "@/lib/embedding";
import { buildEdges, type CitationLink } from "@/lib/landscape/graph/edges";
import { gameChangerCandidates, influenceScores, velocity } from "@/lib/landscape/graph/metrics";
import { pagerank } from "@/lib/landscape/graph/pagerank";
import { normalizeOpenAlexAuthorId } from "@/lib/landscape/sources/openalex";
import type { PaperAuthor, StageContext } from "@/lib/landscape/types";
import {
  chunkedWrite,
  chunks,
  errorMessage,
  loadPool,
  rethrowIfAborted,
  resolveDb,
  warn,
  yieldLoop,
  type PoolPaper,
  type StructureDeps,
} from "./shared";

const IN_CHUNK = 500;

/** Publication date for velocity: the exact date, else mid-year. */
function pubDate(p: PoolPaper["paper"]): string | null {
  if (p.publishedAt && !Number.isNaN(Date.parse(p.publishedAt))) return p.publishedAt;
  return p.year != null ? `${p.year}-07-01` : null;
}

/** Citation links whose both ends are in `ids`. */
export function loadLocalCitations(db: Db, ids: readonly string[]): CitationLink[] {
  const inSet = new Set(ids);
  const out: CitationLink[] = [];
  for (const group of chunks([...inSet], IN_CHUNK)) {
    const rows = db
      .select({ citing: paperCitations.citingId, cited: paperCitations.citedId, isInfluential: paperCitations.isInfluential })
      .from(paperCitations)
      .where(inArray(paperCitations.citingId, group))
      .all();
    for (const r of rows) if (inSet.has(r.cited)) out.push(r);
  }
  return out.sort((a, b) => (a.citing + a.cited < b.citing + b.cited ? -1 : 1));
}

/**
 * Refresh author h-indexes for the selection: S2 author batch first, OpenAlex for
 * authors S2 didn't cover. Writes papers.authors + max_author_h_index. Failures
 * are warnings: the stage continues with whatever h-indexes are already stored.
 */
async function refreshAuthorHIndex(db: Db, ctx: StageContext, deps: StructureDeps, selected: PoolPaper[]): Promise<void> {
  const s2Ids = new Set<string>();
  const oaIds = new Set<string>();
  for (const p of selected) {
    for (const a of p.paper.authors ?? []) {
      if (a.s2Id) s2Ids.add(a.s2Id);
      else if (a.openalexId) oaIds.add(a.openalexId);
    }
  }

  let s2: Map<string, number | null> = new Map();
  if (s2Ids.size) {
    try {
      const res = await deps.batchAuthors([...s2Ids].sort(), { cache: { db }, signal: ctx.signal });
      s2 = new Map([...res].map(([id, m]) => [id, m.hIndex]));
    } catch (err) {
      rethrowIfAborted(ctx, err);
      warn(ctx, `graph: Semantic Scholar author batch failed, falling back to OpenAlex: ${errorMessage(err)}`);
    }
  }
  ctx.throwIfCancelled();

  // Authors S2 didn't resolve but OpenAlex can.
  for (const p of selected) {
    for (const a of p.paper.authors ?? []) {
      if (a.openalexId && (!a.s2Id || s2.get(a.s2Id) == null)) oaIds.add(a.openalexId);
    }
  }
  let oa: Map<string, number> = new Map();
  if (oaIds.size) {
    try {
      oa = await deps.authorHIndex([...oaIds].sort(), { cache: { db }, signal: ctx.signal });
    } catch (err) {
      rethrowIfAborted(ctx, err);
      warn(ctx, `graph: OpenAlex author h-index lookup failed: ${errorMessage(err)}`);
    }
  }
  if (!s2.size && !oa.size) return;

  const updates: { id: string; authors: PaperAuthor[]; max: number | null }[] = [];
  for (const p of selected) {
    let changed = false;
    const authors = (p.paper.authors ?? []).map((a) => {
      const fromS2 = a.s2Id ? s2.get(a.s2Id) : null;
      const oaKey = normalizeOpenAlexAuthorId(a.openalexId);
      const h = fromS2 ?? (oaKey ? oa.get(oaKey) : undefined) ?? null;
      if (h == null || h === a.hIndex) return a;
      changed = true;
      return { ...a, hIndex: h };
    });
    const hs = authors.map((a) => a.hIndex).filter((h): h is number => h != null && Number.isFinite(h));
    const max = hs.length ? Math.max(...hs) : null;
    if (!changed && max === p.paper.maxAuthorHIndex) continue;
    p.paper.authors = authors;
    if (max != null) p.paper.maxAuthorHIndex = max;
    updates.push({ id: p.paperId, authors, max });
  }
  await chunkedWrite(
    db,
    updates,
    (u) => {
      db.update(papers)
        .set({ authors: u.authors, ...(u.max != null ? { maxAuthorHIndex: u.max } : {}), updatedAt: new Date().toISOString() })
        .where(eq(papers.id, u.id))
        .run();
    },
    ctx,
  );
}

export async function graphStage(ctx: StageContext, deps: StructureDeps): Promise<void | "skipped"> {
  const db = await resolveDb(ctx, deps);
  const pool = loadPool(db, ctx.searchId, { selectedOnly: false });
  if (pool.length === 0) {
    ctx.log("graph: empty candidate pool");
    return "skipped";
  }
  const selected = pool.filter((p) => p.selected);
  ctx.setStageProgress(0.05);

  await refreshAuthorHIndex(db, ctx, deps, selected);
  ctx.throwIfCancelled();
  ctx.setStageProgress(0.5);

  // PageRank over local citations among the whole pool, max-normalized to 0..1.
  const ids = pool.map((p) => p.paperId);
  const citations = loadLocalCitations(db, ids);
  await yieldLoop();
  const pr = pagerank(
    ids,
    citations.map((c) => ({ source: c.citing, target: c.cited })),
  );
  const prMax = Math.max(0, ...pr.values());
  // Without citation edges PageRank is uniform (every paper 1.0 after normalization), which
  // reads as a real signal downstream. Store null instead: "no citation graph".
  const hasGraph = citations.length > 0;
  const prNorm = new Map([...pr].map(([id, v]) => [id, hasGraph && prMax > 0 ? v / prMax : null]));
  ctx.throwIfCancelled();
  await yieldLoop();

  const now = deps.now();
  const metrics = pool.map((p) => {
    const citationCount = p.paper.citationCount ?? p.spCitationCount;
    return {
      id: p.paperId,
      citationCount,
      influentialCitationCount: p.paper.influentialCitationCount ?? p.spInfluential,
      maxAuthorHIndex: p.paper.maxAuthorHIndex ?? p.spMaxAuthorHIndex,
      velocity: velocity(citationCount, pubDate(p.paper), now),
      pagerank: prNorm.get(p.paperId) ?? null,
    };
  });
  const influence = influenceScores(metrics);
  const selectedIds = new Set(selected.map((p) => p.paperId));
  const gameChangers = new Set(gameChangerCandidates(metrics.filter((m) => selectedIds.has(m.id))));
  ctx.setStageProgress(0.7);

  await chunkedWrite(
    db,
    metrics,
    (m) => {
      db.update(searchPapers)
        .set({
          citationCount: m.citationCount,
          influentialCitationCount: m.influentialCitationCount,
          maxAuthorHIndex: m.maxAuthorHIndex,
          velocity: m.velocity,
          pagerank: m.pagerank,
          influence: influence.get(m.id) ?? 0,
          gameChanger: gameChangers.has(m.id),
        })
        .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.paperId, m.id)))
        .run();
    },
    ctx,
  );
  ctx.setStageProgress(0.85);

  // Edges among the selection (foundational papers are part of it).
  const embeddings = new Map<string, Float32Array>();
  for (const p of selected) {
    if (!p.paper.embedding) continue;
    try {
      embeddings.set(p.paperId, fromBuffer(p.paper.embedding));
    } catch {
      // Corrupt blob: no similarity edges for this paper.
    }
  }
  const selIds = selected.map((p) => p.paperId);
  const edges = buildEdges({
    selectedIds: selIds,
    foundationalIds: selected.filter((p) => p.foundational).map((p) => p.paperId),
    citations: citations.filter((c) => selectedIds.has(c.citing) && selectedIds.has(c.cited)),
    embeddings,
  });
  db.delete(searchEdges).where(eq(searchEdges.searchId, ctx.searchId)).run();
  await chunkedWrite(
    db,
    edges,
    (e) => {
      db.insert(searchEdges)
        .values({ searchId: ctx.searchId, sourceId: e.source, targetId: e.target, kind: e.kind, weight: e.weight })
        .onConflictDoNothing()
        .run();
    },
    ctx,
  );
  ctx.log(`graph: ${pool.length} papers, ${citations.length} local citations, ${edges.length} edges, ${gameChangers.size} game-changer candidates`);
  ctx.setStageProgress(1);
}
