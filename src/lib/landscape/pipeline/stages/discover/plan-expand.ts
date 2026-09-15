import { eq } from "drizzle-orm";
import { searches } from "@/lib/db/schema";
import { buildArxivQuery } from "@/lib/landscape/sources/arxiv";
import { DEPTHS, type DepthConfig, type ExpandedQuery } from "@/lib/landscape/types";
import { fallbackQueries, queryKey, type ExpansionResult } from "@/lib/landscape/llm/expand";
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

  const queries = fallback ? expansion.queries : buildQueryList(topic.name, expansion);
  db.update(searches).set({ queries }).where(eq(searches.id, ctx.searchId)).run();
  ctx.saveCheckpoint({
    done: true,
    fallback,
    extras: { categories: expansion.categories, mustTerms: expansion.mustTerms, excludeTerms: expansion.excludeTerms },
  });
  ctx.updateCounters({ queries: queries.length });
  ctx.setStageProgress(1);
}
