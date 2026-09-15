export type SelectRow = {
  paperId: string;
  /** Cross-encoder score (or cosine fallback); null if the paper wasn't reranked. */
  rerank: number | null;
  rrf: number;
  /** 0..1; null if unknown (not enriched yet). */
  influence: number | null;
};

export type SelectOptions = {
  selectCount: number;
  foundationalReserve: number;
  /** Reserve candidates need a relevance score at or above this percentile. Default 0.25. */
  floorPercentile?: number;
};

export type SelectResult = {
  /** Selected paper ids, in final-rank order. */
  selected: string[];
  /** 1-based rank for every input row: selected first, then the rest by relevance. */
  finalRank: Map<string, number>;
  /** Ids that entered through the foundational reserve. */
  foundational: string[];
};

/** Lower nearest-rank percentile of `values` (p in 0..1). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return -Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(Math.min(1, Math.max(0, p)) * (sorted.length - 1));
  return sorted[idx];
}

/**
 * Relevance order: reranked rows by rerank desc, then un-reranked rows by rrf
 * desc (rrf also breaks rerank ties; input order breaks the rest).
 *
 * Take the top `selectCount`. Then the foundational reserve: up to
 * `foundationalReserve` of the bottom slots are swapped for the highest-influence
 * unselected papers whose relevance clears the floor (the `floorPercentile` of
 * rerank scores; of rrf scores when nothing was reranked). A swap only happens
 * when the candidate's influence beats the influence of the row it displaces, so
 * the reserve never makes the set less influential. Reranked-mixed pools don't
 * admit un-reranked candidates (no comparable score to check against the floor).
 * Final order is relevance order among the selected papers.
 */
export function selectPapers(rows: readonly SelectRow[], opts: SelectOptions): SelectResult {
  const selectCount = Math.max(0, Math.floor(opts.selectCount));
  const reserve = Math.max(0, Math.min(Math.floor(opts.foundationalReserve), selectCount));
  const floorP = opts.floorPercentile ?? 0.25;

  // Dedupe by paperId, first occurrence wins.
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.paperId) ? false : (seen.add(r.paperId), true)));

  const indexed = unique.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    const ar = a.row.rerank;
    const br = b.row.rerank;
    if (ar !== null && br !== null && ar !== br) return br - ar;
    if (ar !== null && br === null) return -1;
    if (ar === null && br !== null) return 1;
    return b.row.rrf - a.row.rrf || a.i - b.i;
  });
  const ordered = indexed.map((x) => x.row);
  const position = new Map(ordered.map((r, i) => [r.paperId, i]));

  const anyReranked = ordered.some((r) => r.rerank !== null);
  const relevance = (r: SelectRow): number | null => (anyReranked ? r.rerank : r.rrf);
  const floor = percentile(
    ordered.map(relevance).filter((v): v is number => v !== null),
    floorP,
  );

  const selected = ordered.slice(0, selectCount);
  const foundational: string[] = [];

  if (reserve > 0 && selected.length === selectCount) {
    const candidates = ordered
      .slice(selectCount)
      .filter((r) => {
        const rel = relevance(r);
        return r.influence !== null && rel !== null && rel >= floor;
      })
      .sort((a, b) => b.influence! - a.influence! || position.get(a.paperId)! - position.get(b.paperId)!);

    // The bottom `reserve` slots, weakest influence first (unknown counts as weakest).
    const inf = (r: SelectRow) => r.influence ?? -Infinity;
    const window = selected
      .slice(selectCount - reserve)
      .sort((a, b) => inf(a) - inf(b) || position.get(b.paperId)! - position.get(a.paperId)!);
    // Candidates fall and displaced rows rise, so the first failed pair ends it.
    const swaps = Math.min(window.length, candidates.length);
    const out = new Set<string>();
    for (let j = 0; j < swaps; j++) {
      if (candidates[j].influence! <= inf(window[j])) break;
      out.add(window[j].paperId);
      foundational.push(candidates[j].paperId);
    }
    const kept = selected.filter((r) => !out.has(r.paperId));
    selected.length = 0;
    selected.push(...kept, ...candidates.slice(0, foundational.length));
  }

  selected.sort((a, b) => position.get(a.paperId)! - position.get(b.paperId)!);
  const selectedIds = selected.map((r) => r.paperId);
  const selectedSet = new Set(selectedIds);

  const finalRank = new Map<string, number>();
  selectedIds.forEach((id, i) => finalRank.set(id, i + 1));
  for (const r of ordered) {
    if (!selectedSet.has(r.paperId)) finalRank.set(r.paperId, finalRank.size + 1);
  }

  return { selected: selectedIds, finalRank, foundational };
}
