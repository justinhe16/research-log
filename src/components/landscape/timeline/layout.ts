import type { ClusterDTO, EdgeDTO, PaperLite } from "@/lib/landscape/types";
import type { NarrativeDocument } from "@/lib/landscape/llm/synthesize/schemas";

/*
 * Pure layout math for the Timeline tab: lane order, time domain, circle packing,
 * era bands and lineage paths. No React, no DOM -- everything is a function of
 * the snapshot and the plot width so it is deterministic and unit-tested.
 */

export const UNCLUSTERED_LANE = -1;

export const LAYOUT = {
  /** Circle radius range, mapped from sqrt(influence). */
  rMin: 3.5,
  rMax: 12,
  /** Minimum clearance between two circles. */
  gap: 1.5,
  /** Vertical search step when a spot is taken. */
  step: 2,
  /** Vertical padding inside a lane, above and below the packed circles. */
  lanePad: 12,
  laneMin: 72,
  /** Dense lanes stop growing here; extra papers jitter sideways, then collapse into "+N". */
  laneMax: 180,
  /** Room kept at the bottom of a lane for "+N" markers. */
  markerRow: 18,
  /** Horizontal jitter step and number of steps each side when a lane is full. */
  jitterStep: 3,
  jitterSteps: 3,
  /** Width of the x buckets that overflow papers are grouped into. */
  markerBucket: 28,
  /** Neighbouring "+N" markers closer than this merge into one. */
  markerMinGap: 36,
  /** Space reserved above the lanes for era labels and game-changer stars. */
  top: 44,
  /** Game-changer star, measured up from `top`. */
  starOffset: 15,
  /** Space below the lanes for the year axis. */
  bottom: 34,
  /** Horizontal padding inside the plot so edge circles are not clipped. */
  padX: 18,
} as const;

export type Lane = {
  /** Cluster idx, or UNCLUSTERED_LANE. */
  idx: number;
  label: string;
  /** CSS color, e.g. var(--chart-2). */
  color: string;
  /** Papers in this lane with a usable date (placed or collapsed into "+N"). */
  size: number;
  /** Total papers in the cluster (including undated). */
  total: number;
  y: number;
  height: number;
};

export type PlacedPaper = {
  paper: PaperLite;
  laneIdx: number;
  /** Fractional year, e.g. 2023.71. */
  t: number;
  x: number;
  y: number;
  r: number;
};

/** Papers that did not fit a dense lane, collapsed into one "+N" marker. */
export type OverflowMarker = {
  id: string;
  laneIdx: number;
  x: number;
  y: number;
  papers: PaperLite[];
};

export type EraBand = {
  label: string;
  summary: string;
  startYear: number;
  endYear: number | null;
  x0: number;
  x1: number;
  /** Label truncated to fit the band width. */
  shortLabel: string;
};

export type LineageEdge = {
  id: string;
  source: string;
  target: string;
  path: string;
};

