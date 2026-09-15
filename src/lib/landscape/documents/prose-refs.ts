import type {
  ClustersDocument,
  DiffDocument,
  GapsDocument,
  NarrativeDocument,
  ReadingPathDocument,
  TensionsDocument,
} from "@/lib/landscape/llm/synthesize/schemas";
import type { DocumentKind, LandscapeDocuments } from "@/lib/landscape/types";

/*
 * Synthesis prose must not leak dossier handles ("P12", "C0") to the reader. The
 * prompts ask the model to keep refs in the ref fields, but models slip, and
 * documents stored before that instruction still contain them. This rewrites
 * every prose field: a known paper ref becomes a short citation label
 * ("Smith et al. 2023"), a known cluster ref becomes the cluster's name, and runs
 * of refs are joined ("(P8, P14)" -> "(Smith et al. 2023; Lee 2024)").
 *
 * Only refs present in the context are touched, so "P100 GPU" or "GPT4" survive
 * unless the landscape really has a P100. Unknown refs are removed only when they
 * sit in a run with a known ref, or alone inside parentheses/brackets.
 *
 * Used at write time (synthesize stage) and at read time (snapshot, topic cards)
 * so already-stored documents render cleanly without re-synthesis.
 */

export type ProseRefContext = {
  /** Ref number (12 for "P12") -> citation label. */
  papers: ReadonlyMap<number, string>;
  /** Cluster idx -> cluster name. */
  clusters: ReadonlyMap<number, string>;
};

export type CitablePaper = {
  /** "P12". Anything else is ignored. */
  ref: string;
  title: string;
  authors: readonly (string | { name: string })[] | null | undefined;
  year: number | null | undefined;
  publishedAt?: string | null;
};

const TITLE_LABEL_MAX = 48;

function surname(name: string): string {
  const n = name.trim();
  if (!n) return "";
  // "Smith, John" -> "Smith"; "John Smith" -> "Smith".
  if (n.includes(",")) return n.split(",")[0].trim();
  const parts = n.split(/\s+/).filter((p) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(p));
  return parts[parts.length - 1] ?? n;
}

function shortTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= TITLE_LABEL_MAX) return t;
  const cut = t.slice(0, TITLE_LABEL_MAX - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > TITLE_LABEL_MAX * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** "Smith et al. 2023", "Lee 2024", or a truncated title ("Attention Is All You Need, 2017"). */
export function citationLabel(p: Omit<CitablePaper, "ref">): string {
  const year = p.year ?? (p.publishedAt && /^\d{4}/.test(p.publishedAt) ? Number(p.publishedAt.slice(0, 4)) : null);
  const names = (p.authors ?? []).map((a) => (typeof a === "string" ? a : a?.name ?? "")).filter((a) => a.trim());
  const first = names.length ? surname(names[0]) : "";
  if (first) return `${first}${names.length > 1 ? " et al." : ""}${year ? ` ${year}` : ""}`;
  const title = shortTitle(p.title ?? "");
  if (!title) return year ? String(year) : "";
  return year ? `${title}, ${year}` : title;
}

export function buildProseRefContext(input: {
  papers: readonly CitablePaper[];
  clusters: readonly { idx: number; label: string | null | undefined }[];
}): ProseRefContext {
  const papers = new Map<number, string>();
  for (const p of input.papers) {
    const m = /^P(\d+)$/.exec(p.ref ?? "");
    if (!m) continue;
    const label = citationLabel(p);
    if (label) papers.set(Number(m[1]), label);
  }
  const clusters = new Map<number, string>();
  for (const c of input.clusters) {
    const label = c.label?.trim();
    if (label) clusters.set(c.idx, label);
  }
  return { papers, clusters };
}

// ---------------------------------------------------------------------------
// Text rewrite
// ---------------------------------------------------------------------------

type Token = { start: number; end: number; kind: "P" | "C"; n: number; clusterWord: boolean };

/*
 * Ref tokens: "P12" (upper-case only), "C0", "cluster-0". A token directly followed by
 * a word character, ".<digit>", "x" or "-<letter>" is part of something else ("P3.16",
 * "p3.16xlarge", "C4-based"), except "-P3"/"-C3" which is a range. A hardware or data
 * noun after it ("P3 GPUs", "C4 dataset") also disqualifies it.
 */
const TOKEN_RE =
  /(?<![\w.])(?:P(\d+)|C(\d+)|[Cc]luster-(\d+))(?!\w|\.\d|-(?![PC]\d)[A-Za-z])(?!\s+(?:GPUs?|instances?|nodes?|datasets?|corpus|corpora|benchmarks?)\b)/g;
/** Text allowed between two refs of one run. */
const SEP_RE = /^\s*(?:,\s*(?:and\s+|&\s*)?|;|\/|&|and\s+|[-–—])?\s*$/i;
const RANGE_RE = /^\s*[-–—]\s*$/;
const MAX_RANGE = 30;

function joinProse(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function capitalizeLead(s: string): string {
  return s.replace(/^([\s,;:]*)([a-z])/, (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const isP = m[1] != null;
    tokens.push({
      start: m.index!,
      end: m.index! + m[0].length,
      kind: isP ? "P" : "C",
      n: Number(isP ? m[1] : (m[2] ?? m[3])),
      clusterWord: m[3] != null,
    });
  }
  return tokens;
}

/** Known ref tokens across every string in `value` (a document, a list, a string). */
export function countKnownRefs(value: unknown, ctx: ProseRefContext): number {
  if (typeof value === "string") {
    return tokenize(value).filter((t) => (t.kind === "P" ? ctx.papers.has(t.n) : ctx.clusters.has(t.n))).length;
  }
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countKnownRefs(v, ctx), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n: number, v) => n + countKnownRefs(v, ctx), 0);
  return 0;
}

/** Is `start..end` enclosed by an open "(" / "[" that closes after it? */
function insideBrackets(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start);
  const open = Math.max(before.lastIndexOf("("), before.lastIndexOf("["));
  if (open < 0 || open < Math.max(before.lastIndexOf(")"), before.lastIndexOf("]"))) return false;
  const after = text.slice(end);
  const close = after.search(/[)\]]/);
  const reopen = after.search(/[([]/);
  return close >= 0 && (reopen < 0 || close < reopen);
}

/**
 * Rewrite the refs in one prose string. Returns the input unchanged when nothing
 * applies. A run of refs is rewritten only where it is unambiguous: inside
 * parentheses/brackets, a list or range of refs, or (paper refs) when the same
 * field has another known paper ref, or a possessive ("P12's"); a cluster ref also
 * after "cluster", before "'s", or written "cluster-0". Either kind also when the
 * surrounding document has another known ref (`opts.documentKnownRefs`, from
 * `countKnownRefs` over the whole document, >= 2 counting this one): synthesis
 * documents are written from refs, so a lone "P5" there is a ref. Otherwise an
 * isolated "P100" or "C4" in plain prose is left alone. Idempotent: labels never
 * contain ref tokens that qualify again.
 */
export function rewriteProseRefs(text: string, ctx: ProseRefContext, opts: { documentKnownRefs?: number } = {}): string {
  if (!text || (ctx.papers.size === 0 && ctx.clusters.size === 0)) return text;
  const tokens = tokenize(text);
  if (tokens.length === 0) return text;
  const known = (t: Token) => (t.kind === "P" ? ctx.papers.has(t.n) : ctx.clusters.has(t.n));
  const labelOf = (kind: "P" | "C", n: number) => (kind === "P" ? ctx.papers.get(n) : ctx.clusters.get(n));

  // Group adjacent tokens separated only by list punctuation.
  const groups: Token[][] = [];
  for (const t of tokens) {
    const g = groups[groups.length - 1];
    if (g && SEP_RE.test(text.slice(g[g.length - 1].end, t.start))) g.push(t);
    else groups.push([t]);
  }

  const eligible = (g: Token[]): boolean => {
    const start = g[0].start;
    const end = g[g.length - 1].end;
    if (g.length > 1 || insideBrackets(text, start, end)) return true;
    const t = g[0];
    if ((opts.documentKnownRefs ?? 0) >= 2) return true;
    if (t.kind === "C") {
      return t.clusterWord || /\bcluster\s*$/i.test(text.slice(0, start)) || /^['’]s\b/.test(text.slice(end));
    }
    return /^['’]s\b/.test(text.slice(end)) || tokens.some((o) => o !== t && o.kind === "P" && known(o));
  };

  let out = "";
  let cursor = 0;
  let changed = false;
  let capitalizeNext = false;
  const append = (s: string) => {
    out += capitalizeNext ? capitalizeLead(s) : s;
    if (capitalizeNext && /[A-Za-z]/.test(s)) capitalizeNext = false;
  };

  for (const g of groups) {
    const start = g[0].start;
    const end = g[g.length - 1].end;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const opensParen = /[([]\s*$/.test(before);
    const fullParen = opensParen && /^\s*[)\]]/.test(after);
    if (!eligible(g)) continue;
    const anyKnown = g.some(known);
    // A lone unknown ref in parentheses ("(P99)") is still a ref; elsewhere leave it be.
    const removable = !anyKnown && fullParen;
    if (!anyKnown && !removable) continue;

    const labels: string[] = [];
    const push = (kind: "P" | "C", n: number) => {
      const l = labelOf(kind, n);
      if (l && !labels.includes(l)) labels.push(l);
    };
    for (let i = 0; i < g.length; i++) {
      const t = g[i];
      const next = g[i + 1];
      push(t.kind, t.n);
      if (next && next.kind === t.kind && RANGE_RE.test(text.slice(t.end, next.start)) && next.n > t.n && next.n - t.n <= MAX_RANGE) {
        for (let n = t.n + 1; n < next.n; n++) push(t.kind, n);
      }
    }

    append(text.slice(cursor, start));
    cursor = end;
    changed = true;
    if (labels.length === 0) {
      if (/(^|[.!?])\s*[([]?\s*$/.test(before)) capitalizeNext = true;
      continue;
    }
    append(opensParen ? labels.join("; ") : joinProse(labels));
  }
  if (!changed) return text;
  append(text.slice(cursor));

  // Tidy-up runs over the whole field, not just around the replacements: offsets
  // shift as refs are replaced, and the patterns only match debris a removal leaves
  // (empty brackets, doubled separators, space before punctuation), which clean
  // prose doesn't contain. It never runs when no ref was rewritten.
  return out
    .replace(/[ \t]*[([]\s*[,;]?\s*[)\]]/g, "") // empty "()" / "[]"
    .replace(/([([])\s*[,;]\s*/g, "$1")
    .replace(/\s*[,;]\s*([)\]])/g, "$1")
    .replace(/([([])[ \t]+/g, "$1")
    .replace(/[ \t]+([,;.:!?)\]])/g, "$1")
    .replace(/([,;])(?:\s*[,;])+/g, "$1")
    .replace(/[,;]([.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,;:]+/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/^([a-z])/, (c) => (/^[a-z]/.test(text.trimStart()) ? c : c.toUpperCase()));
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

type DocByKind = {
  clusters: ClustersDocument;
  tensions: TensionsDocument;
  gaps: GapsDocument;
  narrative: NarrativeDocument;
  reading_path: ReadingPathDocument;
  diff: DiffDocument;
};

/** Rewrite every prose field of a stored document (ids, names and labels untouched). */
export function rewriteDocumentProse<K extends DocumentKind>(kind: K, doc: DocByKind[K], ctx: ProseRefContext): DocByKind[K] {
  const documentKnownRefs = countKnownRefs(doc, ctx);
  const r = (s: string) => rewriteProseRefs(s, ctx, { documentKnownRefs });
  const rn = (s: string | null) => (s == null ? s : r(s));
  const list = (xs: string[]) => xs.map(r).filter((x) => x.trim());
  switch (kind) {
    case "clusters": {
      const d = doc as ClustersDocument;
      return {
        ...d,
        topicSummary: r(d.topicSummary),
        clusters: d.clusters.map((c) => ({ ...c, summary: r(c.summary), keyIdeas: list(c.keyIdeas) })),
      } satisfies ClustersDocument as DocByKind[K];
    }
    case "tensions": {
      const d = doc as TensionsDocument;
      return {
        ...d,
        tensions: d.tensions.map((t) => ({
          ...t,
          title: r(t.title),
          description: r(t.description),
          positions: t.positions.map((p) => ({ ...p, stance: r(p.stance) })),
        })),
      } satisfies TensionsDocument as DocByKind[K];
    }
    case "gaps": {
      const d = doc as GapsDocument;
      return {
        ...d,
        gaps: d.gaps.map((g) => ({
          ...g,
          title: r(g.title),
          description: r(g.description),
          evidence: r(g.evidence),
          directions: list(g.directions),
        })),
      } satisfies GapsDocument as DocByKind[K];
    }
    case "narrative": {
      const d = doc as NarrativeDocument;
      return {
        ...d,
        eras: d.eras.map((e) => ({ ...e, label: r(e.label), summary: r(e.summary) })),
        gameChangers: d.gameChangers.map((g) => ({ ...g, why: r(g.why), evidence: r(g.evidence) })),
        frontier: { ...d.frontier, summary: r(d.frontier.summary) },
        outlook: r(d.outlook),
        whatChanged: rn(d.whatChanged),
      } satisfies NarrativeDocument as DocByKind[K];
    }
    case "reading_path": {
      const d = doc as ReadingPathDocument;
      return { ...d, steps: d.steps.map((s) => ({ ...s, reason: r(s.reason) })) } satisfies ReadingPathDocument as DocByKind[K];
    }
    default:
      return doc;
  }
}

/** Snapshot-shaped documents (readingPath key). */
export function rewriteLandscapeDocumentsProse(documents: LandscapeDocuments, ctx: ProseRefContext): LandscapeDocuments {
  return {
    ...documents,
    clusters: documents.clusters && rewriteDocumentProse("clusters", documents.clusters, ctx),
    tensions: documents.tensions && rewriteDocumentProse("tensions", documents.tensions, ctx),
    gaps: documents.gaps && rewriteDocumentProse("gaps", documents.gaps, ctx),
    narrative: documents.narrative && rewriteDocumentProse("narrative", documents.narrative, ctx),
    readingPath: documents.readingPath && rewriteDocumentProse("reading_path", documents.readingPath, ctx),
  };
}
