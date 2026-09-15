import { describe, expect, it } from "vitest";
import { chooseK, kmeans, mergeSmallClusters } from "../kmeans";
import { hashSeed, mulberry32 } from "../prng";
import { silhouette } from "../silhouette";

/** Gaussian blobs around orthogonal axes in `dim` dims (well separated in cosine). */
function blobs(k: number, perBlob: number, dim = 16, noise = 0.1, seed = 7): { vectors: Float32Array[]; truth: number[] } {
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const vectors: Float32Array[] = [];
  const truth: number[] = [];
  for (let c = 0; c < k; c++) {
    for (let i = 0; i < perBlob; i++) {
      const v = new Float32Array(dim);
      v[c] = 1;
      for (let d = 0; d < dim; d++) v[d] += gauss() * noise;
      vectors.push(v);
      truth.push(c);
    }
  }
  return { vectors, truth };
}

/** Same partition up to label permutation. */
function samePartition(a: number[], b: number[]): boolean {
  const map = new Map<number, number>();
  const rev = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    if ((map.has(a[i]) && map.get(a[i]) !== b[i]) || (rev.has(b[i]) && rev.get(b[i]) !== a[i])) return false;
    map.set(a[i], b[i]);
    rev.set(b[i], a[i]);
  }
  return true;
}

describe("prng", () => {
  it("is deterministic and in [0,1)", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(hashSeed("topic-1")).toBe(hashSeed("topic-1"));
    expect(hashSeed("topic-1")).not.toBe(hashSeed("topic-2"));
  });
});

describe("silhouette", () => {
  it("matches a hand-computed value", () => {
    // Unit vectors at 0°, 10° (cluster 0) and 90° (cluster 1).
    const r = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    const vs = [r(0), r(10), r(90)];
    const d = (x: number[], y: number[]) => 1 - (x[0] * y[0] + x[1] * y[1]);
    const s0 = 1 - d(vs[0], vs[1]) / d(vs[0], vs[2]);
    const s1 = 1 - d(vs[1], vs[0]) / d(vs[1], vs[2]);
    expect(silhouette(vs, [0, 0, 1])).toBeCloseTo((s0 + s1 + 0) / 3, 6);
  });

  it("is 0 for a single cluster and ~1 for tight separated clusters", () => {
    const vs = [[1, 0], [1, 0.001], [0, 1], [0.001, 1]];
    expect(silhouette(vs, [0, 0, 0, 0])).toBe(0);
    expect(silhouette(vs, [0, 0, 1, 1])).toBeGreaterThan(0.99);
    expect(silhouette(vs, [0, 1, 0, 1])).toBeLessThan(0);
  });
});

describe("kmeans / chooseK", () => {
  it("recovers separated blobs and picks the right k", () => {
    for (const k of [3, 5]) {
      const { vectors, truth } = blobs(k, 12);
      const res = chooseK(vectors, [2, 8], 42);
      expect(res.k).toBe(k);
      expect(samePartition(res.labels, truth)).toBe(true);
      expect(res.silhouette).toBeGreaterThan(0.5);
      expect(res.centroids).toHaveLength(k);
    }
  });

  it("is deterministic for a seed", () => {
    const { vectors } = blobs(4, 10, 16, 0.4);
    const a = chooseK(vectors, [2, 7], 99);
    const b = chooseK(vectors, [2, 7], 99);
    expect(a.labels).toEqual(b.labels);
    expect(a.scores).toEqual(b.scores);
    expect(kmeans(vectors, 4, { seed: 3 }).labels).toEqual(kmeans(vectors, 4, { seed: 3 }).labels);
  });

  it("clamps k to n and handles tiny inputs", () => {
    const { vectors } = blobs(2, 2);
    expect(kmeans(vectors, 10).k).toBe(4);
    const one = chooseK(vectors.slice(0, 2), [3, 6], 1);
    expect(one.k).toBe(1);
    expect(one.labels).toEqual([0, 0]);
    expect(chooseK([], [2, 4]).k).toBe(0);
  });

  it("merges clusters smaller than the minimum into the nearest centroid", () => {
    const { vectors } = blobs(3, 6, 8, 0.05);
    // A near-copy of blob 2 labelled as its own 2-member cluster.
    const extra = [Float32Array.from(vectors[12]), Float32Array.from(vectors[13])];
    const all = [...vectors, ...extra];
    const labels = [...new Array(6).fill(0), ...new Array(6).fill(2), ...new Array(6).fill(3), 1, 1];
    const merged = mergeSmallClusters(all, labels, 3);
    expect(merged.k).toBe(3);
    // Contiguous, order-preserving: old 0->0, 2->1, 3->2; the small cluster joins blob 2 (old label 3 -> 2).
    expect(merged.labels.slice(0, 18)).toEqual([...new Array(6).fill(0), ...new Array(6).fill(1), ...new Array(6).fill(2)]);
    expect(merged.labels.slice(18)).toEqual([2, 2]);
    expect(merged.centroids).toHaveLength(3);
  });
});
