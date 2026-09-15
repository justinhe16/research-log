/*
 * Spherical k-means (k-means++ seeding, cosine distance on L2-normalized
 * vectors), silhouette-based k selection and small-cluster merging.
 *
 * Pure, synchronous and deterministic for a given seed. Cost per run is
 * O(restarts · iters · n · k · d); iterations stop as soon as assignments are
 * stable, which for n ≤ ~350 and d = 384 is typically well under a second for
 * a full k scan.
 */

import { KMEANS_MAX_ITERATIONS, KMEANS_SEED, MIN_CLUSTER_SIZE } from "../constants";
import { mulberry32 } from "./prng";
import { cosineDistanceMatrix, dot, normalize, silhouetteFromMatrix, type Vec } from "./silhouette";

export type KMeansOptions = {
  seed?: number;
  restarts?: number;
  maxIterations?: number;
};

export type KMeansResult = {
  k: number;
  /** Cluster index per input vector, 0..k-1. */
  labels: number[];
  /** Unit-length centroids. */
  centroids: Float32Array[];
  /** Sum of cosine distances to assigned centroids. */
  inertia: number;
};

export type ChooseKOptions = KMeansOptions & {
  minClusterSize?: number;
};

export type ChooseKResult = KMeansResult & {
  /** Mean silhouette of the final (post-merge) labelling. */
  silhouette: number;
  /** Silhouette per candidate k tried (pre-merge). */
  scores: { k: number; score: number }[];
};

const DEFAULT_RESTARTS = 8;
/** Within this much of the best silhouette, the smaller k wins. */
const SILHOUETTE_TOLERANCE = 0.01;

function meanCentroid(units: Float32Array[], members: number[], dim: number): Float32Array {
  const c = new Float32Array(dim);
  for (const i of members) {
    const u = units[i];
    for (let d = 0; d < dim; d++) c[d] += u[d];
  }
  return normalize(c);
}

/** Recompute unit centroids for contiguous labels 0..k-1. */
export function computeCentroids(vectors: readonly Vec[], labels: readonly number[], k: number): Float32Array[] {
  const units = vectors.map(normalize);
  const dim = units[0]?.length ?? 0;
  const members: number[][] = Array.from({ length: k }, () => []);
  labels.forEach((l, i) => members[l].push(i));
  return members.map((m) => meanCentroid(units, m, dim));
}

function nearest(u: Float32Array, centroids: Float32Array[]): { idx: number; dist: number } {
  let idx = 0;
  let best = -Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const s = dot(u, centroids[c]);
    if (s > best) {
      best = s;
      idx = c;
    }
  }
  return { idx, dist: 1 - best };
}

function runOnce(units: Float32Array[], k: number, rand: () => number, maxIterations: number): KMeansResult {
  const n = units.length;
  const dim = units[0].length;

  // k-means++ seeding with D² weighting on cosine distance.
  const centroids: Float32Array[] = [Float32Array.from(units[Math.floor(rand() * n)])];
  const minDist = units.map((u) => Math.max(0, 1 - dot(u, centroids[0])));
  while (centroids.length < k) {
    let total = 0;
    for (const d of minDist) total += d * d;
    let pick = 0;
    if (total > 0) {
      let r = rand() * total;
      for (pick = 0; pick < n - 1; pick++) {
        r -= minDist[pick] * minDist[pick];
        if (r <= 0) break;
      }
    } else {
      pick = Math.floor(rand() * n);
    }
    const c = Float32Array.from(units[pick]);
    centroids.push(c);
    for (let i = 0; i < n; i++) minDist[i] = Math.min(minDist[i], Math.max(0, 1 - dot(units[i], c)));
  }

  const labels = new Array<number>(n).fill(-1);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const { idx } = nearest(units[i], centroids);
      if (idx !== labels[i]) {
        labels[i] = idx;
        changed = true;
      }
    }
    if (!changed) break;

    const members: number[][] = Array.from({ length: k }, () => []);
    labels.forEach((l, i) => members[l].push(i));
    for (let c = 0; c < k; c++) {
      if (members[c].length > 0) {
        centroids[c] = meanCentroid(units, members[c], dim);
        continue;
      }
      // Empty cluster: reseed at the point farthest from its centroid.
      let far = 0;
      let farDist = -Infinity;
      for (let i = 0; i < n; i++) {
        const d = 1 - dot(units[i], centroids[labels[i]]);
        if (d > farDist) {
          farDist = d;
          far = i;
        }
      }
      centroids[c] = Float32Array.from(units[far]);
      labels[far] = c;
    }
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += Math.max(0, 1 - dot(units[i], centroids[labels[i]]));
  return { k, labels, centroids, inertia };
}

