import { and, asc, count, eq, inArray } from "drizzle-orm";
import { searchPapers } from "@/lib/db/schema";
import { upsertPapers } from "@/lib/landscape/papers/repo";
import type { ArxivWarning } from "@/lib/landscape/sources/arxiv";
import type { ExpandedQuery, PaperInput } from "@/lib/landscape/types";
import {
  chunks,
  errMessage,
  loadSearch,
  mergeUnique,
  rethrowIfCancelled,
  tx,
  warn,
  yieldNow,
  type Env,
} from "./shared";

type Hit = { input: PaperInput; rank: number; source: "arxiv" | "s2" | "openalex" };

/** A source that fails this many queries in a row (after its own retries) is skipped for the rest of the run. */
export const SOURCE_TRIP_AFTER = 2;

/** Run-local source health (not checkpointed: a resume gives every source a fresh chance). */
type SourceHealth = { consecutiveFailures: { arxiv: number; s2: number }; tripped: Set<"arxiv" | "s2"> };

type CollectCheckpoint = {
  doneQueries: number[];
  /** Per query index: unique paper ids in merged source order (for the round-robin cap). */
  lists: Record<string, string[]>;
  failures: { arxiv: number; s2: number; both: number };
  fetched: number;
};

function readCheckpoint(raw: Record<string, unknown> | null): CollectCheckpoint {
  const cp = (raw ?? {}) as Partial<CollectCheckpoint>;
  return {
    doneQueries: Array.isArray(cp.doneQueries) ? cp.doneQueries : [],
    lists: cp.lists && typeof cp.lists === "object" ? cp.lists : {},
    failures: { arxiv: 0, s2: 0, both: 0, ...(cp.failures ?? {}) },
    fetched: typeof cp.fetched === "number" ? cp.fetched : 0,
  };
}

function describeArxivWarning(w: ArxivWarning): string {
  switch (w.kind) {
    case "relaxed_retry":
      return `arXiv query found nothing; relaxed retry found ${w.relaxedResults}`;
    case "empty_after_retry":
      return `arXiv reported ${w.totalResults} results but returned none`;
    case "dropped_entries":
      return `arXiv returned ${w.count} unparseable entries`;
  }
}

/** Add `ids` (with best 0-based ranks) to the pool as query hits for `qi`. */
function recordHits(env: Env, qi: number, best: Map<string, number>): void {
  const { db, ctx } = env;
  const ids = [...best.keys()];
  for (const part of chunks(ids)) {
    tx(db, () => {
      const existing = new Map(
        db
          .select({ paperId: searchPapers.paperId, sourceRank: searchPapers.sourceRank, queryHits: searchPapers.queryHits, origin: searchPapers.origin })
          .from(searchPapers)
          .where(and(eq(searchPapers.searchId, ctx.searchId), inArray(searchPapers.paperId, part)))
          .all()
          .map((r) => [r.paperId, r]),
      );
      for (const paperId of part) {
        const rank = best.get(paperId)!;
        const prev = existing.get(paperId);
        if (!prev) {
          db.insert(searchPapers)
            .values({ searchId: ctx.searchId, paperId, origin: "query", sourceRank: rank, queryHits: [qi] })
            .run();
        } else {
          db.update(searchPapers)
            .set({
              origin: "query",
              sourceRank: prev.sourceRank == null ? rank : Math.min(prev.sourceRank, rank),
              queryHits: mergeUnique(prev.queryHits ?? [], [qi]),
            })
            .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.paperId, paperId)))
            .run();
        }
      }
    });
  }
}

function noteSource(ctx: Env["ctx"], health: SourceHealth, source: "arxiv" | "s2", failed: boolean): void {
  if (!failed) {
    health.consecutiveFailures[source] = 0;
    return;
  }
  health.consecutiveFailures[source] += 1;
  if (health.consecutiveFailures[source] >= SOURCE_TRIP_AFTER && !health.tripped.has(source)) {
    health.tripped.add(source);
    warn(ctx, `${source === "arxiv" ? "arXiv" : "Semantic Scholar"} failed ${SOURCE_TRIP_AFTER} queries in a row; skipping it for the remaining queries`);
  }
}

