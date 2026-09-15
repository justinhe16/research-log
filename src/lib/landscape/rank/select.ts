import {
  DUPLICATE_COSINE,
  FRONTIER_MONTHS,
  INFLUENCE_PRIOR_WEIGHTS,
  MMR_SIM_FLOOR,
  MMR_WEIGHT,
  RESERVE_MIN_RELEVANCE_RATIO,
  SELECTION_WEIGHTS,
} from "../constants";
import { percentileRanks, velocity } from "../graph/metrics";

export type SelectRow = {
  paperId: string;
  /** Calibrated relevance 0..1 (cross-encoder or cosine fallback); null if not reranked. */
  rerank: number | null;
  rrf: number;
  /** Total citations; null if unknown. Feeds the influence prior. */
  citationCount?: number | null;
  /** ISO date (or year-only string); null if unknown. Recency + velocity. */
  publishedAt?: string | null;
  /** Unit-length or raw embedding for diversity / duplicate checks. */
  embedding?: Float32Array | null;
  /** Title; an identical normalized title marks a duplicate record (preprint + journal copy). */
  title?: string | null;
};

export type SelectOptions = {
  selectCount: number;
  foundationalReserve: number;
  /** Slots for the most relevant recent papers. Default 0. */
  frontierReserve?: number;
  /** Clock for recency and velocity. Default: now. */
  now?: Date;
};

export type SelectResult = {
  /** Selected paper ids, in final-rank order (selection score desc). */
  selected: string[];
  /** 1-based rank for every input row: selected first, then the rest by score. */
  finalRank: Map<string, number>;
  /** Ids chosen by the foundational reserve (older, most-cited relevant papers). */
  foundational: string[];
  /** Ids chosen by the frontier reserve (recent, most relevant papers). */
  frontier: string[];
  /** Selection score per scored row (relevance + influence prior, before diversity). */
  scores: Map<string, number>;
  /** Ids skipped as near-duplicates of an already selected paper. */
  duplicates: string[];
};

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

