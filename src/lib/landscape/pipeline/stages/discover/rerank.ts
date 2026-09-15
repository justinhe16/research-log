import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { papers, searchPapers } from "@/lib/db/schema";
import { CrossEncoderUnavailable, rerankModelId } from "@/lib/landscape/rank/cross-encoder";
import { selectPapers, type SelectRow } from "@/lib/landscape/rank/select";
import { chunks, errMessage, loadSearch, loadTopic, readStageCheckpoint, tx, warn, writeChunked, yieldNow, type Env } from "./shared";

/*
 * Stage 8 (rerank): cross-encoder over the prerank top-N, then selection.
 *
 * - Scores are persisted after every scorePairs call; a resumed run only scores
 *   rows whose rerank is still null.
 * - If the cross-encoder can't load or fails, every top-N row falls back to its
 *   prerank cosine (never a mix of the two scales) and a warning is raised.
 * - Refresh reuses the base search's cross-encoder scores for shared papers when
 *   the rerank query hash (topic text + queries + model) is unchanged.
 * - Influence is computed later (graph stage), so the foundational reserve uses a
 *   PROVISIONAL influence: the within-pool percentile of log1p(citation_count)
 *   (null when the count is unknown). The graph stage's real influence replaces
 *   it on search_papers.influence; selection is not revisited.
 */

type Mode = "cross-encoder" | "cosine";

