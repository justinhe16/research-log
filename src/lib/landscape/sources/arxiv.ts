/*
 * arXiv search source: query builder, Atom feed parser and a polite search call.
 *
 * The network goes through `sources/http.ts` (per-host limiter, retries, api_cache),
 * but `fetchText` is injectable so the parser and retry logic are testable offline.
 */
import { JSDOM } from "jsdom";
import type { Db } from "@/lib/db/create";
import { API_CACHE_TTL_MS } from "@/lib/landscape/constants";
import { normalizeArxivId, normalizeDoi } from "@/lib/landscape/ids";
import type { PaperAuthor, PaperInput } from "@/lib/landscape/types";
import { cleanText } from "@/lib/sanitize";

export const ARXIV_API_URL = "https://export.arxiv.org/api/query";
/** The arXiv API refuses larger pages politely; keep well under its 2000 hard cap. */
export const ARXIV_MAX_RESULTS = 100;
/** arXiv sometimes answers with totalResults > 0 but no entries; wait this long, then retry once. */
export const ARXIV_EMPTY_RETRY_MS = 5_000;

const ATOM_NS = "http://www.w3.org/2005/Atom";
const ARXIV_NS = "http://arxiv.org/schemas/atom";
const OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors `HttpCacheOptions` in `./http`. */
export type ArxivCacheOptions = {
  /** Defaults to the app DB inside `./http`. */
  db?: Db;
  source: string;
  ttlMs: number;
  bypass?: boolean;
};

/** Shape of `fetchText` from `./http`. Resolves to the response body. */
export type FetchTextFn = (
  url: string,
  opts: { host: "arxiv"; cache?: ArxivCacheOptions; signal?: AbortSignal },
) => Promise<string>;

/** A parsed arXiv entry. Assignable to `PaperInput`; the extras are for callers that want them. */
export type ArxivPaper = PaperInput & {
  arxivId: string;
  source: "arxiv";
  /** 1-based position in the arXiv result list (`start` included), for RRF source ranks. */
  rank: number;
  /** Version from the feed id, e.g. 3 for "2401.01234v3"; null when absent. */
  version: number | null;
  updatedAt: string | null;
  primaryCategory: string | null;
  categories: string[];
  journalRef: string | null;
  comment: string | null;
};

export type ArxivFeed = {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  entries: ArxivPaper[];
  /** Entries skipped because they had no parseable id or no title. */
  dropped: number;
  /** Set when arXiv returned its error entry (e.g. a malformed query). */
  error: string | null;
};

/** Anything with a plain `text`, plus an optional pre-built arXiv query (`arxiv` per
 *  `ExpandedQuery`, `arxivQuery` accepted as an alias). */
export type ArxivQueryInput = {
  text: string;
  arxiv?: string | null;
  arxivQuery?: string | null;
  categories?: string[];
};

export type BuildArxivQueryOptions = {
  categories?: string[];
  /** ISO date or date-time; results submitted on/after this day. Wins over `windowYears`. */
  since?: string | Date | null;
  windowYears?: number | null;
  /** Ignore any provided query and OR every text term (used for the zero-result retry). */
  relaxed?: boolean;
  /** Injectable clock for tests. */
  now?: Date;
};

export type SearchArxivOptions = BuildArxivQueryOptions & {
  maxResults?: number;
  start?: number;
  sortBy?: "relevance" | "submittedDate";
  /** Omit to skip api_cache; `source` defaults to "arxiv", `ttlMs` to the search TTL. */
  cache?: { db?: Db; ttlMs?: number; source?: string; bypass?: boolean };
  signal?: AbortSignal;
  fetchText?: FetchTextFn;
  sleep?: (ms: number) => Promise<void>;
  /** Non-fatal events the collect stage may count or log. */
  onWarning?: (warning: ArxivWarning) => void;
};

export type ArxivWarning =
  /** The query returned zero results and was retried once with every term OR-ed. */
  | { kind: "relaxed_retry"; query: string; relaxedQuery: string; relaxedResults: number }
  /** totalResults > 0 but no entries, even after the 5s retry. */
  | { kind: "empty_after_retry"; query: string; totalResults: number }
  /** Feed entries skipped for having no parseable id or title. */
  | { kind: "dropped_entries"; query: string; count: number };