async function collectQuery(
  env: Env,
  qi: number,
  q: ExpandedQuery,
  since: string | null,
  cp: CollectCheckpoint,
  health: SourceHealth,
): Promise<void> {
  const { ctx, deps, db } = env;
  const { config } = ctx;
  const now = deps.now();
  const hits: Hit[] = [];
  let arxivFailed = false;
  let s2Failed = false;

  const useArxiv = config.arxivPerQuery > 0 && !health.tripped.has("arxiv");
  const useS2 = config.s2PerQuery > 0 && !health.tripped.has("s2");

  if (useArxiv) {
    try {
      const res = await deps.searchArxiv(q, {
        maxResults: config.arxivPerQuery,
        since: since ?? undefined,
        windowYears: since ? null : config.windowYears,
        categories: q.categories?.length ? q.categories : undefined,
        now,
        cache: { db },
        signal: ctx.signal,
        onWarning: (w) => ctx.log(`collect q${qi}: ${describeArxivWarning(w)}`),
      });
      res.forEach((p, i) => hits.push({ input: p, rank: Math.max(0, (p.rank ?? i + 1) - 1), source: "arxiv" }));
    } catch (err) {
      rethrowIfCancelled(ctx, err);
      arxivFailed = true;
      warn(ctx, `arXiv search failed for "${q.text}": ${errMessage(err)}`);
    }
    noteSource(ctx, health, "arxiv", arxivFailed);
  }
  ctx.throwIfCancelled();

  if (useS2) {
    try {
      const res = await deps.searchS2(q.text, {
        limit: config.s2PerQuery,
        since,
        yearRange: !since && config.windowYears ? { from: now.getUTCFullYear() - config.windowYears } : null,
        cache: { db },
        signal: ctx.signal,
      });
      res.forEach((p, i) => hits.push({ input: p, rank: i, source: "s2" }));
    } catch (err) {
      rethrowIfCancelled(ctx, err);
      s2Failed = true;
      warn(ctx, `Semantic Scholar search failed for "${q.text}": ${errMessage(err)}`);
    }
    noteSource(ctx, health, "s2", s2Failed);
  }
  ctx.throwIfCancelled();

  // Neither primary source answered (failed or tripped): fall back to OpenAlex keyword search.
  const arxivDown = config.arxivPerQuery > 0 && (arxivFailed || !useArxiv);
  const s2Down = config.s2PerQuery > 0 && (s2Failed || !useS2);
  const primaryDown =
    (config.arxivPerQuery === 0 || arxivDown) && (config.s2PerQuery === 0 || s2Down) && (arxivDown || s2Down);
  let openAlexOk = false;
  if (primaryDown) {
    try {
      const res = await deps.searchOpenAlex(q.text, {
        limit: Math.max(config.arxivPerQuery, config.s2PerQuery),
        since,
        cache: { db },
        signal: ctx.signal,
      });
      res.forEach((p, i) => hits.push({ input: p, rank: i, source: "openalex" }));
      openAlexOk = true;
      ctx.log(`collect q${qi}: arXiv and Semantic Scholar unavailable; used OpenAlex (${res.length} results)`);
    } catch (err) {
      rethrowIfCancelled(ctx, err);
      warn(ctx, `OpenAlex fallback search failed for "${q.text}": ${errMessage(err)}`);
    }
    ctx.throwIfCancelled();
  }

  // Interleave the two sources by rank (arXiv first on ties).
  hits.sort((a, b) => a.rank - b.rank || (a.source === b.source ? 0 : a.source === "arxiv" ? -1 : 1));
  const ids = upsertPapers(db, hits.map((h) => h.input));
  const best = new Map<string, number>();
  ids.forEach((id, i) => {
    const r = hits[i].rank;
    if (!best.has(id) || r < best.get(id)!) best.set(id, r);
  });
  const order: string[] = [];
  for (const id of ids) if (!order.includes(id)) order.push(id);
  recordHits(env, qi, best);

  const enabledArxiv = config.arxivPerQuery > 0;
  const enabledS2 = config.s2PerQuery > 0;
  cp.failures.arxiv += arxivDown ? 1 : 0;
  cp.failures.s2 += s2Down ? 1 : 0;
  if ((arxivDown || !enabledArxiv) && (s2Down || !enabledS2) && !openAlexOk) cp.failures.both += 1;
  cp.fetched += hits.length;
  cp.lists[String(qi)] = order;
  cp.doneQueries = mergeUnique(cp.doneQueries, [qi]);
  ctx.saveCheckpoint({ ...cp });
}

