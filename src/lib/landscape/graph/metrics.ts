import { GAME_CHANGER_CANDIDATES, INFLUENCE_WEIGHTS } from "../constants";

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

/**
 * Citations per year since publication. Paper age is floored at `floorMonths` so
 * brand-new papers with a handful of citations don't get absurd velocities.
 * Returns null when either input is missing or the date is unparseable.
 */
export function velocity(
  citationCount: number | null | undefined,
  publishedAt: string | Date | null | undefined,
  now: Date = new Date(),
  floorMonths = 3,
): number | null {
  if (citationCount == null || publishedAt == null) return null;
  const published = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  const t = published.getTime();
  if (Number.isNaN(t)) return null;
  const months = Math.max(floorMonths, (now.getTime() - t) / MS_PER_MONTH);
  if (months <= 0) return null;
  return citationCount / (months / 12);
}

/**
 * Percentile rank (0..1) of each value within the list. Nulls (and non-finite
 * values) get 0 and don't count toward the distribution. Ties share the average
 * of their positions, so an all-equal list maps to 0.5. A single non-null value
 * maps to 1.
 */
export function percentileRanks(values: (number | null | undefined)[]): number[] {
  const present = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v != null && Number.isFinite(x.v))
    .sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  const m = present.length;
  if (m === 0) return out;
  if (m === 1) {
    out[present[0].i] = 1;
    return out;
  }
  let start = 0;
  while (start < m) {
    let end = start;
    while (end + 1 < m && present[end + 1].v === present[start].v) end++;
    const pct = (start + end) / 2 / (m - 1);
    for (let k = start; k <= end; k++) out[present[k].i] = pct;
    start = end + 1;
  }
  return out;
}

export type InfluenceRow = {
  id: string;
  citationCount: number | null;
  velocity: number | null;
  influentialCitationCount: number | null;
  pagerank: number | null;
  maxAuthorHIndex: number | null;
};

/**
 * Influence 0..1 = INFLUENCE_WEIGHTS-weighted blend of within-pool percentiles
 * (citations via log1p, velocity, influential citations, PageRank, max author h-index).
 */
export function influenceScores(rows: InfluenceRow[]): Map<string, number> {
  const cites = percentileRanks(rows.map((r) => (r.citationCount == null ? null : Math.log1p(Math.max(0, r.citationCount)))));
  const vel = percentileRanks(rows.map((r) => r.velocity));
  const infl = percentileRanks(rows.map((r) => r.influentialCitationCount));
  const pr = percentileRanks(rows.map((r) => r.pagerank));
  const h = percentileRanks(rows.map((r) => r.maxAuthorHIndex));
  const w = INFLUENCE_WEIGHTS;
  const total = w.citations + w.velocity + w.influential + w.pagerank + w.hIndex;
  const out = new Map<string, number>();
  rows.forEach((r, i) => {
    const score =
      (w.citations * cites[i] + w.velocity * vel[i] + w.influential * infl[i] + w.pagerank * pr[i] + w.hIndex * h[i]) / total;
    out.set(r.id, Math.min(1, Math.max(0, score)));
  });
  return out;
}

export type GameChangerRow = Pick<InfluenceRow, "id" | "citationCount" | "velocity" | "pagerank">;

/**
 * Game-changer candidates: among papers with citations >= the pool median (nulls
 * count as 0), the top `count` by 0.5 * pagerank percentile + 0.5 * velocity
 * percentile (percentiles over the whole pool). Ties break by id. Returns ids.
 */
export function gameChangerCandidates(
  rows: GameChangerRow[],
  { count = GAME_CHANGER_CANDIDATES }: { count?: number } = {},
): string[] {
  if (rows.length === 0 || count <= 0) return [];
  const pr = percentileRanks(rows.map((r) => r.pagerank));
  const vel = percentileRanks(rows.map((r) => r.velocity));
  const cites = rows.map((r) => r.citationCount ?? 0);
  const med = median(cites);
  return rows
    .map((r, i) => ({ id: r.id, cites: cites[i], score: 0.5 * pr[i] + 0.5 * vel[i] }))
    .filter((x) => x.cites >= med)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, count)
    .map((x) => x.id);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