export type TimelineLayout = {
  width: number;
  height: number;
  /** Fractional-year domain [min, max]. */
  domain: [number, number];
  lanes: Lane[];
  placed: PlacedPaper[];
  overflow: OverflowMarker[];
  byId: Map<string, PlacedPaper>;
  undated: PaperLite[];
  eras: EraBand[];
  edges: LineageEdge[];
  /** Integer years to tick on the axis. */
  years: number[];
  plotTop: number;
  plotBottom: number;
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** A paper's position in fractional years, or null when it has no date. */
export function paperYearFraction(paper: Pick<PaperLite, "publishedAt" | "year">): number | null {
  if (paper.publishedAt) {
    const m = paper.publishedAt.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (m) {
      const y = Number(m[1]);
      const month = m[2] ? Math.min(12, Math.max(1, Number(m[2]))) : null;
      const day = m[3] ? Math.min(31, Math.max(1, Number(m[3]))) : 15;
      if (month === null) return y + 0.5;
      return y + (month - 1) / 12 + (day - 1) / 365;
    }
  }
  return paper.year ? paper.year + 0.5 : null;
}

/** Whole-year domain covering every paper and era, padded by a little on each side. */
export function timeDomain(times: number[], eras: Pick<EraBand, "startYear" | "endYear">[] = []): [number, number] {
  const all = [...times];
  for (const e of eras) {
    all.push(e.startYear);
    if (e.endYear !== null) all.push(e.endYear + 1);
  }
  if (all.length === 0) {
    const now = new Date().getUTCFullYear();
    return [now - 1, now + 1];
  }
  let lo = Math.floor(Math.min(...all));
  let hi = Math.ceil(Math.max(...all));
  if (hi <= lo) hi = lo + 1;
  // A single-year span reads poorly; widen to at least two years.
  if (hi - lo < 2) lo -= 1;
  return [lo, hi];
}

export function makeXScale(domain: [number, number], width: number, padX: number = LAYOUT.padX) {
  const [d0, d1] = domain;
  const r0 = padX;
  const r1 = Math.max(padX + 1, width - padX);
  return (t: number) => r0 + ((t - d0) / (d1 - d0 || 1)) * (r1 - r0);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export function radiusFor(influence: number): number {
  const v = Number.isFinite(influence) ? Math.max(0, Math.min(1, influence)) : 0;
  return LAYOUT.rMin + Math.sqrt(v) * (LAYOUT.rMax - LAYOUT.rMin);
}

/**
 * Lane order: clusters sorted by when they start (earliest dated paper), so the
 * chart reads as a cascade from the oldest thread to the newest. Ties break on
 * cluster idx. Clusters with no dated papers are dropped; papers without a
 * cluster share one lane at the bottom.
 */
export function assignLanes(
  papers: PaperLite[],
  clusters: ClusterDTO[],
  colorOf: (cluster: ClusterDTO) => string,
): { idx: number; label: string; color: string; total: number; papers: { paper: PaperLite; t: number }[] }[] {
  const known = new Map(clusters.map((c) => [c.idx, c]));
  const buckets = new Map<number, { paper: PaperLite; t: number }[]>();
  const totals = new Map<number, number>();
  for (const paper of papers) {
    const laneIdx = paper.clusterIdx !== null && known.has(paper.clusterIdx) ? paper.clusterIdx : UNCLUSTERED_LANE;
    totals.set(laneIdx, (totals.get(laneIdx) ?? 0) + 1);
    const t = paperYearFraction(paper);
    if (t === null) continue;
    const list = buckets.get(laneIdx) ?? [];
    list.push({ paper, t });
    buckets.set(laneIdx, list);
  }

  const lanes = [...buckets.entries()].map(([idx, list]) => {
    const cluster = known.get(idx);
    return {
      idx,
      label: cluster?.label ?? "Unclustered",
      color: cluster ? colorOf(cluster) : "var(--muted-foreground)",
      total: totals.get(idx) ?? list.length,
      start: Math.min(...list.map((p) => p.t)),
      papers: list,
    };
  });
  lanes.sort((a, b) => {
    if (a.idx === UNCLUSTERED_LANE) return 1;
    if (b.idx === UNCLUSTERED_LANE) return -1;
    return a.start - b.start || a.idx - b.idx;
  });
  return lanes.map(({ idx, label, color, total, papers }) => ({ idx, label, color, total, papers }));
}

export type PackItem = { id: string; x: number; r: number; influence: number; t: number };
export type PackResult = {
  /** Offsets from the item's time position (dx) and the lane centre (dy). */
  offsets: Map<string, { dx: number; dy: number }>;
  /** Ids that found no free spot within `maxExtent`, least influential last. */
  overflow: string[];
};

/**
 * Deterministic packing within one lane. Papers are placed in order of influence
 * (then date, then id) so the most influential sit on the centre line. Each later
 * circle takes the free vertical offset closest to the centre (0, -step, +step,
 * ...) while staying within `maxExtent`. When a column is full it tries small
 * horizontal nudges (-j, +j, -2j, ...); a paper that still does not fit overflows.
 */
export function packLane(items: PackItem[], maxExtent: number = Number.POSITIVE_INFINITY): PackResult {
  const order = [...items].sort((a, b) => b.influence - a.influence || a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed: { x: number; y: number; r: number }[] = [];
  const offsets = new Map<string, { dx: number; dy: number }>();
  const overflow: string[] = [];
  const jitters = [0];
  for (let k = 1; k <= LAYOUT.jitterSteps; k++) jitters.push(-k * LAYOUT.jitterStep, k * LAYOUT.jitterStep);

  const free = (x: number, y: number, r: number) =>
    !placed.some((p) => {
      const min = p.r + r + LAYOUT.gap;
      const dx = p.x - x;
      const dy = p.y - y;
      return dx * dx + dy * dy < min * min;
    });

  for (const item of order) {
    let spot: { dx: number; dy: number } | null = null;
    for (const dx of Number.isFinite(maxExtent) ? jitters : [0]) {
      for (let k = 0; k < 4000; k++) {
        const dy = k === 0 ? 0 : (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * LAYOUT.step;
        if (Math.abs(dy) + item.r > maxExtent) break;
        if (free(item.x + dx, dy, item.r)) {
          spot = { dx, dy };
          break;
        }
      }
      if (spot) break;
    }
    if (!spot) {
      overflow.push(item.id);
      continue;
    }
    placed.push({ x: item.x + spot.dx, y: spot.dy, r: item.r });
    offsets.set(item.id, spot);
  }
  return { offsets, overflow };
}

// ---------------------------------------------------------------------------
// Eras & edges
// ---------------------------------------------------------------------------

/** Truncate to roughly fit `px` at ~6.1px per character (11px UI font). */
export function fitLabel(label: string, px: number, charPx = 6.1): string {
  const max = Math.floor(px / charPx);
  if (max < 4) return "";
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function eraBands(
  eras: NarrativeDocument["eras"],
  domain: [number, number],
  x: (t: number) => number,
): EraBand[] {
  return [...eras]
    .sort((a, b) => a.startYear - b.startYear)
    .map((era) => {
      const start = Math.max(domain[0], era.startYear);
      const end = Math.min(domain[1], era.endYear === null ? domain[1] : era.endYear + 1);
      const x0 = x(start);
      const x1 = x(Math.max(start, end));
      return {
        label: era.label,
        summary: era.summary,
        startYear: era.startYear,
        endYear: era.endYear,
        x0,
        x1,
        shortLabel: fitLabel(era.label, x1 - x0 - 12),
      };
    })
    .filter((b) => b.x1 > b.x0);
}

/**
 * Lineage path from the newer paper back to the paper it builds on. Same-lane
 * pairs arc above the lane; cross-lane pairs use a smooth S-curve.
 */
export function lineagePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  if (Math.abs(a.y - b.y) < 14) {
    const lift = Math.min(40, 8 + Math.abs(a.x - b.x) * 0.18);
    const cy = Math.min(a.y, b.y) - lift;
    return `M${f(a.x)},${f(a.y)} C${f(a.x)},${f(cy)} ${f(b.x)},${f(cy)} ${f(b.x)},${f(b.y)}`;
  }
  const mx = (a.x + b.x) / 2;
  return `M${f(a.x)},${f(a.y)} C${f(mx)},${f(a.y)} ${f(mx)},${f(b.y)} ${f(b.x)},${f(b.y)}`;
}

// ---------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------

export function computeTimelineLayout(input: {
  papers: PaperLite[];
  clusters: ClusterDTO[];
  edges: EdgeDTO[];
  eras: NarrativeDocument["eras"];
  width: number;
  colorOf: (cluster: ClusterDTO) => string;
}): TimelineLayout {
  const { papers, clusters, edges, eras, width, colorOf } = input;
  const laneGroups = assignLanes(papers, clusters, colorOf);
  const times = laneGroups.flatMap((l) => l.papers.map((p) => p.t));
  const domain = timeDomain(
    times,
    times.length > 0 ? eras : [],
  );
  const x = makeXScale(domain, width);

  const lanes: Lane[] = [];
  const placed: PlacedPaper[] = [];
  const overflow: OverflowMarker[] = [];
  // Circles may reach this far from the lane centre; the rest of a max-height
  // lane is padding plus the "+N" marker row.
  const maxExtent = LAYOUT.laneMax / 2 - LAYOUT.lanePad - LAYOUT.markerRow / 2;
  let cursor = LAYOUT.top;
  for (const group of laneGroups) {
    const items = group.papers.map(({ paper, t }) => ({ id: paper.id, x: x(t), r: radiusFor(paper.influence), influence: paper.influence, t }));
    const packed = packLane(items, maxExtent);
    let extent = 0;
    for (const item of items) {
      const o = packed.offsets.get(item.id);
      if (o) extent = Math.max(extent, Math.abs(o.dy) + item.r);
    }
    const height = packed.overflow.length > 0 ? LAYOUT.laneMax : Math.max(LAYOUT.laneMin, Math.ceil(2 * (extent + LAYOUT.lanePad)));
    const center = cursor + (packed.overflow.length > 0 ? (height - LAYOUT.markerRow) / 2 : height / 2);
    lanes.push({ idx: group.idx, label: group.label, color: group.color, size: items.length, total: group.total, y: cursor, height });
    group.papers.forEach(({ paper, t }, i) => {
      const item = items[i];
      const o = packed.offsets.get(paper.id);
      if (o) placed.push({ paper, laneIdx: group.idx, t, x: item.x + o.dx, y: center + o.dy, r: item.r });
    });

    if (packed.overflow.length > 0) {
      const byPaper = new Map(group.papers.map((p, i) => [p.paper.id, { paper: p.paper, x: items[i].x, t: p.t }]));
      const buckets = new Map<number, { paper: PaperLite; x: number; t: number }[]>();
      for (const id of packed.overflow) {
        const entry = byPaper.get(id)!;
        const key = Math.floor(entry.x / LAYOUT.markerBucket);
        buckets.set(key, [...(buckets.get(key) ?? []), entry]);
      }
      // Greedy left-to-right merge so pills never overlap.
      const merged: { key: number; entries: { paper: PaperLite; x: number; t: number }[] }[] = [];
      const meanX = (entries: { x: number }[]) => entries.reduce((sum, e) => sum + e.x, 0) / entries.length;
      for (const [key, entries] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && meanX(entries) - meanX(last.entries) < LAYOUT.markerMinGap) last.entries.push(...entries);
        else merged.push({ key, entries: [...entries] });
      }
      for (const { key, entries } of merged) {
        entries.sort((a, b) => a.t - b.t || b.paper.influence - a.paper.influence || (a.paper.id < b.paper.id ? -1 : 1));
        overflow.push({
          id: `${group.idx}:${key}`,
          laneIdx: group.idx,
          x: Math.round(meanX(entries)),
          y: cursor + height - LAYOUT.markerRow / 2 - 3,
          papers: entries.map((e) => e.paper),
        });
      }
    }
    cursor += height;
  }

  const collapsed = new Set(overflow.flatMap((m) => m.papers.map((p) => p.id)));
  const byId = new Map(placed.map((p) => [p.paper.id, p]));
  const dated = new Set(byId.keys());
  const undated = papers.filter((p) => !dated.has(p.id) && !collapsed.has(p.id));

  const seen = new Set<string>();
  const lineage: LineageEdge[] = [];
  for (const e of edges) {
    if (e.kind !== "builds_on") continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b || a === b) continue;
    const id = `${e.source}->${e.target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lineage.push({ id, source: e.source, target: e.target, path: lineagePath(a, b) });
  }

  const years: number[] = [];
  for (let y = domain[0]; y <= domain[1]; y++) years.push(y);

  return {
    width,
    height: cursor + LAYOUT.bottom,
    domain,
    lanes,
    placed,
    overflow,
    byId,
    undated,
    eras: times.length > 0 ? eraBands(eras, domain, x) : [],
    edges: lineage,
    years,
    plotTop: LAYOUT.top,
    plotBottom: cursor,
  };
}