function poolCount(env: Env): number {
  return (
    env.db
      .select({ n: count() })
      .from(searchPapers)
      .where(eq(searchPapers.searchId, env.ctx.searchId))
      .get()?.n ?? 0
  );
}

/** Keep at most `poolCap` query-origin candidates, taking each query's next best in turn. */
async function applyPoolCap(env: Env, cp: CollectCheckpoint, queryCount: number): Promise<void> {
  const { db, ctx } = env;
  const rows = db
    .select({ paperId: searchPapers.paperId })
    .from(searchPapers)
    .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.origin, "query")))
    .orderBy(asc(searchPapers.sourceRank))
    .all();
  const cap = ctx.config.poolCap;
  if (rows.length <= cap) return;

  const present = new Set(rows.map((r) => r.paperId));
  const keep = new Set<string>();
  const lists = Array.from({ length: queryCount }, (_, qi) => (cp.lists[String(qi)] ?? []).filter((id) => present.has(id)));
  const cursor = lists.map(() => 0);
  let progressed = true;
  while (keep.size < cap && progressed) {
    progressed = false;
    for (let qi = 0; qi < lists.length && keep.size < cap; qi++) {
      const list = lists[qi];
      while (cursor[qi] < list.length && keep.has(list[cursor[qi]])) cursor[qi]++;
      if (cursor[qi] < list.length) {
        keep.add(list[cursor[qi]++]);
        progressed = true;
      }
    }
  }
  // Rows not in any recorded list (e.g. merged into a new keeper id) fill leftover room by source rank.
  for (const r of rows) {
    if (keep.size >= cap) break;
    keep.add(r.paperId);
  }
  const drop = rows.map((r) => r.paperId).filter((id) => !keep.has(id));
  for (const part of chunks(drop)) {
    db.delete(searchPapers)
      .where(and(eq(searchPapers.searchId, ctx.searchId), inArray(searchPapers.paperId, part)))
      .run();
    await yieldNow();
  }
}

/** Refresh: the base search's selection stays in the pool (origin carryover). */
function carryOver(env: Env): void {
  const { db, ctx } = env;
  if (ctx.kind !== "refresh" || !ctx.baseSearchId) return;
  const base = db
    .select({ paperId: searchPapers.paperId })
    .from(searchPapers)
    .where(and(eq(searchPapers.searchId, ctx.baseSearchId), eq(searchPapers.selected, true)))
    .all();
  for (const part of chunks(base)) {
    tx(db, () => {
      for (const r of part) {
        db.insert(searchPapers)
          .values({ searchId: ctx.searchId, paperId: r.paperId, origin: "carryover" })
          .onConflictDoNothing()
          .run();
      }
    });
  }
}

/** Stage 3: arXiv + S2 search per query -> papers -> search_papers. */
export async function collectStage(env: Env): Promise<void> {
  const { ctx, db } = env;
  const search = loadSearch(db, ctx.searchId);
  const queries = search.queries;
  if (!queries.length) throw new Error("collect: search has no queries");
  // plan resolves `since` (refresh: base start minus overlap; otherwise the publication window).
  const since = search.since ?? null;
  const cp = readCheckpoint(ctx.checkpoint);
  const done = new Set(cp.doneQueries);
  const health: SourceHealth = { consecutiveFailures: { arxiv: 0, s2: 0 }, tripped: new Set() };

  for (let qi = 0; qi < queries.length; qi++) {
    ctx.throwIfCancelled();
    if (!done.has(qi)) {
      await collectQuery(env, qi, queries[qi], since, cp, health);
      ctx.updateCounters({ fetched: cp.fetched, candidates: poolCount(env) });
    }
    ctx.setStageProgress((qi + 1) / (queries.length + 1));
    await yieldNow();
  }

  const n = queries.length;
  if (cp.failures.both >= n) throw new Error("collect: every source failed for every query");
  if (ctx.config.arxivPerQuery > 0 && cp.failures.arxiv >= n) warn(ctx, "arXiv failed for every query; results come from the other sources only");
  if (ctx.config.s2PerQuery > 0 && cp.failures.s2 >= n) warn(ctx, "Semantic Scholar failed for every query; results come from the other sources only");

  await applyPoolCap(env, cp, n);
  carryOver(env);
  ctx.updateCounters({ queries: n, fetched: cp.fetched, candidates: poolCount(env) });
  ctx.setStageProgress(1);
}