function dateMs(publishedAt: string | null | undefined): number | null {
  if (!publishedAt) return null;
  const s = /^\d{4}$/.test(publishedAt) ? `${publishedAt}-07-01` : publishedAt;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function cos(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Influence prior 0..1 per row: INFLUENCE_PRIOR_WEIGHTS blend of within-list percentiles of
 * log1p(citations) and velocity. Rows with unknown citations get null (treated as 0 when
 * scoring, and never eligible for the foundational reserve).
 */
export function influencePrior(rows: readonly Pick<SelectRow, "citationCount" | "publishedAt">[], now: Date): (number | null)[] {
  const cites = percentileRanks(rows.map((r) => (r.citationCount == null ? null : Math.log1p(Math.max(0, r.citationCount)))));
  const vel = percentileRanks(rows.map((r) => velocity(r.citationCount, dateMs(r.publishedAt) != null ? new Date(dateMs(r.publishedAt)!) : null, now)));
  const w = INFLUENCE_PRIOR_WEIGHTS;
  return rows.map((r, i) => (r.citationCount == null ? null : (w.citations * cites[i] + w.velocity * vel[i]) / (w.citations + w.velocity)));
}

/**
 * Select `selectCount` papers.
 *
 * Scored rows are the reranked ones (or, when nothing was reranked, every row with its rrf
 * min-max scaled into 0..1 as relevance). For each:
 *   score = SELECTION_WEIGHTS.relevance * relevance + SELECTION_WEIGHTS.influence * prior
 * where prior is `influencePrior` (0 when citations are unknown).
 *
 * "Relevant" = relevance >= RESERVE_MIN_RELEVANCE_RATIO * best relevance. Then, in order:
 *  1. Foundational reserve: up to `foundationalReserve` relevant papers older than
 *     FRONTIER_MONTHS with known citations, most-cited first (log-citation percentile).
 *  2. Frontier reserve: up to `frontierReserve` relevant papers from the last FRONTIER_MONTHS,
 *     most relevant first -- so highly relevant new work gets in despite having no citations.
 *  3. Fill: greedily by score minus an MMR-style redundancy penalty against the papers already
 *     picked (only similarity above MMR_SIM_FLOOR counts). Un-scored rows (in a reranked pool)
 *     only fill slots left over, by rrf.
 * Candidates with cosine >= DUPLICATE_COSINE to a picked paper, or the same normalized
 * title, are skipped at every step.
 * Final order is score desc among the selected; the rest follow by score, then rrf.
 */
export function selectPapers(rows: readonly SelectRow[], opts: SelectOptions): SelectResult {
  const selectCount = Math.max(0, Math.floor(opts.selectCount));
  const foundationalSlots = Math.max(0, Math.min(Math.floor(opts.foundationalReserve), selectCount));
  const frontierSlots = Math.max(0, Math.min(Math.floor(opts.frontierReserve ?? 0), selectCount - foundationalSlots));
  const now = opts.now ?? new Date();

  // Dedupe by paperId, first occurrence wins; keep input order for tie-breaks.
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.paperId) ? false : (seen.add(r.paperId), true)));
  const inputIdx = new Map(unique.map((r, i) => [r.paperId, i]));

  const anyReranked = unique.some((r) => r.rerank !== null);
  let relevance: Map<string, number>;
  let scoredRows: SelectRow[];
  if (anyReranked) {
    scoredRows = unique.filter((r) => r.rerank !== null);
    relevance = new Map(scoredRows.map((r) => [r.paperId, r.rerank!]));
  } else {
    scoredRows = unique;
    const lo = Math.min(...unique.map((r) => r.rrf));
    const hi = Math.max(...unique.map((r) => r.rrf));
    relevance = new Map(unique.map((r) => [r.paperId, hi > lo ? (r.rrf - lo) / (hi - lo) : 1]));
  }
  const unscored = unique.filter((r) => !relevance.has(r.paperId));

  const priors = influencePrior(scoredRows, now);
  const prior = new Map(scoredRows.map((r, i) => [r.paperId, priors[i]]));
  const citePct = percentileRanks(scoredRows.map((r) => (r.citationCount == null ? null : Math.log1p(Math.max(0, r.citationCount)))));
  const citeRank = new Map(scoredRows.map((r, i) => [r.paperId, citePct[i]]));
  const scores = new Map<string, number>();
  for (const r of scoredRows) {
    scores.set(r.paperId, SELECTION_WEIGHTS.relevance * relevance.get(r.paperId)! + SELECTION_WEIGHTS.influence * (prior.get(r.paperId) ?? 0));
  }

  const byScore = (a: SelectRow, b: SelectRow) =>
    scores.get(b.paperId)! - scores.get(a.paperId)! ||
    relevance.get(b.paperId)! - relevance.get(a.paperId)! ||
    b.rrf - a.rrf ||
    inputIdx.get(a.paperId)! - inputIdx.get(b.paperId)!;
  const ordered = [...scoredRows].sort(byScore);

  const bestRelevance = Math.max(0, ...relevance.values());
  const isRelevant = (r: SelectRow) => relevance.get(r.paperId)! >= RESERVE_MIN_RELEVANCE_RATIO * bestRelevance;
  const recentCutoff = now.getTime() - FRONTIER_MONTHS * MS_PER_MONTH;
  const isRecent = (r: SelectRow) => {
    const t = dateMs(r.publishedAt);
    return t != null && t >= recentCutoff;
  };

  const picked: SelectRow[] = [];
  const pickedIds = new Set<string>();
  const duplicates = new Set<string>();
  const maxSim = (r: SelectRow) => {
    if (!r.embedding) return 0;
    let best = 0;
    for (const p of picked) if (p.embedding) best = Math.max(best, cos(r.embedding, p.embedding));
    return best;
  };
  const pickedTitles = new Set<string>();
  const titleKey = (r: SelectRow) => (r.title ? r.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "");
  const isDuplicate = (r: SelectRow) => {
    const key = titleKey(r);
    return (key !== "" && pickedTitles.has(key)) || maxSim(r) >= DUPLICATE_COSINE;
  };
  const tryPick = (r: SelectRow): boolean => {
    if (pickedIds.has(r.paperId) || duplicates.has(r.paperId)) return false;
    if (isDuplicate(r)) {
      duplicates.add(r.paperId);
      return false;
    }
    picked.push(r);
    pickedIds.add(r.paperId);
    const key = titleKey(r);
    if (key) pickedTitles.add(key);
    return true;
  };

  // 1. Foundational reserve.
  const foundational: string[] = [];
  const foundationalCandidates = ordered
    .filter((r) => r.citationCount != null && isRelevant(r) && !isRecent(r))
    .sort((a, b) => citeRank.get(b.paperId)! - citeRank.get(a.paperId)! || byScore(a, b));
  for (const r of foundationalCandidates) {
    if (foundational.length >= foundationalSlots || picked.length >= selectCount) break;
    if (tryPick(r)) foundational.push(r.paperId);
  }

  // 2. Frontier reserve.
  const frontier: string[] = [];
  const frontierCandidates = ordered
    .filter((r) => isRelevant(r) && isRecent(r))
    .sort((a, b) => relevance.get(b.paperId)! - relevance.get(a.paperId)! || byScore(a, b));
  for (const r of frontierCandidates) {
    if (frontier.length >= frontierSlots || picked.length >= selectCount) break;
    if (tryPick(r)) frontier.push(r.paperId);
  }

  // 3. Fill by score with a redundancy penalty.
  const remaining = ordered.filter((r) => !pickedIds.has(r.paperId));
  while (picked.length < selectCount && remaining.length > 0) {
    let bestIdx = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      const sim = maxSim(r);
      if (isDuplicate(r)) {
        duplicates.add(r.paperId);
        remaining.splice(i--, 1);
        continue;
      }
      const redundancy = Math.max(0, sim - MMR_SIM_FLOOR) / (1 - MMR_SIM_FLOOR);
      const value = scores.get(r.paperId)! - MMR_WEIGHT * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    tryPick(remaining.splice(bestIdx, 1)[0]);
  }
  // Un-scored rows only fill what is left, by rrf.
  const byRrf = [...unscored].sort((a, b) => b.rrf - a.rrf || inputIdx.get(a.paperId)! - inputIdx.get(b.paperId)!);
  for (const r of byRrf) {
    if (picked.length >= selectCount) break;
    tryPick(r);
  }

  const rankOrder = (a: SelectRow, b: SelectRow) => {
    const sa = scores.get(a.paperId);
    const sb = scores.get(b.paperId);
    if (sa != null && sb != null) return byScore(a, b);
    if (sa != null) return -1;
    if (sb != null) return 1;
    return b.rrf - a.rrf || inputIdx.get(a.paperId)! - inputIdx.get(b.paperId)!;
  };
  const selected = [...picked].sort(rankOrder).map((r) => r.paperId);
  const finalRank = new Map<string, number>();
  selected.forEach((id, i) => finalRank.set(id, i + 1));
  for (const r of [...unique].sort(rankOrder)) {
    if (!finalRank.has(r.paperId)) finalRank.set(r.paperId, finalRank.size + 1);
  }

  return { selected, finalRank, foundational, frontier, scores, duplicates: [...duplicates] };
}
