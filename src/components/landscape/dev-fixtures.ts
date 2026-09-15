/*
 * Derived sample data for `?fixture=` mode. Loaded with a dynamic import so none
 * of it ships in the normal client bundle path.
 */
import type {
  LandscapeSnapshot,
  PaperDetail,
  PaperRelation,
  SearchProgress,
  SearchSummary,
  TopicCard,
  TopicDetail,
} from "@/lib/landscape/types";
import {
  landscapeSnapshotFixture as snapshot,
  runningProgressFixture,
  topicCardFixture,
} from "./__fixtures__/snapshot";
import type { FixtureMode } from "./fixture-mode";

const BASE_SEARCH: SearchSummary = {
  ...snapshot.search,
  id: snapshot.search.baseSearchId ?? "search-initial-1",
  kind: "initial",
  paperCount: 17,
  costUsd: 0.284,
  createdAt: "2026-06-01T09:00:00.000Z",
  startedAt: "2026-06-01T09:00:01.000Z",
  finishedAt: "2026-06-01T09:04:10.000Z",
};

const DONE_SEARCH: SearchSummary = {
  id: snapshot.search.id,
  topicId: snapshot.search.topicId,
  kind: snapshot.search.kind,
  depth: snapshot.search.depth,
  status: snapshot.search.status,
  stage: snapshot.search.stage,
  progress: snapshot.search.progress,
  paperCount: snapshot.search.paperCount,
  costUsd: snapshot.search.costUsd,
  createdAt: snapshot.search.createdAt,
  startedAt: snapshot.search.startedAt,
  finishedAt: snapshot.search.finishedAt,
};

let progressTicks = 0;

function toSummary(p: SearchProgress): SearchSummary {
  const { id, topicId, kind, depth, status, stage, progress, paperCount, costUsd, createdAt, startedAt, finishedAt } = p;
  return { id, topicId, kind, depth, status, stage, progress, paperCount, costUsd, createdAt, startedAt, finishedAt };
}

export function fixtureProgress(topicId = topicCardFixture.id): SearchProgress {
  // Nudge counters forward on every poll so the live UI has something to animate.
  const t = progressTicks++;
  const extracted = Math.min(100, (runningProgressFixture.counters.extracted ?? 0) + t * 3);
  return {
    ...runningProgressFixture,
    topicId,
    createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    progress: Math.min(0.78, runningProgressFixture.progress + t * 0.01),
    costUsd: Math.round((runningProgressFixture.costUsd + t * 0.004) * 1000) / 1000,
    counters: { ...runningProgressFixture.counters, extracted, llmCalls: 12 + Math.floor(t / 2) },
    heartbeatAt: new Date().toISOString(),
  };
}

export function fixtureTopics(mode: FixtureMode): TopicCard[] {
  if (mode === "empty") return [];
  const running = fixtureProgress("topic-rlhf");
  return [
    {
      ...topicCardFixture,
      activeSearch: mode === "running" ? toSummary(fixtureProgress()) : null,
      lastSearchAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    },
    {
      id: "topic-rlhf",
      slug: "reward-model-overoptimization",
      name: "Reward model overoptimization",
      description: "Goodhart effects when optimizing against learned reward models in RLHF.",
      defaultDepth: "deep",
      summary: null,
      paperCount: 0,
      lastSearchAt: null,
      lastSearch: null,
      activeSearch: toSummary(running),
      createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "topic-spec",
      slug: "speculative-decoding",
      name: "Speculative decoding",
      description: "Draft-and-verify inference for faster autoregressive generation.",
      defaultDepth: "quick",
      summary:
        "Speculative decoding speeds up generation by letting a cheap draft model propose tokens that the target model verifies in parallel, trading draft quality against acceptance rate.",
      paperCount: 15,
      lastSearchAt: "2026-08-12T15:20:00.000Z",
      lastSearch: { ...DONE_SEARCH, id: "search-spec-1", topicId: "topic-spec", kind: "initial", depth: "quick", paperCount: 15, costUsd: 0.09 },
      activeSearch: null,
      createdAt: "2026-08-12T15:16:00.000Z",
      updatedAt: "2026-08-12T15:20:00.000Z",
    },
  ];
}

export function fixtureTopicDetail(mode: FixtureMode): TopicDetail {
  if (mode === "empty") {
    return { ...topicCardFixture, summary: null, paperCount: 0, lastSearch: null, lastSearchAt: null, activeSearch: null, searches: [] };
  }
  const active = mode === "running" ? fixtureProgress() : null;
  return {
    ...topicCardFixture,
    activeSearch: active ? toSummary(active) : null,
    searches: [...(active ? [toSummary(active)] : []), DONE_SEARCH, BASE_SEARCH],
  };
}

export function fixtureSnapshot(searchId: string): LandscapeSnapshot {
  if (searchId === BASE_SEARCH.id) {
    return {
      ...snapshot,
      search: { ...snapshot.search, ...BASE_SEARCH, since: null, baseSearchId: null },
      documents: { ...snapshot.documents, diff: null, gaps: null },
      failedDocuments: ["gaps"],
    };
  }
  return snapshot;
}

export function fixturePaperDetail(paperId: string): PaperDetail {
  const paper = snapshot.papers.find((p) => p.id === paperId);
  if (!paper) throw new Error("Paper not found in fixture.");
  const byId = new Map(snapshot.papers.map((p) => [p.id, p]));
  const relations: PaperRelation[] = snapshot.edges
    .filter((e) => e.source === paperId || e.target === paperId)
    .flatMap((e) => {
      const otherId = e.source === paperId ? e.target : e.source;
      const other = byId.get(otherId);
      if (!other) return [];
      return [{
        paper: { id: other.id, title: other.title, year: other.year, clusterIdx: other.clusterIdx, rank: other.rank },
        kind: e.kind,
        direction: e.source === paperId ? ("out" as const) : ("in" as const),
        weight: e.weight,
      }];
    });
  const cluster = snapshot.clusters.find((c) => c.idx === paper.clusterIdx);
  const { ref, rank, relevance, influence, clusterIdx, origin, foundational, gameChanger, ...rest } = paper;
  return {
    ...rest,
    abstract: paper.tldr,
    authorsDetailed: paper.authors.map((name) => ({ name })),
    extraction: paper.hasExtraction
      ? {
          source: "abstract",
          model: "fixture",
          problem: "Neurons in language models are polysemantic, so inspecting them one at a time gives an unreliable picture of what the model represents.",
          method: "Train a sparse, overcomplete dictionary on cached activations and study the learned directions as candidate features.",
          results: paper.tldr ?? "",
          contribution: paper.tldr ?? "",
          limitations: "Illustrative fixture text; real extractions come from the pipeline.",
          datasets: ["The Pile", "OpenWebText"],
          benchmarks: rank % 3 === 0 ? ["SAEBench"] : [],
          createdAt: snapshot.search.finishedAt ?? snapshot.search.createdAt,
        }
      : null,
    search: {
      searchId: snapshot.search.id,
      ref,
      rank,
      selected: true,
      relevance,
      influence,
      clusterIdx,
      clusterLabel: cluster?.label ?? null,
      origin,
      foundational,
      gameChanger,
      relations,
    },
  };
}
