/*
 * Pipeline stages 9-15: graph, cluster, fulltext, extract, diff, synthesize, finalize.
 *
 * `structureStages` uses the real sources / LLM modules and resolves the DB from
 * `ctx.db` (if the runner adds one) or the app database. Tests and alternate
 * runners build their own with `createStructureStages({ db, ...fakes })`.
 */

import { clusterStage } from "./structure/cluster";
import { graphStage } from "./structure/graph";
import { extractStage, fulltextStage } from "./structure/read";
import { defaultStructureDeps, type StageMap, type StructureDeps } from "./structure/shared";
import { diffStage, finalizeStage, synthesizeStage, type SynthesizeOptions } from "./structure/synthesize";

export type { StageFn, StageMap, StructureDeps } from "./structure/shared";
export { buildSearchDossier, type SynthesizeOptions } from "./structure/synthesize";

export function createStructureStages(overrides: Partial<StructureDeps> = {}): StageMap {
  const deps: StructureDeps = { ...defaultStructureDeps, ...overrides };
  return {
    graph: (ctx) => graphStage(ctx, deps),
    cluster: (ctx) => clusterStage(ctx, deps),
    fulltext: (ctx) => fulltextStage(ctx, deps),
    extract: (ctx) => extractStage(ctx, deps),
    diff: (ctx) => diffStage(ctx, deps),
    synthesize: (ctx) => synthesizeStage(ctx, deps),
    finalize: (ctx) => finalizeStage(ctx, deps),
  };
}

export const structureStages: StageMap = createStructureStages();

/** "Retry synthesis": re-run the synthesize stage for failed kinds only (done kinds are skipped). */
export function retrySynthesis(
  ctx: Parameters<NonNullable<StageMap["synthesize"]>>[0],
  opts: SynthesizeOptions = {},
  overrides: Partial<StructureDeps> = {},
) {
  return synthesizeStage(ctx, { ...defaultStructureDeps, ...overrides }, opts);
}