export class ArxivApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivApiError";
  }
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

const FIELD_PREFIXES = new Set(["ti", "au", "abs", "co", "jr", "cat", "rn", "all", "submittedDate"]);
const BOOLEAN_OPS = new Set(["AND", "OR", "ANDNOT"]);
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "in", "on", "to", "with", "by", "via", "or", "at", "from", "is", "are",
]);
/** Common-but-uninformative words: never picked as the AND-ed "distinctive" terms when better ones exist. */
const GENERIC_TERMS = new Set([
  "learning", "model", "models", "network", "networks", "neural", "deep", "method", "methods", "approach",
  "approaches", "based", "using", "large", "data", "analysis", "towards", "survey", "system", "systems",
  "new", "efficient", "improved", "novel", "framework", "task", "tasks",
]);
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 40;
const MAX_CATEGORIES = 10;
/** Cap for a provided arXiv query. */
const MAX_QUERY_CHARS = 1000;
/** Cap for the final combined `search_query` (base + categories + date range). */
export const ARXIV_MAX_SEARCH_QUERY_CHARS = 1500;
/** Archive plus optional subject class, both possibly hyphenated: cs.LG, hep-th, physics.acc-ph, cond-mat.stat-mech. */
const CATEGORY_RE = /^[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]+(?:-[A-Za-z]+)*)?$/;
const DATE_RANGE_RE = /submittedDate:\[\d{12} TO \d{12}\]/g;

/**
 * A provided arXiv query is accepted only when it is plainly well-formed: a safe
 * charset, balanced parens (never closing below zero), an even number of quotes,
 * every token either `field:value` (known field) or exactly AND / OR / ANDNOT,
 * no dangling or doubled operators, and brackets only in a 12-digit submittedDate range.
 */
