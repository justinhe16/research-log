import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "@/lib/db/create";
import { searchPapers, searches, type SearchRow } from "@/lib/db/schema";
import { ACTIVE_SEARCH_STATUSES, DEPTHS, type Depth, type SearchSummary } from "../types";

/*
 * Search read models: history lists and "which search should the topic page show".
 * The single SearchSummary mapping; topic-repo.ts and pipeline/progress.ts import it.
 */

/** Timestamp sort key tolerant of SQLite's "YYYY-MM-DD HH:MM:SS" default format. */
export function isoKey(...cols: SQLiteColumn[]) {
  return sql`replace(coalesce(${sql.join(cols, sql`, `)}, ''), ' ', 'T')`;
}

export function toDepth(value: string): Depth {
  return (DEPTHS as readonly string[]).includes(value) ? (value as Depth) : "standard";
}

const selectedCount = sql<number>`(
  select count(*) from ${searchPapers}
  where ${searchPapers.searchId} = ${searches.id} and ${searchPapers.selected} = 1
)`.mapWith(Number);

export const summaryColumns = {
  id: searches.id,
  topicId: searches.topicId,
  kind: searches.kind,
  depth: searches.depth,
  status: searches.status,
  stage: searches.stage,
  progress: searches.progress,
  costUsd: searches.costUsd,
  createdAt: searches.createdAt,
  startedAt: searches.startedAt,
  finishedAt: searches.finishedAt,
  paperCount: selectedCount,
};

export type SummaryRow = Pick<
  SearchRow,
  "id" | "topicId" | "kind" | "depth" | "status" | "stage" | "progress" | "costUsd" | "createdAt" | "startedAt" | "finishedAt"
> & { paperCount: number };

export function toSearchSummary(r: SummaryRow): SearchSummary {
  return {
    id: r.id,
    topicId: r.topicId,
    kind: r.kind,
    depth: toDepth(r.depth),
    status: r.status,
    stage: r.stage ?? null,
    progress: r.progress,
    paperCount: r.paperCount ?? 0,
    costUsd: r.costUsd,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

/** Every search of a topic, newest first. */
export function listSearchesForTopic(db: Db, topicId: string): SearchSummary[] {
  return db
    .select(summaryColumns)
    .from(searches)
    .where(eq(searches.topicId, topicId))
    .orderBy(desc(isoKey(searches.createdAt)), desc(searches.id))
    .all()
    .map(toSearchSummary);
}

export function getSearchSummary(db: Db, searchId: string): SearchSummary | null {
  const row = db.select(summaryColumns).from(searches).where(eq(searches.id, searchId)).get();
  return row ? toSearchSummary(row) : null;
}

/** The most recently finished `done` search of a topic, or null. */
export function getLatestDoneSearchId(db: Db, topicId: string): string | null {
  const row = db
    .select({ id: searches.id })
    .from(searches)
    .where(and(eq(searches.topicId, topicId), eq(searches.status, "done")))
    .orderBy(desc(isoKey(searches.finishedAt, searches.createdAt)), desc(isoKey(searches.createdAt)))
    .get();
  return row?.id ?? null;
}

/** The queued/running search of a topic (at most one, by the partial unique index). */
export function getActiveSearchId(db: Db, topicId: string): string | null {
  const row = db
    .select({ id: searches.id })
    .from(searches)
    .where(and(eq(searches.topicId, topicId), inArray(searches.status, [...ACTIVE_SEARCH_STATUSES])))
    .get();
  return row?.id ?? null;
}
