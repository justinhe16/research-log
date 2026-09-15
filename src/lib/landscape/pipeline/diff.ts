/*
 * Refresh diff: compares a refresh's selection, citation snapshot and clusters
 * against its base search. Pure; produces the stored `diff` document.
 */

import { matchClusters, type ClusterMatchResult, type MatchableCluster } from "../cluster/match";
import { RISING_MAX, RISING_MIN_DELTA } from "../constants";
import type { SearchDiff } from "../types";

export type DiffSide = {
  /** Selected paper ids, in rank order. */
  selectedIds: readonly string[];
  /** paperId -> citation count snapshotted at that search. */
  citationCounts: ReadonlyMap<string, number | null>;
  /** paperId -> publication date ("YYYY-MM-DD" or ISO) where known. */
  publishedAt?: ReadonlyMap<string, string | null>;
  clusters: readonly MatchableCluster[];
};

export type ComputeDiffInput = {
  baseSearchId: string;
  /** Base search's start (ISO); stored as `since`. */
  since?: string | null;
  base: DiffSide;
  current: DiffSide;
  /** Unused by the stored diff; accepted so callers can pass one clock everywhere. */
  now?: Date;
};

/** Like computeDiff, but also returns the per-cluster rows for search_clusters. */
export function computeDiffWithMatch(input: ComputeDiffInput): { diff: SearchDiff; match: ClusterMatchResult } {
  const { base, current } = input;
  const baseSet = new Set(base.selectedIds);
  const currentSet = new Set(current.selectedIds);

  const newPaperIds = dedupe(current.selectedIds.filter((id) => !baseSet.has(id)));
  const droppedPaperIds = dedupe(base.selectedIds.filter((id) => !currentSet.has(id)));

  const rising: SearchDiff["rising"] = [];
  for (const paperId of dedupe(current.selectedIds)) {
    const before = base.citationCounts.get(paperId);
    const after = current.citationCounts.get(paperId);
    if (before == null || after == null) continue;
    const delta = Math.round(after - before);
    if (delta < RISING_MIN_DELTA) continue;
    rising.push({ paperId, citationsBefore: Math.round(before), citationsAfter: Math.round(after), delta });
  }
  rising.sort(
    (a, b) =>
      b.delta - a.delta || b.citationsAfter - a.citationsAfter || (a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : 0),
  );

  const match = matchClusters(base.clusters, current.clusters);
  return {
    diff: {
      baseSearchId: input.baseSearchId,
      since: input.since ?? null,
      newPaperIds,
      droppedPaperIds,
      rising: rising.slice(0, RISING_MAX),
      clusterChanges: match.changes,
    },
    match,
  };
}

export function computeDiff(input: ComputeDiffInput): SearchDiff {
  return computeDiffWithMatch(input).diff;
}

/**
 * Publication pace of a selection: papers per month over the trailing 12
 * months, and growth = last 6 months vs the 6 before (null when the earlier
 * window is empty). Not part of the stored diff; offered for narrative/UI use.
 */
export function publicationRate(
  ids: readonly string[],
  publishedAt: ReadonlyMap<string, string | null>,
  now: Date = new Date(),
): { monthlyRate: number; growth: number | null } {
  const DAY = 86_400_000;
  const t = now.getTime();
  let last12 = 0;
  let last6 = 0;
  let prev6 = 0;
  for (const id of new Set(ids)) {
    const raw = publishedAt.get(id);
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (Number.isNaN(ts) || ts > t) continue;
    const ageDays = (t - ts) / DAY;
    if (ageDays <= 365) last12++;
    if (ageDays <= 182.5) last6++;
    else if (ageDays <= 365) prev6++;
  }
  return { monthlyRate: last12 / 12, growth: prev6 > 0 ? (last6 - prev6) / prev6 : null };
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
