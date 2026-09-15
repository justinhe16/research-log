import type { Db } from "@/lib/db/create";
import type { SearchRow, TopicRow } from "@/lib/db/schema";
import { STAGES, type StageContext, type StageName } from "../types";

/**
 * What the runner actually hands a stage: the `StageContext` contract plus the
 * DB handle and the rows it was built from. A stage typed against plain
 * `StageContext` is still a valid `Stage` (parameter contravariance).
 */
export interface PipelineContext extends StageContext {
  db: Db;
  stage: StageName;
  /** Search row as loaded when the stage started (counters/progress may be stale; re-read if needed). */
  search: SearchRow;
  topic: TopicRow;
  /** Base search row for refresh/full, else null. */
  base: SearchRow | null;
  /** Convenience over `setStageProgress`: `done / total`, optional label is logged. */
  progress(done: number, total: number, label?: string): void;
  /** Like `log`, but kept on the search as a warning (console only for now). */
  warn(message: string): void;
}

/** A pipeline stage. Return "skipped" when the stage does not apply to this run. */
export type Stage = (ctx: PipelineContext) => Promise<void | "skipped">;

export type StageMap = Partial<Record<StageName, Stage>>;

type RegistryState = { stages: Map<StageName, Stage>; loaded: Promise<void> | null };

// globalThis so dev HMR re-evaluations share one registry with the job runner.
const g = globalThis as unknown as { __landscapeStageRegistry?: RegistryState };
const state: RegistryState = (g.__landscapeStageRegistry ??= { stages: new Map(), loaded: null });

/** Register (or replace) stage implementations. */
export function registerStages(map: StageMap): void {
  for (const name of STAGES) {
    const fn = map[name];
    if (fn) state.stages.set(name, fn);
  }
}

export function getStage(name: StageName): Stage | undefined {
  return state.stages.get(name);
}

/** Test helper: forget every registered stage. */
export function clearStages(): void {
  state.stages.clear();
}

/**
 * Load the real stage implementations (`./stages/index.ts` registers them as a
 * side effect). Idempotent. Tests `vi.mock("@/lib/landscape/pipeline/stages")`
 * and register fakes instead.
 */
export function loadStages(): Promise<void> {
  state.loaded ??= import("./stages").then(
    () => undefined,
    (err) => {
      state.loaded = null;
      throw err;
    },
  );
  return state.loaded;
}
