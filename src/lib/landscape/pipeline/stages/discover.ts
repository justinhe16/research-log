/*
 * Discover + rank stages (plan, expand, collect, embed, prerank, citations,
 * enrich, rerank). Implementations live in `./discover/*`; this file wires them
 * to an injectable `DiscoverDeps` (real sources / models by default).
 */
import type { StageContext, StageName } from "@/lib/landscape/types";
import { citationsStage } from "./discover/citations";
import { collectStage } from "./discover/collect";
import { enrichStage } from "./discover/enrich";
import { expandStage, planStage } from "./discover/plan-expand";
import { embedStage, prerankStage } from "./discover/prerank";
import { rerankStage } from "./discover/rerank";
import { defaultDiscoverDeps, makeEnv, type DiscoverDeps, type Env } from "./discover/shared";

export type { DiscoverDeps } from "./discover/shared";

export type DiscoverStage = (ctx: StageContext) => Promise<void | "skipped">;
export type DiscoverStageMap = Partial<Record<StageName, DiscoverStage>>;

export function createDiscoverStages(overrides: Partial<DiscoverDeps> = {}): DiscoverStageMap {
  const deps: DiscoverDeps = { ...defaultDiscoverDeps, ...overrides };
  const wrap =
    (fn: (env: Env) => Promise<void | "skipped">): DiscoverStage =>
    async (ctx) =>
      fn(await makeEnv(ctx, deps));
  return {
    plan: wrap(planStage),
    expand: wrap(expandStage),
    collect: wrap(collectStage),
    embed: wrap(embedStage),
    prerank: wrap(prerankStage),
    citations: wrap(citationsStage),
    enrich: wrap(enrichStage),
    rerank: wrap(rerankStage),
  };
}

export const discoverStages: DiscoverStageMap = createDiscoverStages();