export function rerankQueryText(name: string, description: string | null | undefined): string {
  const d = (description ?? "").trim();
  return d ? `${name}: ${d}` : name;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Midrank percentile (0..1) of log1p(citations) among rows with a known count. */
export function provisionalInfluence(counts: Map<string, number | null>): Map<string, number | null> {
  const known = [...counts.entries()].filter((e): e is [string, number] => e[1] != null);
  const sorted = known.map(([, c]) => Math.log1p(Math.max(0, c))).sort((a, b) => a - b);
  const out = new Map<string, number | null>();
  for (const [id, c] of counts) {
    if (c == null) {
      out.set(id, null);
      continue;
    }
    if (sorted.length === 1) {
      out.set(id, 1);
      continue;
    }
    const v = Math.log1p(Math.max(0, c));
    let lo = 0;
    while (lo < sorted.length && sorted[lo] < v) lo++;
    let hi = lo;
    while (hi < sorted.length && sorted[hi] === v) hi++;
    out.set(id, (lo + (hi - lo - 1) / 2) / (sorted.length - 1));
  }
  return out;
}

export async function rerankStage(env: Env): Promise<void> {
  const { ctx, db, deps } = env;
  const topic = loadTopic(db, ctx.topicId);
  const search = loadSearch(db, ctx.searchId);
  const query = rerankQueryText(topic.name, topic.description);
  const queryHash = hashOf({ query, queries: search.queries.map((q) => q.text), model: rerankModelId() });

  let mode: Mode = ctx.checkpoint?.mode === "cosine" ? "cosine" : "cross-encoder";
  ctx.saveCheckpoint({ mode, queryHash });

  const top = db
    .select({
      paperId: searchPapers.paperId,
      rerank: searchPapers.rerank,
      cosine: searchPapers.cosine,
      title: papers.title,
      abstract: papers.abstract,
    })
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .where(eq(searchPapers.searchId, ctx.searchId))
    .orderBy(desc(sql`coalesce(${searchPapers.rrf}, 0)`), searchPapers.paperId)
    .limit(ctx.config.rerankTopN)
    .all();
  const topIds = top.map((r) => r.paperId);
  const setRerank = (paperId: string, score: number) =>
    db.update(searchPapers)
      .set({ rerank: score })
      .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.paperId, paperId)))
      .run();

  // --- refresh: reuse base cross-encoder scores ---
  if (mode === "cross-encoder" && ctx.kind === "refresh" && ctx.baseSearchId && ctx.checkpoint?.reusedBase !== true) {
    const baseCp = readStageCheckpoint(db, ctx.baseSearchId, "rerank");
    if (baseCp?.mode === "cross-encoder" && baseCp.queryHash === queryHash) {
      const pending = new Set(top.filter((r) => r.rerank == null).map((r) => r.paperId));
      let reused = 0;
      for (const part of chunks([...pending], 500)) {
        const baseRows = db
          .select({ paperId: searchPapers.paperId, rerank: searchPapers.rerank })
          .from(searchPapers)
          .where(and(eq(searchPapers.searchId, ctx.baseSearchId), inArray(searchPapers.paperId, part), isNotNull(searchPapers.rerank)))
          .all();
        tx(db, () => {
          for (const b of baseRows) {
            setRerank(b.paperId, b.rerank!);
            const row = top.find((r) => r.paperId === b.paperId);
            if (row) row.rerank = b.rerank;
            reused++;
          }
        });
      }
      ctx.log(`rerank: reused ${reused} scores from the base search`);
    }
    ctx.saveCheckpoint({ reusedBase: true });
  }

  // --- cross-encoder ---
  if (mode === "cross-encoder") {
    const todo = top.filter((r) => r.rerank == null);
    let done = top.length - todo.length;
    try {
      for (const part of chunks(todo, deps.rerankChunk)) {
        ctx.throwIfCancelled();
        const docs = part.map((r) => (r.abstract ? `${r.title}. ${r.abstract}` : r.title));
        const scores = await deps.scorePairs(query, docs);
        if (scores.length !== part.length) throw new CrossEncoderUnavailable(`expected ${part.length} scores, got ${scores.length}`);
        tx(db, () => part.forEach((r, i) => setRerank(r.paperId, scores[i])));
        done += part.length;
        ctx.updateCounters({ reranked: done });
        ctx.setStageProgress((0.9 * done) / Math.max(1, top.length));
        await yieldNow();
      }
    } catch (err) {
      if (!(err instanceof CrossEncoderUnavailable)) throw err;
      warn(ctx, `cross-encoder unavailable, ranking by embedding similarity instead: ${errMessage(err)}`);
      mode = "cosine";
      ctx.saveCheckpoint({ mode });
    }
  }

  // --- cosine fallback: every top-N row, so scales never mix ---
  if (mode === "cosine") {
    await writeChunked(db, top, (r) => setRerank(r.paperId, r.cosine ?? 0));
  }
  ctx.updateCounters({ reranked: top.length });
  ctx.throwIfCancelled();

  // --- select ---
  const pool = db
    .select({
      paperId: searchPapers.paperId,
      rerank: searchPapers.rerank,
      rrf: searchPapers.rrf,
      citationCount: sql<number | null>`coalesce(${searchPapers.citationCount}, ${papers.citationCount})`,
    })
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .where(eq(searchPapers.searchId, ctx.searchId))
    .all();
  const topSet = new Set(topIds);
  const influence = provisionalInfluence(new Map(pool.map((r) => [r.paperId, r.citationCount])));
  const rows: SelectRow[] = pool.map((r) => ({
    paperId: r.paperId,
    // Only this run's top-N carry comparable scores.
    rerank: topSet.has(r.paperId) ? r.rerank : null,
    rrf: r.rrf ?? 0,
    influence: influence.get(r.paperId) ?? null,
  }));
  const result = selectPapers(rows, {
    selectCount: ctx.config.selectCount,
    foundationalReserve: ctx.config.foundationalReserve,
  });
  const selected = new Set(result.selected);
  const foundational = new Set(result.foundational);
  await writeChunked(db, pool, (r) => {
    db.update(searchPapers)
      .set({
        selected: selected.has(r.paperId),
        foundational: foundational.has(r.paperId),
        finalRank: selected.has(r.paperId) ? (result.finalRank.get(r.paperId) ?? null) : null,
      })
      .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.paperId, r.paperId)))
      .run();
  });
  ctx.updateCounters({ selected: selected.size });
  ctx.setStageProgress(1);
}
