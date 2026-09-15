import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searchStages, searches, topics, type SearchRow } from "@/lib/db/schema";
import { DEPTH_PRESETS, MAX_CONCURRENT_SEARCHES } from "../constants";
import {
  ACTIVE_SEARCH_STATUSES,
  RESUMABLE_SEARCH_STATUSES,
  STAGES,
  type Depth,
  type DocumentKind,
  type SearchKind,
  type SearchStatus,
  type StageName,
} from "../types";
import { refreshTopicDenormalized } from "../queries/topic-repo";
import { buildStageContext, isCancelledError, openSearchSession, overallProgress, type SearchSessionOptions } from "./context";
import { getStage, loadStages } from "./stage-registry";

/** Refresh collects papers published since the base search started, minus this overlap. */
export const REFRESH_OVERLAP_DAYS = 14;
/** Stages reset by `retryDocuments`. */
export const DOCUMENT_STAGES = ["diff", "synthesize", "finalize"] as const satisfies readonly StageName[];

const nowIso = () => new Date().toISOString();

async function defaultDb(db?: Db): Promise<Db> {
  if (db) return db;
  return (await import("@/lib/db")).db;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function isActiveConflict(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    typeof e?.code === "string" &&
    e.code.startsWith("SQLITE_CONSTRAINT") &&
    /searches\.topic_id|searches_one_active_per_topic/.test(e.message ?? "")
  );
}