export function isSaneArxivQuery(q: string | null | undefined): q is string {
  if (typeof q !== "string") return false;
  const s = q.trim();
  if (!s || s.length > MAX_QUERY_CHARS) return false;
  if (!/^[\p{L}\p{N}\s"():.\-_+*,'/[\]]+$/u.test(s)) return false;
  if ((s.match(/"/g) ?? []).length % 2 !== 0) return false;

  let depth = 0;
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "(") depth++;
    else if (!inQuote && ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;
  if (/\(\s*\)/.test(s)) return false;

  // Collapse quoted phrases and date ranges into single placeholder values.
  const unquoted = s.replace(/"[^"]*"/g, '""').replace(DATE_RANGE_RE, "submittedDate:RANGE");
  if (/[[\]]/.test(unquoted)) return false;

  const tokens = unquoted.split(/[\s()]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  let prevOp = true; // treat start as following an operator
  let terms = 0;
  for (const tok of tokens) {
    if (BOOLEAN_OPS.has(tok)) {
      if (prevOp) return false;
      prevOp = true;
      continue;
    }
    const m = tok.match(/^([A-Za-z]+):(\S+)$/);
    if (!m || !FIELD_PREFIXES.has(m[1]) || m[2].includes(":")) return false;
    if (!prevOp) return false; // two terms with no operator between them
    prevOp = false;
    terms++;
  }
  return !prevOp && terms > 0;
}

function extractTerms(text: string): string[] {
  const words = cleanText(text)
    .replace(/[^\p{L}\p{N}\s\-.]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-.]+|[-.]+$/g, "").slice(0, MAX_TERM_CHARS))
    .filter((w) => w && !STOPWORDS.has(w.toLowerCase()) && !/^(AND|OR|ANDNOT)$/i.test(w));
  return [...new Set(words.map((w) => w.toLowerCase()))].slice(0, MAX_TERMS);
}

const allTerm = (w: string) => `all:"${w}"`;

/**
 * Plain text → the 2–3 most distinctive terms AND-ed, the rest OR-ed in a group:
 * `all:"a" AND all:"b" AND (all:"c" OR all:"d")`. With `relaxed`, every term is OR-ed.
 */
function termsQuery(text: string, relaxed = false): { query: string; anded: boolean } | null {
  const terms = extractTerms(text);
  if (terms.length === 0) return null;
  if (relaxed || terms.length === 1) return { query: terms.map(allTerm).join(" OR "), anded: false };
  if (terms.length === 2) return { query: terms.map(allTerm).join(" AND "), anded: true };

  const ranked = terms
    .map((w, i) => ({ w, i }))
    .sort(
      (x, y) =>
        Number(GENERIC_TERMS.has(x.w)) - Number(GENERIC_TERMS.has(y.w)) || y.w.length - x.w.length || x.i - y.i,
    );
  const k = terms.length >= 6 ? 3 : 2;
  // Keep the text's word order within each group so queries read naturally.
  const must = ranked.slice(0, k).sort((x, y) => x.i - y.i).map((t) => allTerm(t.w));
  const rest = ranked.slice(k).sort((x, y) => x.i - y.i).map((t) => allTerm(t.w));
  const group = rest.length === 1 ? rest[0] : `(${rest.join(" OR ")})`;
  return { query: [...must, group].join(" AND "), anded: true };
}

function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function sinceDate(opts: BuildArxivQueryOptions, now: Date): Date | null {
  if (opts.since) {
    const d = opts.since instanceof Date ? opts.since : new Date(opts.since);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (opts.windowYears && opts.windowYears > 0) {
    const d = new Date(now.getTime());
    d.setUTCFullYear(d.getUTCFullYear() - opts.windowYears);
    return d;
  }
  return null;
}

export type ArxivQueryPlan = {
  /** The final `search_query`; "" when there is nothing searchable. */
  query: string;
  /** provided = sane `arxiv` query used; fallback = built from text; relaxed = all-OR from text. */
  kind: "provided" | "fallback" | "relaxed" | "empty";
  /** True when a zero-result response may be retried with `relaxed: true`. */
  relaxable: boolean;
};

/**
 * Build an arXiv API `search_query`, reporting how it was built. Uses the provided
 * arXiv query when it is sane (unless `relaxed`), otherwise terms from `text` (see
 * `termsQuery`). Categories are OR-ed (skipped if the base already restricts `cat:`,
 * dropped if they would push the query past `ARXIV_MAX_SEARCH_QUERY_CHARS`);
 * `since`/`windowYears` add `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` ending today.
 */
export function planArxivQuery(q: ArxivQueryInput, opts: BuildArxivQueryOptions = {}): ArxivQueryPlan {
  const provided = q.arxiv ?? q.arxivQuery;
  let base: string;
  let kind: ArxivQueryPlan["kind"];
  let relaxable: boolean;
  const relaxedTerms = termsQuery(q.text ?? "", true);

  if (!opts.relaxed && isSaneArxivQuery(provided)) {
    base = provided.trim().replace(/\s+/g, " ");
    kind = "provided";
    relaxable = relaxedTerms !== null;
  } else {
    const built = termsQuery(q.text ?? "", opts.relaxed === true);
    if (!built) return { query: "", kind: "empty", relaxable: false };
    base = built.query;
    kind = opts.relaxed ? "relaxed" : "fallback";
    relaxable = !opts.relaxed && built.anded;
  }

  const now = opts.now ?? new Date();
  const since = sinceDate(opts, now);
  const datePart =
    since && !/submittedDate:/.test(base) ? `submittedDate:[${yyyymmdd(since)}0000 TO ${yyyymmdd(now)}2359]` : null;

  const hasCat = /(^|[\s(])cat:/.test(base.replace(/"[^"]*"/g, '""'));
  const categories = [...new Set((opts.categories ?? q.categories ?? []).map((c) => c.trim()))]
    .filter((c) => CATEGORY_RE.test(c))
    .slice(0, MAX_CATEGORIES);
  const catPart =
    hasCat || categories.length === 0
      ? null
      : categories.length === 1
        ? `cat:${categories[0]}`
        : `(${categories.map((c) => `cat:${c}`).join(" OR ")})`;

  const combine = (cat: string | null) => {
    const extra = [cat, datePart].filter((x): x is string => x !== null);
    return extra.length === 0 ? base : [`(${base})`, ...extra].join(" AND ");
  };
  let query = combine(catPart);
  if (query.length > ARXIV_MAX_SEARCH_QUERY_CHARS) query = combine(null);
  if (query.length > ARXIV_MAX_SEARCH_QUERY_CHARS) return { query: "", kind: "empty", relaxable: false };
  return { query, kind, relaxable };
}

/** `planArxivQuery(...).query`. */
export function buildArxivQuery(q: ArxivQueryInput, opts: BuildArxivQueryOptions = {}): string {
  return planArxivQuery(q, opts).query;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function textOf(el: Element | null | undefined): string {
  return cleanText((el?.textContent ?? "").replace(/\s+/g, " "));
}

function firstNS(parent: Element | Document, ns: string, name: string): Element | null {
  return parent.getElementsByTagNameNS(ns, name)[0] ?? null;
}

/** Direct children only: `<author>` has its own nested elements, the feed has its own `<title>`. */
function childNS(parent: Element, ns: string, name: string): Element[] {
  return Array.from(parent.children).filter((c) => c.namespaceURI === ns && c.localName === name);
}

function toIso(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function intOr(s: string, fallback: number): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse an arXiv API Atom feed. Pure; throws only if the XML is unparseable. */
export function parseArxivFeed(xml: string): ArxivFeed {
  const { DOMParser } = new JSDOM("").window;
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0 || !doc.documentElement) {
    throw new ArxivApiError("Could not parse the arXiv API response as XML.");
  }

  const root = doc.documentElement;
  const totalResults = intOr(textOf(firstNS(root, OPENSEARCH_NS, "totalResults")), 0);
  const startIndex = intOr(textOf(firstNS(root, OPENSEARCH_NS, "startIndex")), 0);
  const itemsPerPage = intOr(textOf(firstNS(root, OPENSEARCH_NS, "itemsPerPage")), 0);

  const entries: ArxivPaper[] = [];
  let error: string | null = null;
  let dropped = 0;

  for (const entry of Array.from(root.getElementsByTagNameNS(ATOM_NS, "entry"))) {
    const rawId = textOf(childNS(entry, ATOM_NS, "id")[0]);
    const title = textOf(childNS(entry, ATOM_NS, "title")[0]);

    if (/\/api\/errors/i.test(rawId) || title.toLowerCase() === "error") {
      error = textOf(childNS(entry, ATOM_NS, "summary")[0]) || "arXiv API error";
      continue;
    }

    const arxivId = normalizeArxivId(rawId);
    if (!arxivId || !title) {
      dropped++;
      continue;
    }
    const versionMatch = rawId.match(/v(\d+)$/);

    const authors: PaperAuthor[] = childNS(entry, ATOM_NS, "author")
      .map((a) => textOf(childNS(a, ATOM_NS, "name")[0]))
      .filter(Boolean)
      .map((name) => ({ name }));

    const publishedAt = toIso(textOf(childNS(entry, ATOM_NS, "published")[0]));
    const updatedAt = toIso(textOf(childNS(entry, ATOM_NS, "updated")[0]));
    const primaryCategory = firstNS(entry, ARXIV_NS, "primary_category")?.getAttribute("term")?.trim() || null;
    const categories = [
      ...new Set(
        childNS(entry, ATOM_NS, "category")
          .map((c) => c.getAttribute("term")?.trim() ?? "")
          .filter(Boolean),
      ),
    ];
    const journalRef = textOf(firstNS(entry, ARXIV_NS, "journal_ref")) || null;
    const comment = textOf(firstNS(entry, ARXIV_NS, "comment")) || null;

    const doiLink = childNS(entry, ATOM_NS, "link").find((l) => l.getAttribute("title") === "doi");
    const doi = normalizeDoi(textOf(firstNS(entry, ARXIV_NS, "doi")).split(/\s+/)[0]) ?? normalizeDoi(doiLink?.getAttribute("href"));

    const abstract = textOf(childNS(entry, ATOM_NS, "summary")[0]) || null;

    entries.push({
      title,
      arxivId,
      doi,
      abstract,
      authors,
      year: publishedAt ? new Date(publishedAt).getUTCFullYear() : null,
      publishedAt,
      venue: journalRef,
      arxivUrl: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      source: "arxiv",
      rank: startIndex + entries.length + 1,
      version: versionMatch ? Number(versionMatch[1]) : null,
      updatedAt,
      primaryCategory,
      categories,
      journalRef,
      comment,
    });
  }

  return { totalResults, startIndex, itemsPerPage, entries, dropped, error };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const defaultFetchText: FetchTextFn = async (url, opts) => {
  const http = await import("./http");
  return http.fetchText(url, opts);
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function arxivSearchUrl(
  searchQuery: string,
  opts: { start?: number; maxResults?: number; sortBy?: "relevance" | "submittedDate" } = {},
): string {
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: String(Math.max(0, Math.floor(opts.start ?? 0))),
    max_results: String(Math.min(ARXIV_MAX_RESULTS, Math.max(1, Math.floor(opts.maxResults ?? 50)))),
    sortBy: opts.sortBy ?? "relevance",
    sortOrder: "descending",
  });
  return `${ARXIV_API_URL}?${params.toString()}`;
}

/**
 * Search arXiv for one query. Returns papers in arXiv's order with 1-based `rank`.
 * Throws `ArxivApiError` when arXiv returns its error entry.
 * - When the feed reports results but carries no entries (a known arXiv hiccup), waits
 *   5s and retries once with the cache bypassed.
 * - When a provided or AND-built query finds nothing at all, retries once with every
 *   text term OR-ed (reported as a `relaxed_retry` warning).
 */
export async function searchArxiv(query: ArxivQueryInput | string, opts: SearchArxivOptions = {}): Promise<ArxivPaper[]> {
  const input: ArxivQueryInput = typeof query === "string" ? { text: query } : query;
  const plan = planArxivQuery(input, opts);
  if (!plan.query) return [];

  const start = Math.max(0, Math.floor(opts.start ?? 0));
  const fetchText = opts.fetchText ?? defaultFetchText;
  const sleep = opts.sleep ?? defaultSleep;
  const warn = (w: ArxivWarning) => {
    try {
      opts.onWarning?.(w);
    } catch {
      // A faulty warning sink must never break collection.
    }
  };
  const cache: ArxivCacheOptions | undefined = opts.cache
    ? {
        db: opts.cache.db,
        source: opts.cache.source ?? "arxiv",
        ttlMs: opts.cache.ttlMs ?? API_CACHE_TTL_MS.search,
        bypass: opts.cache.bypass,
      }
    : undefined;

  const run = async (searchQuery: string): Promise<ArxivFeed> => {
    const url = arxivSearchUrl(searchQuery, { start, maxResults: opts.maxResults, sortBy: opts.sortBy });
    let feed = parseArxivFeed(await fetchText(url, { host: "arxiv", cache, signal: opts.signal }));
    if (!feed.error && feed.entries.length === 0 && feed.dropped === 0 && feed.totalResults > start) {
      await sleep(ARXIV_EMPTY_RETRY_MS);
      feed = parseArxivFeed(
        await fetchText(url, { host: "arxiv", cache: cache && { ...cache, bypass: true }, signal: opts.signal }),
      );
      if (!feed.error && feed.entries.length === 0 && feed.dropped === 0 && feed.totalResults > start) {
        warn({ kind: "empty_after_retry", query: searchQuery, totalResults: feed.totalResults });
      }
    }
    if (feed.error) throw new ArxivApiError(`arXiv rejected the query: ${feed.error}`);
    if (feed.dropped > 0) warn({ kind: "dropped_entries", query: searchQuery, count: feed.dropped });
    return feed;
  };

  let feed = await run(plan.query);
  if (feed.totalResults === 0 && feed.entries.length === 0 && plan.relaxable) {
    const relaxedQuery = planArxivQuery(input, { ...opts, relaxed: true }).query;
    if (relaxedQuery && relaxedQuery !== plan.query) {
      feed = await run(relaxedQuery);
      warn({ kind: "relaxed_retry", query: plan.query, relaxedQuery, relaxedResults: feed.totalResults });
    }
  }
  return feed.entries;
}
