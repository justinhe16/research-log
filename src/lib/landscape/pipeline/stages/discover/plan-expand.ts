import { eq } from "drizzle-orm";
import { searches } from "@/lib/db/schema";
import { cosine } from "@/lib/embedding";
import { EXPAND_MAX_DROP_SHARE, EXPAND_MIN_COSINE } from "@/lib/landscape/constants";
import { buildArxivQuery } from "@/lib/landscape/sources/arxiv";
import { DEPTHS, type DepthConfig, type ExpandedQuery } from "@/lib/landscape/types";
import { fallbackQueries, queryKey, type ExpansionResult } from "@/lib/landscape/llm/expand";
import { topicEmbeddingText } from "@/lib/landscape/topic-dedupe";
import { cleanText } from "@/lib/sanitize";
import {
  errMessage,
  isoDate,
  loadSearch,
  loadTopic,
  readStageCheckpoint,
  rethrowIfCancelled,
  warn,
  type Env,
} from "./shared";

/** Expansion extras that don't fit `searches.queries`; kept on the expand checkpoint. */
export type ExpansionExtras = { categories: string[]; mustTerms: string[]; excludeTerms: string[] };

const EMPTY_EXTRAS: ExpansionExtras = { categories: [], mustTerms: [], excludeTerms: [] };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Extras for a search: its own expand checkpoint, else (refresh, where expand is
 * skipped) the nearest ancestor's. Walks at most 20 base links.
 */
export function loadExpansionExtras(env: Env, searchId: string): ExpansionExtras {
  let id: string | null = searchId;
  for (let i = 0; id && i < 20; i++) {
    const cp = readStageCheckpoint(env.db, id, "expand");
    if (cp && cp.extras && typeof cp.extras === "object") {
      const e = cp.extras as Record<string, unknown>;
      return { categories: strings(e.categories), mustTerms: strings(e.mustTerms), excludeTerms: strings(e.excludeTerms) };
    }
    const row = env.db.select({ base: searches.baseSearchId }).from(searches).where(eq(searches.id, id)).get();
    id = row?.base ?? null;
  }
  return EMPTY_EXTRAS;
}

function assertConfig(config: DepthConfig | null | undefined): asserts config is DepthConfig {
  const ok =
    !!config &&
    (DEPTHS as readonly string[]).includes(config.depth) &&
    config.poolCap > 0 &&
    config.arxivPerQuery >= 0 &&
    config.s2PerQuery >= 0 &&
    config.rerankTopN > 0 &&
    config.selectCount > 0 &&
    !!config.citations &&
    [0, 1, 2].includes(config.citations.hops);
  if (!ok) throw new Error("search config snapshot is missing or invalid");
}

/** Stage 1: validate the config snapshot and resolve `since` for refreshes. */
export async function planStage(env: Env): Promise<void> {
  const { ctx, db } = env;
  const search = loadSearch(db, ctx.searchId);
  assertConfig(search.config);
  loadTopic(db, ctx.topicId);

  let since = search.since;
  if (ctx.kind === "refresh") {
    if (!ctx.baseSearchId) throw new Error("refresh search has no base search");
    const base = loadSearch(db, ctx.baseSearchId);
    // createSearch normally sets this (with an overlap); only fill it if missing.
    if (!since) since = isoDate(base.startedAt ?? base.createdAt);
  } else if (!since && search.config.windowYears) {
    const d = new Date(env.deps.now().getTime());
    d.setUTCFullYear(d.getUTCFullYear() - search.config.windowYears);
    since = isoDate(d);
  }
  if (since !== search.since) {
    db.update(searches).set({ since }).where(eq(searches.id, ctx.searchId)).run();
  }
  if (search.queries.length) ctx.updateCounters({ queries: search.queries.length });
  ctx.setStageProgress(1);
}