function activeSearchId(db: Db, topicId: string): string | null {
  return (
    db
      .select({ id: searches.id })
      .from(searches)
      .where(and(eq(searches.topicId, topicId), inArray(searches.status, [...ACTIVE_SEARCH_STATUSES])))
      .get()?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// createSearch
// ---------------------------------------------------------------------------

export type CreateSearchInput = {
  topicId: string;
  kind: SearchKind;
  depth: Depth;
  /** Base for refresh/full. Defaults to the topic's latest done search (required for refresh). */
  baseSearchId?: string | null;
};

export type CreateSearchResult =
  | { ok: true; search: SearchRow }
  | { ok: false; reason: "topic_not_found" }
  | { ok: false; reason: "base_not_found" }
  | { ok: false; reason: "active_search"; activeSearchId: string | null };

/** YYYY-MM-DD of `iso` minus `days`. */
function sinceFrom(iso: string, days: number): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Insert a queued search plus one pending `search_stages` row per stage. The
 * config is a snapshot of DEPTH_PRESETS. A refresh copies the base's queries and
 * sets `since` to the base start minus REFRESH_OVERLAP_DAYS. Returns a typed
 * conflict when the topic already has a queued/running search.
 */
export function createSearch(db: Db, input: CreateSearchInput): CreateSearchResult {
  const topic = db.select({ id: topics.id }).from(topics).where(eq(topics.id, input.topicId)).get();
  if (!topic) return { ok: false, reason: "topic_not_found" };

  let base: SearchRow | null = null;
  if (input.baseSearchId) {
    base = db.select().from(searches).where(eq(searches.id, input.baseSearchId)).get() ?? null;
    if (!base || base.topicId !== input.topicId) return { ok: false, reason: "base_not_found" };
  } else if (input.kind !== "initial") {
    base =
      db
        .select()
        .from(searches)
        .where(and(eq(searches.topicId, input.topicId), eq(searches.status, "done")))
        .orderBy(desc(sql`replace(coalesce(${searches.finishedAt}, ${searches.createdAt}), ' ', 'T')`))
        .get() ?? null;
  }
  if (input.kind === "refresh" && !base) return { ok: false, reason: "base_not_found" };

  const existing = activeSearchId(db, input.topicId);
  if (existing) return { ok: false, reason: "active_search", activeSearchId: existing };

  const id = crypto.randomUUID();
  const created = nowIso();
  const since =
    input.kind === "refresh" && base ? sinceFrom(base.startedAt ?? base.createdAt, REFRESH_OVERLAP_DAYS) : null;

  try {
    const row = db.transaction((tx) => {
      const inserted = tx
        .insert(searches)
        .values({
          id,
          topicId: input.topicId,
          kind: input.kind,
          baseSearchId: base?.id ?? null,
          depth: input.depth,
          config: structuredClone(DEPTH_PRESETS[input.depth]),
          queries: input.kind === "refresh" && base ? base.queries : [],
          since,
          status: "queued",
          progress: 0,
          counters: {},
          createdAt: created,
        })
        .returning()
        .get();
      tx.insert(searchStages)
        .values(STAGES.map((stage) => ({ searchId: id, stage, status: "pending" as const })))
        .run();
      return inserted;
    });
    return { ok: true, search: row };
  } catch (err) {
    if (isActiveConflict(err)) {
      return { ok: false, reason: "active_search", activeSearchId: activeSearchId(db, input.topicId) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runSearch
// ---------------------------------------------------------------------------

export type RunSearchOptions = Pick<SearchSessionOptions, "hasS2Key" | "logger" | "timers">;

function setSearch(db: Db, id: string, patch: Partial<typeof searches.$inferInsert>) {
  db.update(searches).set(patch).where(eq(searches.id, id)).run();
}

function setStage(db: Db, id: string, stage: StageName, patch: Partial<typeof searchStages.$inferInsert>) {
  db.update(searchStages)
    .set(patch)
    .where(and(eq(searchStages.searchId, id), eq(searchStages.stage, stage)))
    .run();
}

/**
 * Run (or continue) a search to a terminal status. Never throws.
 *
 * Call this only through the job registry (`startSearch` / `resumeSearch` /
 * `retryDocuments`): calling it directly bypasses the concurrency cap and the
 * registry's `isSearchRunning`, so the stale sweep and `cancelSearch` would treat
 * the run as orphaned. Tests are the exception.
 * Stages whose
 * row is done/skipped are skipped; the rest run in STAGES order. A missing stage
 * row is created on demand. Uses whatever stages are registered — call
 * `loadStages()` first (the job registry does).
 */
export async function runSearch(db: Db, searchId: string, opts: RunSearchOptions = {}): Promise<SearchStatus | null> {
  let session: ReturnType<typeof openSearchSession> = null;
  try {
    session = openSearchSession(db, searchId, opts);
    if (!session) return null;
    const s = session.search;
    // Only queued (or a still-"running" row being picked back up) runs; terminal
    // statuses must go through resumeSearch / retryDocuments first.
    if (s.status !== "queued" && s.status !== "running") return s.status;

    const started = nowIso();
    if (s.cancelRequested) {
      setSearch(db, searchId, { status: "cancelled", finishedAt: started, heartbeatAt: started });
      return "cancelled";
    }
    setSearch(db, searchId, {
      status: "running",
      error: null,
      startedAt: s.startedAt ?? started,
      finishedAt: null,
      heartbeatAt: started,
    });

    const rows = new Map(
      db
        .select({ stage: searchStages.stage, status: searchStages.status })
        .from(searchStages)
        .where(eq(searchStages.searchId, searchId))
        .all()
        .map((r) => [r.stage, r.status]),
    );

    for (const stage of STAGES) {
      const status = rows.get(stage);
      if (status === "done" || status === "skipped") continue;
      if (status === undefined) {
        db.insert(searchStages).values({ searchId, stage, status: "pending" }).onConflictDoNothing().run();
      }

      session.currentStage = stage;
      if (session.pollCancel(true)) {
        return finishCancelled(db, searchId, stage);
      }

      const stageStart = nowIso();
      setStage(db, searchId, stage, { status: "running", error: null, startedAt: stageStart, finishedAt: null });
      setSearch(db, searchId, { stage, heartbeatAt: stageStart });
      session.writeProgress(overallProgress(stage, 0), true);

      const fn = getStage(stage);
      try {
        if (!fn) throw new Error(`Stage "${stage}" is not implemented`);
        const result = await fn(buildStageContext(session, stage));
        // An abort that the stage swallowed still means cancel.
        if (session.signal.aborted) throw session.signal.reason ?? new Error("aborted");
        const end = nowIso();
        setStage(db, searchId, stage, { status: result === "skipped" ? "skipped" : "done", finishedAt: end });
        session.writeProgress(overallProgress(stage, 1), true);
      } catch (err) {
        if (isCancelledError(err) || session.pollCancel(true)) {
          return finishCancelled(db, searchId, stage);
        }
        const message = errorMessage(err);
        const end = nowIso();
        session.log(`stage failed: ${message}`);
        setStage(db, searchId, stage, { status: "error", error: message, finishedAt: end });
        setSearch(db, searchId, { status: "error", error: `${stage}: ${message}`, finishedAt: end, heartbeatAt: end });
        return "error";
      }
    }

    const end = nowIso();
    setSearch(db, searchId, { status: "done", stage: null, progress: 1, error: null, finishedAt: end, heartbeatAt: end });
    try {
      // Authoritative card fields (finalize wrote a provisional version before finishedAt existed).
      refreshTopicDenormalized(db, session.search.topicId);
    } catch (err) {
      session.log(`topic refresh failed: ${errorMessage(err)}`);
    }
    return "done";
  } catch (err) {
    // Infrastructure failure (DB closed, row vanished...). Best effort to record it.
    try {
      const end = nowIso();
      setSearch(db, searchId, { status: "error", error: errorMessage(err), finishedAt: end, heartbeatAt: end });
    } catch {
      // ignore
    }
    return "error";
  } finally {
    session?.dispose();
  }
}

function finishCancelled(db: Db, searchId: string, stage: StageName): SearchStatus {
  const end = nowIso();
  // The interrupted stage goes back to pending so a resume re-runs it from its checkpoint.
  setStage(db, searchId, stage, { status: "pending", finishedAt: null });
  setSearch(db, searchId, { status: "cancelled", finishedAt: end, heartbeatAt: end });
  return "cancelled";
}

// ---------------------------------------------------------------------------
// Job registry (globalThis): at most MAX_CONCURRENT_SEARCHES run at once
// ---------------------------------------------------------------------------

type Job = { db: Db | Promise<Db>; opts: RunSearchOptions };
type JobRegistry = {
  running: Map<string, Promise<SearchStatus | null>>;
  queue: Map<string, Job>;
  maxConcurrent: number;
};

const g = globalThis as unknown as { __landscapeJobs?: JobRegistry };
const jobs: JobRegistry = (g.__landscapeJobs ??= {
  running: new Map(),
  queue: new Map(),
  maxConcurrent: MAX_CONCURRENT_SEARCHES,
});

/** True while the search is running or waiting for a slot in this process. */
export function isSearchRunning(searchId: string): boolean {
  return jobs.running.has(searchId) || jobs.queue.has(searchId);
}

export function runningSearchIds(): { running: string[]; queued: string[] } {
  return { running: [...jobs.running.keys()], queued: [...jobs.queue.keys()] };
}

/** Resolves when the given search's job (if any) settles. Mainly for tests. */
export async function waitForSearch(searchId: string): Promise<void> {
  while (isSearchRunning(searchId)) {
    const p = jobs.running.get(searchId);
    if (p) await p;
    else await new Promise((r) => setTimeout(r, 10));
  }
}

/** Test helper: forget every job (running promises are left to settle) and restore the cap. */
export function resetJobsForTests(): void {
  jobs.running.clear();
  jobs.queue.clear();
  jobs.maxConcurrent = MAX_CONCURRENT_SEARCHES;
}

/** Test helper. */
export function setMaxConcurrentSearches(n: number): void {
  jobs.maxConcurrent = n;
}

function pump() {
  while (jobs.running.size < jobs.maxConcurrent && jobs.queue.size > 0) {
    const [id, job] = jobs.queue.entries().next().value as [string, Job];
    jobs.queue.delete(id);
    const p = (async () => {
      let db: Db;
      try {
        db = await job.db;
      } catch {
        return "error" as const;
      }
      try {
        await loadStages();
      } catch (err) {
        const end = nowIso();
        try {
          setSearch(db, id, { status: "error", error: `Failed to load stages: ${errorMessage(err)}`, finishedAt: end });
        } catch {
          // ignore
        }
        return "error" as const;
      }
      return runSearch(db, id, job.opts);
    })().finally(() => {
      jobs.running.delete(id);
      pump();
    });
    jobs.running.set(id, p);
  }
}

/**
 * Schedule a queued search. Starts immediately if a slot is free, otherwise it
 * stays `queued` until one frees up. No-op if already scheduled in this process.
 */
export async function startSearch(searchId: string, opts: RunSearchOptions & { db?: Db } = {}): Promise<void> {
  if (isSearchRunning(searchId)) return;
  const { db: maybeDb, ...runOpts } = opts;
  // Reserve the slot synchronously so concurrent callers can't double-schedule.
  const db = maybeDb ?? defaultDb();
  jobs.queue.set(searchId, { db, opts: runOpts });
  pump();
  await db;
}

export type SearchActionResult =
  | { ok: true; status: SearchStatus }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_status"; status: SearchStatus }
  | { ok: false; reason: "active_search"; activeSearchId: string | null };

/**
 * Request cancellation. A running search stops at its next cancel check (and
 * in-flight requests are aborted within ~2s); a search still waiting for a slot
 * is cancelled immediately.
 */
export async function cancelSearch(searchId: string, opts: { db?: Db } = {}): Promise<SearchActionResult> {
  const db = await defaultDb(opts.db);
  const row = db.select({ status: searches.status }).from(searches).where(eq(searches.id, searchId)).get();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "queued" && row.status !== "running") {
    return { ok: false, reason: "invalid_status", status: row.status };
  }
  const now = nowIso();
  setSearch(db, searchId, { cancelRequested: true });
  if (jobs.running.has(searchId)) return { ok: true, status: row.status };
  // Waiting for a slot, or orphaned (no job in this process): nothing to stop.
  jobs.queue.delete(searchId);
  setSearch(db, searchId, { status: "cancelled", finishedAt: now });
  return { ok: true, status: "cancelled" };
}

function requeue(
  db: Db,
  searchId: string,
  allowed: readonly SearchStatus[],
  resetStages: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => void,
): SearchActionResult {
  const row = db
    .select({ status: searches.status, topicId: searches.topicId })
    .from(searches)
    .where(eq(searches.id, searchId))
    .get();
  if (!row) return { ok: false, reason: "not_found" };
  if (!allowed.includes(row.status)) return { ok: false, reason: "invalid_status", status: row.status };
  try {
    db.transaction((tx) => {
      resetStages(tx);
      tx.update(searches)
        .set({ status: "queued", error: null, cancelRequested: false, finishedAt: null, heartbeatAt: nowIso() })
        .where(eq(searches.id, searchId))
        .run();
    });
  } catch (err) {
    if (isActiveConflict(err)) {
      return { ok: false, reason: "active_search", activeSearchId: activeSearchId(db, row.topicId) };
    }
    throw err;
  }
  return { ok: true, status: "queued" };
}

/** Resume an errored / cancelled / interrupted search from its first unfinished stage. */
export async function resumeSearch(
  searchId: string,
  opts: RunSearchOptions & { db?: Db } = {},
): Promise<SearchActionResult> {
  const db = await defaultDb(opts.db);
  const result = requeue(db, searchId, RESUMABLE_SEARCH_STATUSES, (tx) => {
    tx.update(searchStages)
      .set({ status: "pending", error: null, finishedAt: null })
      .where(and(eq(searchStages.searchId, searchId), inArray(searchStages.status, ["running", "error"])))
      .run();
  });
  if (result.ok) await startSearch(searchId, { ...opts, db });
  return result;
}

/**
 * Re-run the document tail (diff, synthesize, finalize) of a finished or failed
 * search. Their checkpoints are cleared; when `kinds` is given the synthesize
 * checkpoint is seeded with `{ retryKinds }` so the stage can limit itself.
 */
export async function retryDocuments(
  searchId: string,
  opts: RunSearchOptions & { db?: Db; kinds?: DocumentKind[] } = {},
): Promise<SearchActionResult> {
  const { kinds, ...rest } = opts;
  const db = await defaultDb(rest.db);
  const result = requeue(db, searchId, ["done", ...RESUMABLE_SEARCH_STATUSES], (tx) => {
    for (const stage of DOCUMENT_STAGES) {
      tx.update(searchStages)
        .set({
          status: "pending",
          error: null,
          startedAt: null,
          finishedAt: null,
          checkpoint: stage === "synthesize" && kinds?.length ? { retryKinds: kinds } : null,
        })
        .where(and(eq(searchStages.searchId, searchId), eq(searchStages.stage, stage)))
        .run();
    }
  });
  if (result.ok) await startSearch(searchId, { ...rest, db });
  return result;
}
