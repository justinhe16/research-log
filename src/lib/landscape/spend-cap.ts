import { gte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searches } from "@/lib/db/schema";

/*
 * Soft spend cap: a ceiling on how many searches (initial, refresh or full) may be
 * created per rolling hour, so a runaway client or a stuck retry loop can't burn
 * through API credit. Resumes and document retries don't count; they reuse a row.
 */

export const DEFAULT_MAX_SEARCHES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

/** LANDSCAPE_MAX_SEARCHES_PER_HOUR, or the default when unset/invalid (read at call time). */
export function maxSearchesPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LANDSCAPE_MAX_SEARCHES_PER_HOUR?.trim();
  if (!raw) return DEFAULT_MAX_SEARCHES_PER_HOUR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_SEARCHES_PER_HOUR;
}

/** Searches created at or after `since`. Tolerates both ISO timestamps and SQLite's
 *  "YYYY-MM-DD HH:MM:SS" default by normalizing to ISO-like text before comparing. */
export function countSearchesSince(db: Db, since: Date): number {
  const row = db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(searches)
    .where(gte(sql`replace(${searches.createdAt}, ' ', 'T')`, since.toISOString().replace(/\.\d{3}Z$/, "")))
    .get();
  return row?.n ?? 0;
}

export type SpendCapResult = { ok: true } | { ok: false; error: string };

/** Whether one more search may be created now. */
export function checkSearchSpendCap(
  db: Db,
  { now = new Date(), max = maxSearchesPerHour() }: { now?: Date; max?: number } = {},
): SpendCapResult {
  const recent = countSearchesSince(db, new Date(now.getTime() - HOUR_MS));
  if (recent < max) return { ok: true };
  return {
    ok: false,
    error: `Search limit reached: ${max} searches in the last hour (LANDSCAPE_MAX_SEARCHES_PER_HOUR). Try again later.`,
  };
}
