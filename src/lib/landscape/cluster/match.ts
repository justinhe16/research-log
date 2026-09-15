/*
 * Match a refresh's clusters to the base search's clusters and classify each
 * change. Pure and synchronous.
 *
 *  - Pair score = 0.5·centroid cosine + 0.5·member Jaccard; one-to-one greedy
 *    matching (highest score first) with score ≥ 0.5.
 *  - merged: a current cluster overlaps (Jaccard ≥ 0.25) two or more base clusters.
 *  - split:  a base cluster overlaps (Jaccard ≥ 0.25) two or more current clusters.
 *  - Otherwise a matched pair is grew / shrank (size ±30%) / stable, an
 *    unmatched current cluster is new, and a base cluster nothing points at is gone.
 *  - A current cluster's greedy match is always its baseClusterIdx and first baseIdx.
 *  - Many-to-many is accepted: one base may appear in several rows at once, e.g.
 *    in a "split" row (its other half) and a "merged" row (half that joined
 *    another base). Such a base is referenced, so never "gone".
 */

import type { ClusterChange, SearchDiff } from "../types";
import { cosineSim, type Vec } from "./silhouette";

export type MatchableCluster = {
  idx: number;
  centroid: Vec;
  /** Member paper ids. */
  members: readonly string[];
  label?: string;
};

export type ClusterChangeEntry = SearchDiff["clusterChanges"][number];

export type ClusterMatchResult = {
  /** One row per current cluster (in idx order): values for search_clusters.base_cluster_idx / change. */
  current: { idx: number; baseClusterIdx: number | null; change: ClusterChange }[];
  /** Current clusters in idx order, then gone base clusters in idx order. */
  changes: ClusterChangeEntry[];
};

export const MATCH_MIN_SCORE = 0.5;
export const SPLIT_MERGE_MIN_JACCARD = 0.25;
export const SIZE_CHANGE_RATIO = 0.3;

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function matchClusters(
  base: readonly MatchableCluster[],
  current: readonly MatchableCluster[],
): ClusterMatchResult {
  const cur = [...current].sort((a, b) => a.idx - b.idx);
  const bas = [...base].sort((a, b) => a.idx - b.idx);

  const jac = cur.map((c) => bas.map((b) => jaccard(c.members, b.members)));
  const pairs: { ci: number; bi: number; score: number }[] = [];
  cur.forEach((c, ci) =>
    bas.forEach((b, bi) => {
      const score = 0.5 * cosineSim(c.centroid, b.centroid) + 0.5 * jac[ci][bi];
      if (score >= MATCH_MIN_SCORE) pairs.push({ ci, bi, score });
    }),
  );
  pairs.sort((x, y) => y.score - x.score || x.ci - y.ci || x.bi - y.bi);

  const matchOfCur = new Map<number, number>();
  const usedBase = new Set<number>();
  for (const p of pairs) {
    if (matchOfCur.has(p.ci) || usedBase.has(p.bi)) continue;
    matchOfCur.set(p.ci, p.bi);
    usedBase.add(p.bi);
  }

  const overlapBasesOfCur = cur.map((_, ci) =>
    bas.flatMap((_, bi) => (jac[ci][bi] >= SPLIT_MERGE_MIN_JACCARD ? [bi] : [])),
  );
  const overlapCursOfBase = bas.map((_, bi) =>
    cur.flatMap((_, ci) => (jac[ci][bi] >= SPLIT_MERGE_MIN_JACCARD ? [ci] : [])),
  );

  const referenced = new Set<number>();
  const rows: ClusterMatchResult["current"] = [];
  const changes: ClusterChangeEntry[] = [];

  cur.forEach((c, ci) => {
    const sizeAfter = c.members.length;
    const label = c.label ?? `Cluster ${c.idx + 1}`;
    const matched = matchOfCur.get(ci);
    const overlaps = overlapBasesOfCur[ci];

    let change: ClusterChange;
    let baseBis: number[];
    let primary: number | null;

    if (overlaps.length >= 2) {
      change = "merged";
      baseBis = overlaps;
      primary = overlaps.reduce((best, bi) => (jac[ci][bi] > jac[ci][best] ? bi : best), overlaps[0]);
    } else {
      const splitFrom =
        (matched !== undefined && overlapCursOfBase[matched].length >= 2 ? matched : undefined) ??
        overlaps.find((bi) => overlapCursOfBase[bi].length >= 2);
      if (splitFrom !== undefined) {
        change = "split";
        baseBis = [splitFrom];
        primary = splitFrom;
      } else if (matched !== undefined) {
        const before = bas[matched].members.length;
        change =
          sizeAfter >= before * (1 + SIZE_CHANGE_RATIO)
            ? "grew"
            : sizeAfter <= before * (1 - SIZE_CHANGE_RATIO)
              ? "shrank"
              : "stable";
        baseBis = [matched];
        primary = matched;
      } else {
        change = "new";
        baseBis = [];
        primary = null;
      }
    }

    // sizeBefore: the split source's size, or the summed overlapping bases for merged.
    const sizeBefore =
      change === "split" ? bas[baseBis[0]].members.length : baseBis.reduce((s, bi) => s + bas[bi].members.length, 0);

    // The exclusive greedy match always wins the base_cluster_idx column and is
    // always listed (first) in baseIdxs, so a matched base is never reported "gone"
    // even when split/merged classification came from a different base.
    if (matched !== undefined) {
      primary = matched;
      baseBis = [matched, ...baseBis.filter((bi) => bi !== matched)];
    }

    baseBis.forEach((bi) => referenced.add(bi));
    rows.push({ idx: c.idx, baseClusterIdx: primary === null ? null : bas[primary].idx, change });
    changes.push({ idx: c.idx, baseIdxs: baseBis.map((bi) => bas[bi].idx), change, label, sizeBefore, sizeAfter });
  });

  bas.forEach((b, bi) => {
    if (referenced.has(bi)) return;
    changes.push({
      idx: null,
      baseIdxs: [b.idx],
      change: "gone",
      label: b.label ?? `Cluster ${b.idx + 1}`,
      sizeBefore: b.members.length,
      sizeAfter: 0,
    });
  });

  return { current: rows, changes };
}
