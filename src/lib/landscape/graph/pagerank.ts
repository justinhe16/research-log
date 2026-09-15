import { PAGERANK_DAMPING, PAGERANK_ITERATIONS } from "../constants";

export type PagerankEdge = { source: string; target: string };

export type PagerankOptions = {
  damping?: number;
  iterations?: number;
  /** Stop early once the L1 change between iterations falls below this. */
  tol?: number;
};

/**
 * PageRank over a directed graph. Edges run citing -> cited, so authority flows
 * to the cited paper. Edges touching unknown nodes, self-loops, and duplicate
 * edges are ignored. Dangling nodes (no outgoing edges) spread their mass
 * uniformly. Scores sum to 1; an empty graph yields an empty map.
 */
export function pagerank(
  nodes: string[],
  edges: PagerankEdge[],
  { damping = PAGERANK_DAMPING, iterations = PAGERANK_ITERATIONS, tol = 1e-9 }: PagerankOptions = {},
): Map<string, number> {
  const ids = [...new Set(nodes)];
  const n = ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  const index = new Map(ids.map((id, i) => [id, i]));
  const outLinks: Set<number>[] = ids.map(() => new Set());
  for (const { source, target } of edges) {
    const s = index.get(source);
    const t = index.get(target);
    if (s === undefined || t === undefined || s === t) continue;
    outLinks[s].add(t);
  }
  const out = outLinks.map((set) => [...set]);

  let rank = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const targets = out[i];
      if (targets.length === 0) {
        dangling += rank[i];
        continue;
      }
      const share = rank[i] / targets.length;
      for (const t of targets) next[t] += share;
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      next[i] = base + damping * next[i];
      sum += next[i];
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] /= sum; // guard against floating drift
      delta += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (delta < tol) break;
  }

  ids.forEach((id, i) => result.set(id, rank[i]));
  return result;
}
