import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searchStages, searches } from "@/lib/db/schema";
import { STALE_HEARTBEAT_MS } from "../constants";
import { ACTIVE_SEARCH_STATUSES } from "../types";

export type MarkStaleOptions = {
  /** Whether this process has a job (running or waiting for a slot) for the search. */
  isRunning: (searchId: string) => boolean;
  /** A running search whose heartbeat is older than this is interrupted even if it has a job. */
  staleMs?: number;
  now?: number;
};

function parseTs(value: string | null): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Sweep queued/running searches that can no longer make progress to
 * `interrupted`: those with no job in this process, and running ones whose
 * heartbeat is stale. Their `running` stage rows go back to `pending` so a
 * resume re-runs them. Returns the swept ids.
 */
export function markStaleSearches(db: Db, { isRunning, staleMs = STALE_HEARTBEAT_MS, now = Date.now() }: MarkStaleOptions): string[] {
  const rows = db
    .select({
      id: searches.id,
      status: searches.status,
      heartbeatAt: searches.heartbeatAt,
      startedAt: searches.startedAt,
      createdAt: searches.createdAt,
    })
    .from(searches)
    .where(inArray(searches.status, [...ACTIVE_SEARCH_STATUSES]))
    .all();

  const stale = rows
    .filter((r) => {
      if (!isRunning(r.id)) return true;
      if (r.status !== "running") return false;
      const last = parseTs(r.heartbeatAt) ?? parseTs(r.startedAt) ?? parseTs(r.createdAt);
      return last === null || now - last > staleMs;
    })
    .map((r) => r.id);
  if (stale.length === 0) return [];

  const finishedAt = new Date(now).toISOString();
  db.transaction((tx) => {
    tx.update(searches)
      .set({ status: "interrupted", finishedAt })
      .where(and(inArray(searches.id, stale), inArray(searches.status, [...ACTIVE_SEARCH_STATUSES])))
      .run();
    tx.update(searchStages)
      .set({ status: "pending", finishedAt: null })
      .where(and(inArray(searchStages.searchId, stale), eq(searchStages.status, "running")))
      .run();
  });
  return stale;
}
