import type { ExtractionFields } from "./extract";
import { cleanText } from "@/lib/sanitize";

/*
 * The dossier: a deterministic plain-text digest of one search's selection that
 * every Sonnet synthesis call reads (as a cached prompt block). Same input ->
 * byte-identical output, so the prompt cache hits across S1..S5 and retries.
 *
 * Budget: <= maxTokens (default 30k), estimated as chars/4. Field caps shrink
 * step by step until it fits.
 */

export type DossierPaper = {
  paperId: string;
  /** "P1"..; assigned by the caller, stable within the search. */
  ref: string;
  title: string;
  year: number | null;
  /** ISO date; preferred over `year` for display and ordering. */
  publishedAt: string | null;
  venue: string | null;
  clusterIdx: number | null;
  foundational?: boolean;
  metrics: {
    citationCount: number | null;
    influentialCitationCount: number | null;
    /** Citations per year. */
    velocity: number | null;
    /** 0..1 within the search. */
    pagerank: number | null;
    /** 0..1 within the search. */
    influence: number | null;
    maxAuthorHIndex: number | null;
  };
  extraction: ExtractionFields | null;
  /** Used for the card when there is no extraction. */
  abstract?: string | null;
};

export type DossierCluster = {
  idx: number;
  /** Heuristic key-term label. */
  label: string;
  keyTerms: string[];
  size: number;
  yearMin: number | null;
  yearMax: number | null;
};

export type DossierEdge = { source: string; target: string; kind?: string; weight?: number };

export type DossierInput = {
  topic: { name: string; description?: string | null };
  papers: readonly DossierPaper[];
  clusters: readonly DossierCluster[];
  /** Edges among selected papers; only `builds_on` (or kind-less) edges are used. */
  edges: readonly DossierEdge[];
  /** Paper ids flagged by the graph stage. */
  gameChangerCandidates: readonly string[];
  generatedAt: string;
};

export type Dossier = {
  text: string;
  /** "P12" -> paperId. */
  refMap: Record<string, string>;
  /** Cluster idxs present in the dossier. */
  clusterIdxs: number[];
  approxTokens: number;
};

export const DOSSIER_MAX_TOKENS = 30_000;

/** Even the most compact cards don't fit the budget: too many papers selected. */
export class DossierBudgetError extends Error {
  constructor(readonly tokens: number, readonly maxTokens: number, readonly paperCount: number) {
    super(
      `Dossier for ${paperCount} papers needs ~${tokens} tokens at the most compact card format, over the ${maxTokens}-token budget. Select fewer papers.`,
    );
    this.name = "DossierBudgetError";
  }
}

type Caps = {
  title: number;
  problem: number;
  method: number;
  results: number;
  contribution: number;
  /** 0 = omit. */
  limitations: number;
  lists: number;
  abstract: number;
  /** Max builds_on targets listed per paper. */
  edgesPerPaper: number;
};

