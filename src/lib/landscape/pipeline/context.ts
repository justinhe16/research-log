import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { llmCalls, searchStages, searches, topics, type SearchRow, type TopicRow } from "@/lib/db/schema";
import { HEARTBEAT_INTERVAL_MS, STAGE_WEIGHTS } from "../constants";
import { STAGES, type LlmCallRecord, type LlmRecorder, type SearchCounters, type StageName } from "../types";
import type { PipelineContext } from "./stage-registry";

/** Thrown by `throwIfCancelled` (and mapped from aborts) when a cancel was requested. */
export class SearchCancelledError extends Error {
  constructor(message = "Search cancelled") {
    super(message);
    this.name = "SearchCancelledError";
  }
}

export function isCancelledError(err: unknown): boolean {
  return err instanceof SearchCancelledError;
}

/** Min gap between `searches.progress` writes. */
export const PROGRESS_THROTTLE_MS = 500;
/** How often the cancel flag is polled (and the abort signal fired). */
export const CANCEL_POLL_MS = 2_000;

const TOTAL_WEIGHT = STAGES.reduce((sum, s) => sum + STAGE_WEIGHTS[s], 0);

/** Overall 0..1 progress when `stage` is `fraction` complete (all earlier stages count as complete). */
export function overallProgress(stage: StageName, fraction: number): number {
  let before = 0;
  for (const s of STAGES) {
    if (s === stage) break;
    before += STAGE_WEIGHTS[s];
  }
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return Math.min(1, (before + STAGE_WEIGHTS[stage] * f) / TOTAL_WEIGHT);
}

const nowIso = () => new Date().toISOString();

export type SearchSessionOptions = {
  hasS2Key?: boolean;
  logger?: (message: string) => void;
  /** Timers are disabled when false (tests drive polling via calls). Default true. */
  timers?: boolean;
};

/**
 * Per-run state shared by every stage of one `runSearch` call: the rows, the
 * abort controller, heartbeat/cancel polling and the LLM recorder.
 */
export class SearchSession {
  readonly controller = new AbortController();
  currentStage: StageName | null = null;
  private lastProgressWrite = 0;
  private lastCancelPoll = 0;
  private lastHeartbeat = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly recorder: LlmRecorder;
  readonly warnings: string[] = [];

  constructor(
    readonly db: Db,
    readonly search: SearchRow,
    readonly topic: TopicRow,
    readonly base: SearchRow | null,
    private readonly opts: SearchSessionOptions = {},
  ) {
    this.recorder = { record: (call) => this.recordLlmCall(call) };
    if (opts.timers !== false) {
      this.timer = setInterval(() => this.tick(), CANCEL_POLL_MS);
      this.timer.unref?.();
    }
  }

  get searchId() {
    return this.search.id;
  }

  get signal() {
    return this.controller.signal;
  }

  get hasS2Key() {
    return this.opts.hasS2Key ?? Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim());
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  log(message: string) {
    const line = `[landscape ${this.searchId.slice(0, 8)}${this.currentStage ? `:${this.currentStage}` : ""}] ${message}`;
    (this.opts.logger ?? console.log)(line);
  }

  warn(message: string) {
    this.warnings.push(message);
    const line = `[landscape ${this.searchId.slice(0, 8)}${this.currentStage ? `:${this.currentStage}` : ""}] warning: ${message}`;
    (this.opts.logger ?? console.warn)(line);
  }

  /** Periodic: heartbeat + cancel poll. Never throws. */
  tick() {
    try {
      this.pollCancel(true);
      this.heartbeat();
    } catch {
      // DB closed or busy; the next tick retries.
    }
  }

  /** Reads `cancel_requested`; aborts the signal when set. Throttled unless `force`. */
  pollCancel(force = false): boolean {
    if (this.controller.signal.aborted) return true;
    const now = Date.now();
    if (!force && now - this.lastCancelPoll < CANCEL_POLL_MS) return false;
    this.lastCancelPoll = now;
    const row = this.db
      .select({ cancel: searches.cancelRequested })
      .from(searches)
      .where(eq(searches.id, this.searchId))
      .get();
    // A deleted search counts as cancelled.
    if (!row || row.cancel) {
      this.controller.abort(new SearchCancelledError());
      return true;
    }
    return false;
  }

  throwIfCancelled() {
    this.lastCancelPoll = 0;
    if (this.pollCancel(true)) throw new SearchCancelledError();
  }

  heartbeat(force = false) {
    const now = Date.now();
    if (!force && now - this.lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeat = now;
    this.db.update(searches).set({ heartbeatAt: new Date(now).toISOString() }).where(eq(searches.id, this.searchId)).run();
  }

  /** Writes overall progress (throttled unless `force`) and bumps the heartbeat. */
  writeProgress(value: number, force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressWrite < PROGRESS_THROTTLE_MS) return;
    this.lastProgressWrite = now;
    this.lastHeartbeat = now;
    this.db
      .update(searches)
      .set({ progress: value, heartbeatAt: new Date(now).toISOString() })
      .where(eq(searches.id, this.searchId))
      .run();
    this.pollCancel();
  }

