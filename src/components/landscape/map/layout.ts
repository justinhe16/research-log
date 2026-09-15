import { forceCollide, forceLink, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

import type { ClusterDTO, EdgeDTO, PaperLite } from "@/lib/landscape/types";

/*
 * Deterministic map layout. Runs a d3-force simulation synchronously so the
 * graph is static once rendered: the same snapshot always produces the same
 * picture, and nothing jiggles while you read it.
 */

export const NODE_MIN = 12;
export const NODE_RANGE = 28;
/** Space kept between neighbouring circles, in flow units. */
export const COLLIDE_PADDING = 10;
const TICKS = 150;
const COLLIDE_TICKS = 20;
/** Scale applied to the packed layout's coordinates. */
const SPREAD = 1.6;

/** Circle diameter for a paper (12 + 28·influence). */
export function nodeSize(influence: number): number {
  const v = Number.isFinite(influence) ? Math.max(0, Math.min(1, influence)) : 0;
  return NODE_MIN + NODE_RANGE * v;
}

export type LayoutPoint = { x: number; y: number; size: number };
export type ClusterHalo = { group: number; x: number; y: number; r: number };
export type LayoutResult = {
  /** Circle centers, keyed by paper id. */
  positions: Map<string, LayoutPoint>;
  /** Cluster anchor centers, keyed by cluster idx (-1 for unclustered). */
  anchors: Map<number, { x: number; y: number }>;
  /** A disc enclosing each group's papers, for the faint background halo. */
  halos: ClusterHalo[];
  /** Paper ids whose labels fit without colliding, one set per ZOOM_BANDS entry. */
  labels: ReadonlySet<string>[];
};

/*
 * Labels are drawn at a constant screen size, so how much of the map they
 * cover depends on zoom. Culling is precomputed for a few zoom bands, using
 * each band's lower zoom bound (the most crowded case in that band).
 */
export const ZOOM_BANDS = [
  { minZoom: 0, planZoom: 0.4, maxLabels: 4 },
  { minZoom: 0.6, planZoom: 0.6, maxLabels: 8 },
  { minZoom: 1, planZoom: 1, maxLabels: 12 },
  { minZoom: 1.5, planZoom: 1.5, maxLabels: 40 },
] as const;

export function zoomBandIndex(zoom: number): number {
  let band = 0;
  ZOOM_BANDS.forEach((b, i) => {
    if (zoom >= b.minZoom) band = i;
  });
  return band;
}

export const LABEL_MAX_CHARS = 42;
/** Screen-pixel label metrics (11px Geist, medium). */
const LABEL_CHAR_W = 6;
const LABEL_H = 16;
const LABEL_MAX_W = 168;
/** Gap between a circle's rim and its label, in screen pixels. */
export const LABEL_GAP = 6;

export function labelText(title: string): string {
  return title.length > LABEL_MAX_CHARS ? `${title.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…` : title;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function cullLabels(papers: PaperLite[], positions: Map<string, LayoutPoint>): ReadonlySet<string>[] {
  const byInfluence = [...papers].sort((a, b) => b.influence - a.influence || a.rank - b.rank);
  return ZOOM_BANDS.map(({ planZoom: z, maxLabels }) => {
    const circles: Box[] = [];
    for (const p of papers) {
      const pt = positions.get(p.id)!;
      // Labels may graze a circle's rim, but not cover its middle.
      const r = pt.size * 0.3;
      circles.push({ x0: pt.x - r, y0: pt.y - r, x1: pt.x + r, y1: pt.y + r });
    }
    const placed: Box[] = [];
    const shown = new Set<string>();
    for (const p of byInfluence) {
      if (shown.size >= maxLabels) break;
      const pt = positions.get(p.id)!;
      const w = Math.min(LABEL_MAX_W, labelText(p.title).length * LABEL_CHAR_W + 8) / z;
      const top = pt.y + pt.size / 2 + LABEL_GAP / z;
      const box: Box = { x0: pt.x - w / 2, y0: top, x1: pt.x + w / 2, y1: top + LABEL_H / z };
      if (placed.some((b) => hits(b, box)) || circles.some((c) => hits(c, box))) continue;
      placed.push(box);
      shown.add(p.id);
    }
    return shown;
  });
}

type SimNode = SimulationNodeDatum & { id: string; r: number; group: number; ax: number; ay: number };
type SimLink = SimulationLinkDatum<SimNode>;

/** Small, fast, seedable PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const UNCLUSTERED = -1;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function computeLayout(papers: PaperLite[], clusters: ClusterDTO[] | null | undefined, edges: EdgeDTO[]): LayoutResult {
  const positions = new Map<string, LayoutPoint>();
  const anchors = new Map<number, { x: number; y: number }>();
  if (papers.length === 0) return { positions, anchors, halos: [], labels: ZOOM_BANDS.map(() => new Set<string>()) };

  // Stable order regardless of input order: rank, then id.
  const ordered = [...papers].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const known = new Set((clusters ?? []).map((c) => c.idx));
  const groupOf = (p: PaperLite) => (p.clusterIdx !== null && known.has(p.clusterIdx) ? p.clusterIdx : UNCLUSTERED);

  // --- anchors on a circle, spaced by each cluster's footprint ---------------
  const members = new Map<number, PaperLite[]>();
  for (const p of ordered) {
    const g = groupOf(p);
    const list = members.get(g);
    if (list) list.push(p);
    else members.set(g, [p]);
  }
  const groups = [...members.keys()].sort((a, b) => a - b);
  const footprint = new Map<number, number>();
  for (const g of groups) {
    const area = members.get(g)!.reduce((sum, p) => sum + (nodeSize(p.influence) / 2 + COLLIDE_PADDING) ** 2, 0);
    // Radius of a disc that packs the cluster at ~60% density.
    footprint.set(g, Math.sqrt(area / 0.6));
  }
  const gap = 110;
  const circumference = groups.reduce((sum, g) => sum + 2 * footprint.get(g)! + gap, 0);
  const ringRadius = groups.length <= 1 ? 0 : Math.max(circumference / (2 * Math.PI), Math.max(...footprint.values()) * 1.25);
  let angle = -Math.PI / 2;
  for (const g of groups) {
    const arc = (2 * footprint.get(g)! + gap) / Math.max(circumference, 1);
    const mid = angle + arc * Math.PI;
    anchors.set(g, { x: ringRadius * Math.cos(mid), y: ringRadius * Math.sin(mid) });
    angle += arc * 2 * Math.PI;
  }

  // --- seeded initial positions: phyllotaxis around each anchor ----------------
  const nodes: SimNode[] = [];
  for (const g of groups) {
    const a = anchors.get(g)!;
    members.get(g)!.forEach((p, i) => {
      const spread = 14 * Math.sqrt(i + 0.5);
      nodes.push({
        id: p.id,
        r: nodeSize(p.influence) / 2,
        group: g,
        ax: a.x,
        ay: a.y,
        x: a.x + spread * Math.cos(i * GOLDEN_ANGLE),
        y: a.y + spread * Math.sin(i * GOLDEN_ANGLE),
      });
    });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Weak builds_on springs within a cluster keep lineages near each other.
  const links: SimLink[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "builds_on") continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t || s.group !== t.group) continue;
    const [lo, hi] = s.id < t.id ? [s, t] : [t, s];
    const key = `${lo.id}|${hi.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: lo, target: hi });
  }
  // Edge order must not affect the result.
  const linkKey = (l: SimLink) => `${(l.source as SimNode).id}|${(l.target as SimNode).id}`;
  links.sort((a, b) => (linkKey(a) < linkKey(b) ? -1 : 1));

  const seed = hashString(ordered.map((p) => p.id).join(","));
  const sim = forceSimulation<SimNode>(nodes)
    .randomSource(mulberry32(seed))
    .force("x", forceX<SimNode>((n) => n.ax).strength(0.09))
    .force("y", forceY<SimNode>((n) => n.ay).strength(0.09))
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((n) => n.id)
        .distance((l) => (l.source as SimNode).r + (l.target as SimNode).r + 18)
        .strength(0.05),
    )
    .force("collide", forceCollide<SimNode>((n) => n.r + COLLIDE_PADDING / 2).strength(1).iterations(3))
    .stop();
  sim.tick(TICKS);

  // A few collision-only passes remove any residual overlap left by the springs.
  sim.force("x", null).force("y", null).force("link", null).alpha(0.3);
  sim.tick(COLLIDE_TICKS);

  // Spread the packed result apart (circles keep their size) so labels and
  // edges have room to breathe between papers.
  for (const n of nodes) {
    positions.set(n.id, { x: round((n.x ?? n.ax) * SPREAD), y: round((n.y ?? n.ay) * SPREAD), size: n.r * 2 });
  }
  anchors.forEach((a, g) => anchors.set(g, { x: a.x * SPREAD, y: a.y * SPREAD }));

  const halos: ClusterHalo[] = groups.map((g) => {
    const pts = nodes.filter((n) => n.group === g).map((n) => positions.get(n.id)!);
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const r = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy) + p.size / 2));
    return { group: g, x: round(cx), y: round(cy), r: round(r + 22) };
  });

  return { positions, anchors, halos, labels: cullLabels(ordered, positions) };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