/** Progressive shrink levels; level 0 is the normal card (~130 tokens). */
const LEVELS: Caps[] = [
  { title: 140, problem: 110, method: 150, results: 150, contribution: 120, limitations: 90, lists: 4, abstract: 420, edgesPerPaper: 12 },
  { title: 120, problem: 90, method: 120, results: 120, contribution: 100, limitations: 0, lists: 3, abstract: 320, edgesPerPaper: 8 },
  { title: 100, problem: 70, method: 90, results: 90, contribution: 90, limitations: 0, lists: 2, abstract: 220, edgesPerPaper: 6 },
  { title: 90, problem: 0, method: 70, results: 60, contribution: 80, limitations: 0, lists: 0, abstract: 140, edgesPerPaper: 4 },
  { title: 80, problem: 0, method: 0, results: 0, contribution: 70, limitations: 0, lists: 0, abstract: 80, edgesPerPaper: 2 },
  { title: 60, problem: 0, method: 0, results: 0, contribution: 0, limitations: 0, lists: 0, abstract: 0, edgesPerPaper: 0 },
];

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate at a word boundary with an ellipsis; "" when max is 0. */
export function clip(value: string | null | undefined, max: number): string {
  if (!value || max <= 0) return "";
  const text = cleanText(value.replace(/\s+/g, " "));
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function dateOf(p: DossierPaper): string {
  if (p.publishedAt && /^\d{4}-\d{2}/.test(p.publishedAt)) return p.publishedAt.slice(0, 7);
  return p.year != null ? String(p.year) : "n.d.";
}

function sortKey(p: DossierPaper): string {
  if (p.publishedAt && /^\d{4}-\d{2}-\d{2}/.test(p.publishedAt)) return p.publishedAt.slice(0, 10);
  if (p.publishedAt && /^\d{4}-\d{2}/.test(p.publishedAt)) return `${p.publishedAt.slice(0, 7)}-00`;
  return p.year != null ? `${p.year}-00-00` : "9999-99-99";
}

function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Cluster (nulls last), then date, then paperId. */
export function orderPapers(papers: readonly DossierPaper[]): DossierPaper[] {
  return [...papers].sort(
    (a, b) =>
      cmp(a.clusterIdx ?? Number.MAX_SAFE_INTEGER, b.clusterIdx ?? Number.MAX_SAFE_INTEGER) ||
      cmp(sortKey(a), sortKey(b)) ||
      cmp(a.paperId, b.paperId),
  );
}

function num(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "?";
  return digits ? n.toFixed(digits) : String(Math.round(n));
}

function metricsLine(p: DossierPaper, inDegree: number): string {
  const m = p.metrics;
  return `cites ${num(m.citationCount)} (infl ${num(m.influentialCitationCount)}) · vel ${num(m.velocity, 1)}/y · pr ${num(m.pagerank, 2)} · influence ${num(m.influence, 2)} · h ${num(m.maxAuthorHIndex)} · built-on-by ${inDegree}`;
}

type Prepared = {
  ordered: DossierPaper[];
  refOf: Map<string, string>;
  outAdj: Map<string, string[]>;
  inDegree: Map<string, number>;
};

function prepare(input: DossierInput): Prepared {
  const ordered = orderPapers(input.papers);
  const seenRefs = new Set<string>();
  for (const p of ordered) {
    if (!/^P\d+$/.test(p.ref)) throw new Error(`Dossier paper ${p.paperId} has an invalid ref "${p.ref}".`);
    if (seenRefs.has(p.ref)) throw new Error(`Duplicate dossier ref ${p.ref}.`);
    seenRefs.add(p.ref);
  }
  const refOf = new Map(ordered.map((p) => [p.paperId, p.ref]));
  const position = new Map(ordered.map((p, i) => [p.paperId, i]));
  const outSets = new Map<string, Set<string>>();
  for (const e of input.edges) {
    if (e.kind && e.kind !== "builds_on") continue;
    if (!refOf.has(e.source) || !refOf.has(e.target) || e.source === e.target) continue;
    const s = outSets.get(e.source) ?? new Set<string>();
    s.add(e.target);
    outSets.set(e.source, s);
  }
  const outAdj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const [src, targets] of outSets) {
    const sorted = [...targets].sort((a, b) => position.get(a)! - position.get(b)!);
    outAdj.set(src, sorted);
    for (const t of sorted) inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
  }
  return { ordered, refOf, outAdj, inDegree };
}

