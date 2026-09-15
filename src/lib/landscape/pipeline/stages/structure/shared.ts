/*
 * Shared plumbing for the Structure / Read / Synthesize stages (9-15): the
 * injectable dependency bag, DB resolution, chunked writes and the selection
 * loader every stage starts from.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { papers, searchPapers, searches } from "@/lib/db/schema";
import { DB_CHUNK_SIZE } from "@/lib/landscape/constants";
import { extractFulltext, runExtractions } from "@/lib/landscape/llm/extract";
import { runSynthesis } from "@/lib/landscape/llm/synthesize";
import { authorHIndex, type OpenAlexRequestOptions } from "@/lib/landscape/sources/openalex";
import { extractPdfText, fetchPaperPdf } from "@/lib/landscape/sources/pdf";
import { batchAuthors, type S2AuthorMetrics, type S2RequestOptions } from "@/lib/landscape/sources/semantic-scholar";
import type { StageContext, StageName } from "@/lib/landscape/types";

export type StageFn = (ctx: StageContext) => Promise<void | "skipped">;
export type StageMap = Partial<Record<StageName, StageFn>>;

/** Everything with I/O or model cost, injectable for tests. */
export interface StructureDeps {
  /** Defaults to `ctx.db` when the runner provides one, else the app database. */
  db?: Db;
  now: () => Date;
  batchAuthors: (ids: string[], opts: S2RequestOptions) => Promise<Map<string, S2AuthorMetrics>>;
  authorHIndex: (ids: string[], opts: OpenAlexRequestOptions) => Promise<Map<string, number>>;
  fetchPaperPdf: typeof fetchPaperPdf;
  extractPdfText: typeof extractPdfText;
  runExtractions: typeof runExtractions;
  extractFulltext: typeof extractFulltext;
  runSynthesis: typeof runSynthesis;
}

export const defaultStructureDeps: StructureDeps = {
  now: () => new Date(),
  batchAuthors,
  authorHIndex,
  fetchPaperPdf,
  extractPdfText,
  runExtractions,
  extractFulltext,
  runSynthesis,
};

export async function resolveDb(ctx: StageContext, deps: StructureDeps): Promise<Db> {
  if (deps.db) return deps.db;
  const fromCtx = (ctx as StageContext & { db?: Db }).db;
  if (fromCtx) return fromCtx;
  const mod = await import("@/lib/db");
  return mod.db;
}

export const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Run `write` over `items` in DB_CHUNK_SIZE transactions, yielding between chunks. */
export async function chunkedWrite<T>(
  db: Db,
  items: readonly T[],
  write: (item: T) => void,
  ctx?: StageContext,
): Promise<void> {
  for (let i = 0; i < items.length; i += DB_CHUNK_SIZE) {
    ctx?.throwIfCancelled();
    const slice = items.slice(i, i + DB_CHUNK_SIZE);
    db.$client.transaction(() => {
      for (const item of slice) write(item);
    })();
    if (i + DB_CHUNK_SIZE < items.length) await yieldLoop();
  }
}

export function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rethrow when the failure is really a cancellation. */
export function rethrowIfAborted(ctx: StageContext, err: unknown): void {
  if (ctx.signal.aborted) throw err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "SearchCancelledError")) throw err;
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type PoolPaper = {
  paperId: string;
  selected: boolean;
  foundational: boolean;
  finalRank: number | null;
  clusterIdx: number | null;
  extractionId: string | null;
  spCitationCount: number | null;
  spInfluential: number | null;
  spMaxAuthorHIndex: number | null;
  paper: typeof papers.$inferSelect;
};

/** Candidate pool (or just the selection) with the joined paper rows, ordered by rank then id. */
export function loadPool(db: Db, searchId: string, { selectedOnly }: { selectedOnly: boolean }): PoolPaper[] {
  const where = selectedOnly
    ? and(eq(searchPapers.searchId, searchId), eq(searchPapers.selected, true))
    : eq(searchPapers.searchId, searchId);
  const rows = db
    .select({ sp: searchPapers, paper: papers })
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .where(where)
    .orderBy(asc(searchPapers.finalRank), asc(searchPapers.paperId))
    .all();
  const out = rows.map(({ sp, paper }) => ({
    paperId: sp.paperId,
    selected: sp.selected,
    foundational: sp.foundational,
    finalRank: sp.finalRank,
    clusterIdx: sp.clusterIdx,
    extractionId: sp.extractionId,
    spCitationCount: sp.citationCount,
    spInfluential: sp.influentialCitationCount,
    spMaxAuthorHIndex: sp.maxAuthorHIndex,
    paper,
  }));
  // SQLite sorts NULL first; put unranked candidates last.
  return out.sort(byRank);
}

export function byRank(a: { finalRank: number | null; paperId: string }, b: { finalRank: number | null; paperId: string }): number {
  const ra = a.finalRank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.finalRank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || cmpStr(a.paperId, b.paperId);
}

/**
 * Dossier refs: `P${final_rank}`, the same ref the snapshot read model exposes as
 * `PaperLite.ref`. selectPapers gives the selection contiguous ranks 1..N; papers
 * with a missing or duplicate rank (shouldn't happen) get fresh numbers after the max.
 */
export function assignRefs(selected: readonly { paperId: string; finalRank: number | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  const leftovers: string[] = [];
  for (const p of [...selected].sort(byRank)) {
    const r = p.finalRank;
    if (r != null && Number.isInteger(r) && r > 0 && !used.has(r)) {
      used.add(r);
      out.set(p.paperId, `P${r}`);
    } else leftovers.push(p.paperId);
  }
  let next = Math.max(0, ...used);
  for (const id of leftovers) out.set(id, `P${++next}`);
  return out;
}

/** Warnings go to `ctx.warn` when the runner provides it (PipelineContext), else the log. */
export function warn(ctx: StageContext, message: string): void {
  const w = (ctx as StageContext & { warn?: (m: string) => void }).warn;
  if (w) w(message);
  else ctx.log(message);
}

export function getSearchRow(db: Db, searchId: string) {
  return db.select().from(searches).where(eq(searches.id, searchId)).get() ?? null;
}
