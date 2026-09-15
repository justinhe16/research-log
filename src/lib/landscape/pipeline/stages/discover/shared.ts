import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searchStages, searches, topics, type SearchRow, type TopicRow } from "@/lib/db/schema";
import { embedMany } from "@/lib/embedding";
import { DB_CHUNK_SIZE } from "@/lib/landscape/constants";
import { expandQueries } from "@/lib/landscape/llm/expand";
import { scorePairs } from "@/lib/landscape/rank/cross-encoder";
import { searchArxiv } from "@/lib/landscape/sources/arxiv";
import { worksByDoi } from "@/lib/landscape/sources/openalex";
import { batchPapers, citations, references, searchS2 } from "@/lib/landscape/sources/semantic-scholar";
import type { StageContext, StageName } from "@/lib/landscape/types";

/*
 * Shared plumbing for the discover/rank stages (plan .. rerank).
 *
 * Every external effect goes through `DiscoverDeps`, so tests inject fakes for
 * sources, the embedder and the cross-encoder. The DB handle is taken, in order,
 * from `deps.db`, the runner's context (`ctx.db`, which the runner's
 * PipelineContext carries even though the StageContext contract doesn't), or the
 * app database (lazy import, so importing this module never opens it).
 */

export interface DiscoverDeps {
  db?: Db;
  /** Clock for `since` / publication windows. */
  now: () => Date;
  expandQueries: typeof expandQueries;
  searchArxiv: typeof searchArxiv;
  searchS2: typeof searchS2;
  s2References: typeof references;
  s2Citations: typeof citations;
  s2BatchPapers: typeof batchPapers;
  openAlexWorksByDoi: typeof worksByDoi;
  embedMany: (texts: readonly string[]) => Promise<Float32Array[]>;
  scorePairs: (query: string, docs: readonly string[]) => Promise<number[]>;
  /** Max references and max citations fetched per seed. */
  citationLinkLimit: number;
  /** Texts per embedMany call (each call is followed by a DB write). */
  embedChunk: number;
  /** Pairs per scorePairs call (scores are persisted after each call). */
  rerankChunk: number;
}

export const defaultDiscoverDeps: DiscoverDeps = {
  now: () => new Date(),
  expandQueries,
  searchArxiv,
  searchS2,
  s2References: references,
  s2Citations: citations,
  s2BatchPapers: batchPapers,
  openAlexWorksByDoi: worksByDoi,
  embedMany: (texts) => embedMany(texts),
  scorePairs: (query, docs) => scorePairs(query, docs),
  citationLinkLimit: 200,
  embedChunk: 64,
  rerankChunk: 32,
};

/** Optional extras the runner's PipelineContext provides; used when present. */
type RunnerExtras = { db?: Db; warn?: (message: string) => void };

export type Env = { ctx: StageContext; deps: DiscoverDeps; db: Db };

export async function makeEnv(ctx: StageContext, deps: DiscoverDeps): Promise<Env> {
  const fromCtx = (ctx as StageContext & RunnerExtras).db;
  const db = deps.db ?? fromCtx ?? (await import("@/lib/db")).db;
  return { ctx, deps, db };
}

export function warn(ctx: StageContext, message: string): void {
  const w = (ctx as StageContext & RunnerExtras).warn;
  if (typeof w === "function") w.call(ctx, message);
  else ctx.log(`warning: ${message}`);
}

export function tx<T>(db: Db, fn: () => T): T {
  return db.$client.transaction(fn)();
}

export function yieldNow(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export function chunks<T>(xs: readonly T[], size: number = DB_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Write rows in transactions of at most DB_CHUNK_SIZE, yielding between chunks. */
export async function writeChunked<T>(db: Db, rows: readonly T[], write: (row: T) => void): Promise<void> {
  const parts = chunks(rows);
  for (let i = 0; i < parts.length; i++) {
    tx(db, () => {
      for (const r of parts[i]) write(r);
    });
    if (i < parts.length - 1) await yieldNow();
  }
}

export function loadSearch(db: Db, id: string): SearchRow {
  const row = db.select().from(searches).where(eq(searches.id, id)).get();
  if (!row) throw new Error(`search ${id} not found`);
  return row;
}

export function loadTopic(db: Db, id: string): TopicRow {
  const row = db.select().from(topics).where(eq(topics.id, id)).get();
  if (!row) throw new Error(`topic ${id} not found`);
  return row;
}

/** Another stage's persisted checkpoint (e.g. prerank reading expand's extras). */
export function readStageCheckpoint(db: Db, searchId: string, stage: StageName): Record<string, unknown> | null {
  const row = db
    .select({ checkpoint: searchStages.checkpoint })
    .from(searchStages)
    .where(and(eq(searchStages.searchId, searchId), eq(searchStages.stage, stage)))
    .get();
  return row?.checkpoint ?? null;
}

/** True when an error is (or was caused by) this search being cancelled. Re-throws
 *  the cancellation error from the context so the runner sees the right type. */
export function rethrowIfCancelled(ctx: StageContext, err: unknown): void {
  if (ctx.signal.aborted) {
    ctx.throwIfCancelled();
    throw err;
  }
  if (err instanceof Error && (err.name === "SearchCancelledError" || err.name === "AbortError")) throw err;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** S2 lookup id for a paper: S2 id, else "ARXIV:<id>", else "DOI:<doi>". */
export function s2LookupId(p: { s2Id: string | null; arxivId: string | null; doi: string | null }): string | null {
  if (p.s2Id) return p.s2Id;
  if (p.arxivId) return `ARXIV:${p.arxivId}`;
  if (p.doi) return `DOI:${p.doi}`;
  return null;
}

/** Text embedded into `papers.embedding` (title + abstract). */
export function paperEmbeddingText(p: { title: string; abstract: string | null }): string {
  return p.abstract ? `${p.title}. ${p.abstract}` : p.title;
}

/** "YYYY-MM-DD" of an ISO timestamp (or of `d`). */
export function isoDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

export function mergeUnique(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}
