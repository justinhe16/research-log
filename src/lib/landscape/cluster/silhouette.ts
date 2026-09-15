/*
 * Vector helpers + mean silhouette coefficient under cosine distance.
 * Pure and synchronous. The distance matrix is O(n²·d) once; each silhouette
 * evaluation on it is O(n²), so scanning several k for n≈350 stays cheap.
 */

export type Vec = Float32Array | readonly number[];

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** L2-normalized copy. A zero vector stays zero. */
export function normalize(v: Vec): Float32Array {
  const out = Float32Array.from(v);
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Cosine similarity for arbitrary (not necessarily normalized) vectors. */
export function cosineSim(a: Vec, b: Vec): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Cosine distance (1 - cos) for already-normalized vectors. */
export function cosineDistance(a: Vec, b: Vec): number {
  return 1 - dot(a, b);
}

/** Symmetric n×n cosine-distance matrix, row-major. Normalizes internally. */
export function cosineDistanceMatrix(vectors: readonly Vec[]): Float64Array {
  const n = vectors.length;
  const units = vectors.map(normalize);
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.max(0, 1 - dot(units[i], units[j]));
      m[i * n + j] = d;
      m[j * n + i] = d;
    }
  }
  return m;
}

/**
 * Mean silhouette from a precomputed distance matrix. Points in singleton
 * clusters score 0 (standard convention). Fewer than 2 clusters => 0.
 */
export function silhouetteFromMatrix(labels: readonly number[], dist: Float64Array): number {
  const n = labels.length;
  if (n === 0) return 0;
  let k = 0;
  for (const l of labels) k = Math.max(k, l + 1);
  const sizes = new Array<number>(k).fill(0);
  for (const l of labels) sizes[l]++;
  if (sizes.filter((s) => s > 0).length < 2) return 0;

  const sums = new Float64Array(k);
  let total = 0;
  for (let i = 0; i < n; i++) {
    sums.fill(0);
    for (let j = 0; j < n; j++) if (j !== i) sums[labels[j]] += dist[i * n + j];
    const own = labels[i];
    if (sizes[own] <= 1) continue;
    const a = sums[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || sizes[c] === 0) continue;
      b = Math.min(b, sums[c] / sizes[c]);
    }
    const denom = Math.max(a, b);
    total += denom > 0 ? (b - a) / denom : 0;
  }
  return total / n;
}

/** Mean silhouette coefficient (cosine distance) for `labels` over `vectors`. */
export function silhouette(vectors: readonly Vec[], labels: readonly number[]): number {
  return silhouetteFromMatrix(labels, cosineDistanceMatrix(vectors));
}