/** k-means with `restarts` seeded runs; the lowest-inertia run wins. */
export function kmeans(vectors: readonly Vec[], k: number, opts: KMeansOptions = {}): KMeansResult {
  const n = vectors.length;
  const units = vectors.map(normalize);
  if (n === 0) return { k: 0, labels: [], centroids: [], inertia: 0 };
  const kk = Math.max(1, Math.min(Math.floor(k), n));
  const rand = mulberry32(opts.seed ?? KMEANS_SEED);
  const restarts = Math.max(1, opts.restarts ?? DEFAULT_RESTARTS);
  const maxIterations = opts.maxIterations ?? KMEANS_MAX_ITERATIONS;

  let best: KMeansResult | null = null;
  for (let r = 0; r < restarts; r++) {
    const res = runOnce(units, kk, rand, maxIterations);
    if (!best || res.inertia < best.inertia - 1e-9) best = res;
  }
  return best!;
}

/**
 * Merge clusters smaller than `minSize` into the nearest remaining centroid,
 * smallest first, until none remain (or only one cluster is left). Labels are
 * re-indexed contiguously preserving the original relative order, and
 * centroids are recomputed.
 */
export function mergeSmallClusters(
  vectors: readonly Vec[],
  labels: readonly number[],
  minSize: number = MIN_CLUSTER_SIZE,
): { k: number; labels: number[]; centroids: Float32Array[] } {
  const units = vectors.map(normalize);
  const dim = units[0]?.length ?? 0;
  const out = [...labels];
  if (out.length === 0) return { k: 0, labels: [], centroids: [] };

  const live = () => [...new Set(out)].sort((a, b) => a - b);
  const membersOf = (c: number) => out.flatMap((l, i) => (l === c ? [i] : []));

  for (;;) {
    const ids = live();
    if (ids.length <= 1) break;
    const sized = ids.map((c) => ({ c, size: membersOf(c).length }));
    const small = sized.filter((s) => s.size < minSize).sort((a, b) => a.size - b.size || a.c - b.c)[0];
    if (!small) break;
    const others = ids.filter((c) => c !== small.c);
    const cents = others.map((c) => meanCentroid(units, membersOf(c), dim));
    for (const i of membersOf(small.c)) out[i] = others[nearest(units[i], cents).idx];
  }

  const remap = new Map(live().map((c, i) => [c, i]));
  const relabeled = out.map((l) => remap.get(l)!);
  const k = remap.size;
  return { k, labels: relabeled, centroids: computeCentroids(vectors, relabeled, k) };
}

/**
 * Pick k in [kMin, kMax] by max mean silhouette (cosine), preferring the
 * smaller k within 0.01 of the best; then merge clusters below the min size.
 * k is clamped to n-1 (silhouette needs ≥2 clusters, and k=n is degenerate).
 * When no valid k exists (e.g. n < kMin) everything goes in one cluster.
 */
export function chooseK(
  vectors: readonly Vec[],
  range: readonly [number, number],
  seed: number = KMEANS_SEED,
  opts: ChooseKOptions = {},
): ChooseKResult {
  const n = vectors.length;
  const minSize = opts.minClusterSize ?? MIN_CLUSTER_SIZE;
  const [kMin, kMax] = range;
  const lo = Math.max(2, Math.floor(kMin));
  const hi = Math.min(Math.floor(kMax), n - 1);

  if (n === 0) return { k: 0, labels: [], centroids: [], inertia: 0, silhouette: 0, scores: [] };
  if (n < kMin || hi < lo) {
    const labels = new Array<number>(n).fill(0);
    const centroids = computeCentroids(vectors, labels, 1);
    const units = vectors.map(normalize);
    const inertia = units.reduce((s, u) => s + Math.max(0, 1 - dot(u, centroids[0])), 0);
    return { k: 1, labels, centroids, inertia, silhouette: 0, scores: [] };
  }

  const dist = cosineDistanceMatrix(vectors);
  const scores: { k: number; score: number }[] = [];
  const candidates: { k: number; score: number; merged: ReturnType<typeof mergeSmallClusters> }[] = [];
  for (let k = lo; k <= hi; k++) {
    const res = kmeans(vectors, k, { ...opts, seed });
    const score = silhouetteFromMatrix(res.labels, dist);
    scores.push({ k, score });
    const merged = mergeSmallClusters(vectors, res.labels, minSize);
    // Judge each k by its post-merge labelling: a high pre-merge silhouette that comes
    // from a singleton outlier collapses to fewer clusters once the outlier is merged.
    candidates.push({ k, merged, score: merged.k === res.k ? score : merged.k >= 2 ? silhouetteFromMatrix(merged.labels, dist) : -Infinity });
  }
  if (scores.length === 0) throw new Error(`chooseK: no candidate k in [${lo}, ${hi}]`);
  // Prefer runs that still honour the lower bound after merging; otherwise take what we can get.
  const viable = candidates.filter((c) => c.merged.k >= lo);
  const pool = viable.length ? viable : candidates;
  const bestScore = Math.max(...pool.map((c) => c.score));
  const chosen = pool.find((c) => c.score >= bestScore - SILHOUETTE_TOLERANCE)!;
  const merged = chosen.merged;

  const units = vectors.map(normalize);
  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += Math.max(0, 1 - dot(units[i], merged.centroids[merged.labels[i]]));
  return {
    k: merged.k,
    labels: merged.labels,
    centroids: merged.centroids,
    inertia,
    silhouette: Number.isFinite(chosen.score) ? chosen.score : 0,
    scores,
  };
}