/** Query 0 is always the topic name itself; expanded queries follow. */
export function buildQueryList(name: string, expansion: ExpansionResult): ExpandedQuery[] {
  const text = cleanText(name);
  const head: ExpandedQuery = { text, arxiv: buildArxivQuery({ text }), categories: expansion.categories };
  const seen = new Set([queryKey(text)]);
  const rest = expansion.queries.filter((q) => {
    const k = queryKey(q.text);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [head, ...rest];
}

/**
 * Indices (into `similarities`) of expanded queries to drop as off-topic drift: cosine to the
 * topic below `minCosine`, lowest first, at most `maxDropShare` of the queries. Pure.
 */
export function driftedQueries(
  similarities: readonly number[],
  minCosine: number = EXPAND_MIN_COSINE,
  maxDropShare: number = EXPAND_MAX_DROP_SHARE,
): number[] {
  const maxDrop = Math.floor(similarities.length * maxDropShare);
  return similarities
    .map((sim, i) => ({ sim, i }))
    .filter((x) => !(x.sim >= minCosine))
    .sort((a, b) => a.sim - b.sim || a.i - b.i)
    .slice(0, maxDrop)
    .map((x) => x.i)
    .sort((a, b) => a - b);
}

/** Drop drifted expanded queries (query 0, the topic name, always stays). Embedding failures keep everything. */
async function dropDriftedQueries(env: Env, name: string, description: string | null, queries: ExpandedQuery[]): Promise<ExpandedQuery[]> {
  const { ctx, deps } = env;
  if (queries.length <= 1) return queries;
  const expanded = queries.slice(1);
  let vectors: Float32Array[];
  try {
    vectors = await deps.embedMany([topicEmbeddingText(name, description), ...expanded.map((q) => q.text)]);
  } catch (err) {
    rethrowIfCancelled(ctx, err);
    warn(ctx, `query drift check skipped: ${errMessage(err)}`);
    return queries;
  }
  const [topicVec, ...queryVecs] = vectors;
  if (!topicVec || queryVecs.length !== expanded.length) return queries;
  const sims = queryVecs.map((v) => cosine(topicVec, v));
  const drop = new Set(driftedQueries(sims));
  for (const i of drop) {
    warn(ctx, `dropped off-topic expanded query "${expanded[i].text}" (similarity ${sims[i].toFixed(2)} to the topic)`);
  }
  if (drop.size) ctx.updateCounters({ queriesDropped: drop.size });
  return [queries[0], ...expanded.filter((_, i) => !drop.has(i))];
}

/** Stage 2: one Haiku call; fallback to the topic name. Skipped on refresh (base queries reused). */
export async function expandStage(env: Env): Promise<void | "skipped"> {
  const { ctx, db, deps } = env;
  const search = loadSearch(db, ctx.searchId);

  if (ctx.kind === "refresh") {
    if (!search.queries.length && ctx.baseSearchId) {
      const base = loadSearch(db, ctx.baseSearchId);
      db.update(searches).set({ queries: base.queries }).where(eq(searches.id, ctx.searchId)).run();
      ctx.updateCounters({ queries: base.queries.length });
    }
    return "skipped";
  }

  // Resume: a previous attempt already stored its queries.
  if (search.queries.length && ctx.checkpoint?.done === true) {
    ctx.updateCounters({ queries: search.queries.length });
    return;
  }

  const topic = loadTopic(db, ctx.topicId);
  ctx.throwIfCancelled();
  let expansion: ExpansionResult;
  let fallback = false;
  try {
    expansion = await deps.expandQueries(
      { name: topic.name, description: topic.description, count: ctx.config.expandedQueries, windowYears: ctx.config.windowYears },
      { recorder: ctx.recorder, signal: ctx.signal },
    );
  } catch (err) {
    rethrowIfCancelled(ctx, err);
    warn(ctx, `query expansion failed, searching the topic name only: ${errMessage(err)}`);
    expansion = fallbackQueries(topic.name);
    fallback = true;
  }

  const queries = fallback
    ? expansion.queries
    : await dropDriftedQueries(env, topic.name, topic.description, buildQueryList(topic.name, expansion));
  ctx.throwIfCancelled();
  db.update(searches).set({ queries }).where(eq(searches.id, ctx.searchId)).run();
  ctx.saveCheckpoint({
    done: true,
    fallback,
    extras: { categories: expansion.categories, mustTerms: expansion.mustTerms, excludeTerms: expansion.excludeTerms },
  });
  ctx.updateCounters({ queries: queries.length });
  ctx.setStageProgress(1);
}
