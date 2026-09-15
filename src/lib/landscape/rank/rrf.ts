import { RRF_K } from "../constants";

export type RrfResult = {
  id: string;
  score: number;
  /** 1-based rank of this id in each ranking that contains it, keyed by the
   *  ranking's name (Map input) or its index as a string (array input). */
  ranks: Record<string, number>;
};

type Ranking = readonly { id: string }[];

/**
 * Reciprocal rank fusion: score(id) = sum over rankings of 1 / (k + rank).
 * Duplicate ids within one ranking count once, at their best rank. Output is
 * sorted by score descending; ties are broken by first appearance (earlier
 * rankings first, then position), so the result is deterministic.
 */
export function rrfFuse(
  rankings: readonly Ranking[] | ReadonlyMap<string, Ranking>,
  k: number = RRF_K,
): RrfResult[] {
  const entries: [string, Ranking][] =
    rankings instanceof Map
      ? [...rankings.entries()]
      : (rankings as readonly Ranking[]).map((r, i) => [String(i), r]);

  const byId = new Map<string, RrfResult & { order: number }>();
  for (const [name, ranking] of entries) {
    ranking.forEach(({ id }, pos) => {
      let row = byId.get(id);
      if (!row) {
        row = { id, score: 0, ranks: {}, order: byId.size };
        byId.set(id, row);
      }
      if (row.ranks[name] !== undefined) return;
      row.ranks[name] = pos + 1;
      row.score += 1 / (k + pos + 1);
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ id, score, ranks }) => ({ id, score, ranks }));
}