function render(input: DossierInput, prep: Prepared, caps: Caps): string {
  const { ordered, refOf, outAdj, inDegree } = prep;
  const lines: string[] = [];
  const clusters = [...input.clusters].sort((a, b) => a.idx - b.idx);
  const members = new Map<number, string[]>();
  for (const p of ordered) {
    if (p.clusterIdx == null) continue;
    const list = members.get(p.clusterIdx) ?? [];
    list.push(p.ref);
    members.set(p.clusterIdx, list);
  }

  lines.push(`# Landscape dossier: ${clip(input.topic.name, 200)}`);
  if (input.topic.description) lines.push(`Topic description: ${clip(input.topic.description, 600)}`);
  lines.push(`Generated: ${input.generatedAt.slice(0, 10)} · ${ordered.length} papers · ${clusters.length} clusters`);
  lines.push(
    "Card legend: cites = total citations (infl = influential citations); vel = citations per year; pr = PageRank within this set (0-1); influence = composite percentile (0-1); h = max author h-index; built-on-by = papers in this set that build on it.",
  );

  lines.push("", "## Clusters");
  for (const c of clusters) {
    const years = c.yearMin != null || c.yearMax != null ? ` · ${c.yearMin ?? "?"}-${c.yearMax ?? "?"}` : "";
    lines.push(`C${c.idx} "${clip(c.label, 80)}" · ${c.size} papers${years} · terms: ${c.keyTerms.slice(0, 8).map((t) => clip(t, 40)).join(", ")}`);
    lines.push(`  members: ${(members.get(c.idx) ?? []).join(", ") || "none"}`);
  }

  const candidates = input.gameChangerCandidates
    .map((id) => ordered.find((p) => p.paperId === id))
    .filter((p): p is DossierPaper => !!p)
    .sort((a, b) => cmp(b.metrics.influence ?? -1, a.metrics.influence ?? -1) || cmp(a.paperId, b.paperId));
  lines.push("", "## Game-changer candidates (from citation metrics, highest influence first)");
  if (candidates.length === 0) lines.push("none");
  for (const p of candidates) {
    lines.push(`${p.ref} (${dateOf(p)}) ${metricsLine(p, inDegree.get(p.paperId) ?? 0)}`);
  }

  lines.push("", "## Builds-on edges (paper -> the earlier papers it builds on)");
  let anyEdge = false;
  for (const p of ordered) {
    const targets = outAdj.get(p.paperId);
    if (!targets?.length || caps.edgesPerPaper <= 0) continue;
    anyEdge = true;
    const shown = targets.slice(0, caps.edgesPerPaper).map((t) => refOf.get(t)!);
    const more = targets.length > shown.length ? ` (+${targets.length - shown.length} more)` : "";
    lines.push(`${p.ref} -> ${shown.join(", ")}${more}`);
  }
  if (!anyEdge) lines.push(caps.edgesPerPaper <= 0 ? "(omitted for length)" : "none");

  lines.push("", "## Papers (grouped by cluster, oldest first)");
  for (const p of ordered) {
    const tags = [
      p.venue ? clip(p.venue, 40) : null,
      p.clusterIdx != null ? `C${p.clusterIdx}` : "unclustered",
      p.foundational ? "foundational" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push("", `[${p.ref}] ${clip(p.title, caps.title)} (${dateOf(p)}) · ${tags}`);
    lines.push(metricsLine(p, inDegree.get(p.paperId) ?? 0));
    const x = p.extraction;
    const field = (label: string, value: string | null | undefined, max: number) => {
      const v = clip(value, max);
      if (v) lines.push(`${label}: ${v}`);
    };
    if (x) {
      field("problem", x.problem, caps.problem);
      field("method", x.method, caps.method);
      field("results", x.results, caps.results);
      field("contribution", x.contribution, caps.contribution);
      field("limitations", x.limitations, caps.limitations);
      if (caps.lists > 0) {
        const data = [...x.datasets.slice(0, caps.lists), ...x.benchmarks.slice(0, caps.lists)].map((d) => clip(d, 30));
        if (data.length) lines.push(`data: ${Array.from(new Set(data)).join(", ")}`);
      }
    } else {
      field("abstract", p.abstract, caps.abstract);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Build the dossier, shrinking field caps until it fits `maxTokens`; throws DossierBudgetError if it never does. */
export function buildDossier(input: DossierInput, opts: { maxTokens?: number } = {}): Dossier {
  const maxTokens = opts.maxTokens ?? DOSSIER_MAX_TOKENS;
  const prep = prepare(input);
  let text = "";
  for (const caps of LEVELS) {
    text = render(input, prep, caps);
    if (approxTokens(text) <= maxTokens) break;
  }
  if (approxTokens(text) > maxTokens) {
    // Cards are already title + metrics only; silently dropping papers would make
    // synthesis cite a different set than the one the UI shows. Fail loudly.
    throw new DossierBudgetError(approxTokens(text), maxTokens, prep.ordered.length);
  }
  const refMap: Record<string, string> = {};
  for (const p of prep.ordered) refMap[p.ref] = p.paperId;
  const clusterIdxs = Array.from(new Set(input.clusters.map((c) => c.idx))).sort((a, b) => a - b);
  return { text, refMap, clusterIdxs, approxTokens: approxTokens(text) };
}