  updateCounters(patch: Partial<SearchCounters>) {
    const now = Date.now();
    this.lastHeartbeat = now;
    this.db.transaction((tx) => {
      const row = tx.select({ counters: searches.counters }).from(searches).where(eq(searches.id, this.searchId)).get();
      if (!row) return;
      const merged: SearchCounters = { ...(row.counters ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
      }
      tx.update(searches)
        .set({ counters: merged, heartbeatAt: new Date(now).toISOString() })
        .where(eq(searches.id, this.searchId))
        .run();
    });
    this.pollCancel();
  }

  readCheckpoint(stage: StageName): Record<string, unknown> | null {
    const row = this.db
      .select({ checkpoint: searchStages.checkpoint })
      .from(searchStages)
      .where(and(eq(searchStages.searchId, this.searchId), eq(searchStages.stage, stage)))
      .get();
    return row?.checkpoint ?? null;
  }

  saveCheckpoint(stage: StageName, patch: Record<string, unknown>): Record<string, unknown> {
    return this.db.transaction((tx) => {
      const row = tx
        .select({ checkpoint: searchStages.checkpoint })
        .from(searchStages)
        .where(and(eq(searchStages.searchId, this.searchId), eq(searchStages.stage, stage)))
        .get();
      const merged = { ...(row?.checkpoint ?? {}), ...patch };
      tx.update(searchStages)
        .set({ checkpoint: merged })
        .where(and(eq(searchStages.searchId, this.searchId), eq(searchStages.stage, stage)))
        .run();
      return merged;
    });
  }

  /** Inserts an `llm_calls` row and rolls usage into the search, atomically. */
  recordLlmCall(call: LlmCallRecord) {
    const n = (x: number) => (Number.isFinite(x) ? x : 0);
    this.lastHeartbeat = Date.now();
    this.db.transaction((tx) => {
      tx.insert(llmCalls)
        .values({
          id: crypto.randomUUID(),
          searchId: this.searchId,
          stage: this.currentStage,
          purpose: call.purpose,
          model: call.model,
          inputTokens: n(call.inputTokens),
          outputTokens: n(call.outputTokens),
          cacheReadTokens: n(call.cacheReadTokens),
          cacheWriteTokens: n(call.cacheWriteTokens),
          costUsd: n(call.costUsd),
          durationMs: Math.round(n(call.durationMs)),
          ok: call.ok,
          error: call.error ?? null,
          createdAt: nowIso(),
        })
        .run();
      tx.update(searches)
        .set({
          inputTokens: sql`${searches.inputTokens} + ${n(call.inputTokens)}`,
          outputTokens: sql`${searches.outputTokens} + ${n(call.outputTokens)}`,
          cacheReadTokens: sql`${searches.cacheReadTokens} + ${n(call.cacheReadTokens)}`,
          cacheWriteTokens: sql`${searches.cacheWriteTokens} + ${n(call.cacheWriteTokens)}`,
          costUsd: sql`${searches.costUsd} + ${n(call.costUsd)}`,
          counters: sql`json_set(coalesce(${searches.counters}, '{}'), '$.llmCalls', coalesce(json_extract(${searches.counters}, '$.llmCalls'), 0) + 1)`,
          heartbeatAt: nowIso(),
        })
        .where(eq(searches.id, this.searchId))
        .run();
    });
  }
}

/** Loads the rows for a search and opens a session, or null if the search/topic is gone. */
export function openSearchSession(db: Db, searchId: string, opts: SearchSessionOptions = {}): SearchSession | null {
  const search = db.select().from(searches).where(eq(searches.id, searchId)).get();
  if (!search) return null;
  const topic = db.select().from(topics).where(eq(topics.id, search.topicId)).get();
  if (!topic) return null;
  const base = search.baseSearchId
    ? (db.select().from(searches).where(eq(searches.id, search.baseSearchId)).get() ?? null)
    : null;
  return new SearchSession(db, search, topic, base, opts);
}

/** Builds the context handed to one stage. */
export function buildStageContext(session: SearchSession, stage: StageName): PipelineContext {
  const ctx: PipelineContext = {
    db: session.db,
    stage,
    search: session.search,
    topic: session.topic,
    base: session.base,
    searchId: session.search.id,
    topicId: session.search.topicId,
    kind: session.search.kind,
    config: session.search.config,
    baseSearchId: session.search.baseSearchId ?? null,
    checkpoint: session.readCheckpoint(stage),
    saveCheckpoint(patch) {
      ctx.checkpoint = session.saveCheckpoint(stage, patch);
    },
    updateCounters: (patch) => session.updateCounters(patch),
    setStageProgress: (fraction) => session.writeProgress(overallProgress(stage, fraction)),
    progress(done, total, label) {
      if (label) session.log(`${label} (${done}/${total})`);
      session.writeProgress(overallProgress(stage, total > 0 ? done / total : 0), total > 0 && done >= total);
    },
    throwIfCancelled: () => session.throwIfCancelled(),
    signal: session.signal,
    recorder: session.recorder,
    hasS2Key: session.hasS2Key,
    log: (message) => session.log(message),
    warn: (message) => session.warn(message),
  };
  return ctx;
}
