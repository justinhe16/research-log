import { CLUSTER_COLORS } from "@/lib/landscape/constants";
import type { ClusterDTO } from "@/lib/landscape/types";

/** Theme color for a 1-based color slot (ClusterDTO.color). */
export function colorSlotVar(slot: number): string {
  const n = ((((Math.round(slot) - 1) % CLUSTER_COLORS) + CLUSTER_COLORS) % CLUSTER_COLORS) + 1;
  return `var(--chart-${n})`;
}

/** Fallback when only a cluster index is known: idx 0 -> --chart-1. */
export function clusterIdxVar(idx: number): string {
  return colorSlotVar(idx + 1);
}

/** Resolve a paper's cluster to its color, preferring the cluster's assigned slot. */
export function clusterColor(clusters: ClusterDTO[], idx: number | null | undefined): string | null {
  if (idx === null || idx === undefined) return null;
  const cluster = clusters.find((c) => c.idx === idx);
  return cluster ? colorSlotVar(cluster.color) : clusterIdxVar(idx);
}
