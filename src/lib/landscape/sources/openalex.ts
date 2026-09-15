/**
 * OpenAlex client: metadata fallback by DOI and author h-index, plus a pure work parser.
 *
 * Server-only. Network goes through `./http`; tests inject `fetchJson`.
 *
 * API facts (checked against live api.openalex.org responses):
 *  - /works?filter=doi:A|B -- OR filter, we send <= 50 values with per-page=50.
 *  - Work: `id` / `ids.openalex` ("https://openalex.org/W..."), `doi` ("https://doi.org/..."),
 *    `title` / `display_name`, `publication_year`, `publication_date`, `cited_by_count`,
 *    `abstract_inverted_index` ({word: [positions]}), `authorships[].author.{id,display_name}`,
 *    `primary_location.{landing_page_url,pdf_url,source.display_name,raw_source_name}`,
 *    `best_oa_location`, `locations[]`. `ids` has no arXiv key: arXiv ids are only
 *    recoverable from location URLs or a 10.48550 DOI.
 *  - /authors?filter=ids.openalex:A1|A2 -> `summary_stats.h_index`.
 *  - `workByArxiv` is intentionally not provided: filtering by the arXiv DOI misses
 *    most records (e.g. 1706.03762 returns 0 hits), so S2 is the arXiv lookup path.
 *  - `mailto` (from OPENALEX_MAILTO) is added as a query param for the polite pool.
 */
import type { Db } from "@/lib/db/create";
import { API_CACHE_TTL_MS } from "../constants";
import { findArxivId, normalizeArxivId, normalizeDoi, normalizeOpenAlexId } from "../ids";
import type { PaperAuthor, PaperInput } from "../types";
import type { CachedHttpOptions } from "./http";

export const OPENALEX_API_BASE = "https://api.openalex.org";
export const OPENALEX_FILTER_MAX = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenAlexFetchJson = <T>(url: string, opts: CachedHttpOptions) => Promise<T>;

export type OpenAlexRequestOptions = {
  fetchJson?: OpenAlexFetchJson;
  /** Enables api_cache; `source` is fixed to "openalex". */
  cache?: { db?: Db; ttlMs?: number; bypass?: boolean };
  signal?: AbortSignal;
  /** Overrides OPENALEX_MAILTO (tests). Empty string disables. */
  mailto?: string;
};

type OpenAlexLocation = {
  landing_page_url?: string | null;
  pdf_url?: string | null;
  raw_source_name?: string | null;
  source?: { display_name?: string | null; type?: string | null } | null;
} | null;

export type OpenAlexRawWork = {
  id?: string | null;
  doi?: string | null;
  ids?: { openalex?: string | null; doi?: string | null } | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  cited_by_count?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: { author?: { id?: string | null; display_name?: string | null } | null; raw_author_name?: string | null }[] | null;
  primary_location?: OpenAlexLocation;
  best_oa_location?: OpenAlexLocation;
  locations?: OpenAlexLocation[] | null;
  open_access?: { oa_url?: string | null } | null;
};

type OpenAlexList<T> = { meta?: { count?: number }; results?: T[] | null };

export type OpenAlexPaper = PaperInput & { source: "openalex"; openalexId: string | null };

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s || null;
}

/** Rebuild plain text from OpenAlex's `{word: [positions]}` index. */
export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string | null {
  if (!index || typeof index !== "object") return null;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (Number.isInteger(p) && p >= 0 && p < 100_000) slots[p] = word;
    }
  }
  const text = slots.filter((w) => w !== undefined).join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

/** Bare OpenAlex author id ("A123"), from a URL or bare id. */
export function normalizeOpenAlexAuthorId(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const m = input.trim().match(/(?:^|\/)(A\d+)$/i);
  return m ? m[1].toUpperCase() : null;
}

function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/** Parse one OpenAlex work. Returns null when there is no usable title. */
export function parseOpenAlexWork(json: unknown): OpenAlexPaper | null {
  if (!json || typeof json !== "object") return null;
  const w = json as OpenAlexRawWork;
  const title = str(w.title) ?? str(w.display_name);
  if (!title) return null;

  const rawDoi = w.doi ?? w.ids?.doi ?? null;
  const locations = [w.primary_location, w.best_oa_location, ...(Array.isArray(w.locations) ? w.locations : [])].filter(
    (l): l is NonNullable<OpenAlexLocation> => !!l && typeof l === "object",
  );

  let arxivId = normalizeArxivId(rawDoi);
  for (const loc of locations) {
    if (arxivId) break;
    arxivId = findArxivId(loc.landing_page_url ?? null) ?? findArxivId(loc.pdf_url ?? null);
  }

  const authors: PaperAuthor[] = [];
  for (const a of Array.isArray(w.authorships) ? w.authorships : []) {
    const name = str(a?.author?.display_name) ?? str(a?.raw_author_name);
    if (!name) continue;
    authors.push({ name, openalexId: normalizeOpenAlexAuthorId(a?.author?.id) });
  }

  const publishedAt = str(w.publication_date);
  const primary = w.primary_location ?? null;
  const pdfUrl =
    httpUrl(w.best_oa_location?.pdf_url) ??
    httpUrl(primary?.pdf_url) ??
    locations.map((l) => httpUrl(l.pdf_url)).find(Boolean) ??
    (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null);

  return {
    title,
    openalexId: normalizeOpenAlexId(w.id ?? w.ids?.openalex ?? null),
    doi: normalizeDoi(rawDoi),
    arxivId,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    authors,
    year: num(w.publication_year) ?? (publishedAt && /^\d{4}/.test(publishedAt) ? Number(publishedAt.slice(0, 4)) : null),
    publishedAt,
    venue: str(primary?.source?.display_name) ?? str(primary?.raw_source_name),
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
    pdfUrl,
    citationCount: num(w.cited_by_count),
    influentialCitationCount: null,
    source: "openalex",
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const defaultFetchJson: OpenAlexFetchJson = async <T>(url: string, opts: CachedHttpOptions) => {
  const http = await import("./http");
  return http.fetchJson<T>(url, opts);
};

function request<T>(url: string, o: OpenAlexRequestOptions): Promise<T> {
  const fetchJson = o.fetchJson ?? defaultFetchJson;
  const opts: CachedHttpOptions = { host: "openalex", signal: o.signal };
  if (o.cache) {
    opts.cache = {
      db: o.cache.db,
      source: "openalex",
      ttlMs: o.cache.ttlMs ?? API_CACHE_TTL_MS.metadata,
      bypass: o.cache.bypass,
    };
  }
  return fetchJson<T>(url, opts);
}

function listUrl(entity: "works" | "authors", filter: string, perPage: number, o: OpenAlexRequestOptions, select?: string) {
  const params = new URLSearchParams({ filter, "per-page": String(perPage) });
  if (select) params.set("select", select);
  const mailto = (o.mailto ?? process.env.OPENALEX_MAILTO ?? "").trim();
  if (mailto) params.set("mailto", mailto);
  return `${OPENALEX_API_BASE}/${entity}?${params.toString()}`;
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Works for many DOIs, keyed by normalized DOI. DOIs OpenAlex doesn't know are absent. */
export async function worksByDoi(dois: string[], opts: OpenAlexRequestOptions = {}): Promise<Map<string, OpenAlexPaper>> {
  // "|" and "," are filter syntax; a DOI containing them can't be expressed in an OR filter.
  const unique = [...new Set(dois.map((d) => normalizeDoi(d)).filter((d): d is string => !!d && !/[|,]/.test(d)))];
  const out = new Map<string, OpenAlexPaper>();
  for (const group of chunk(unique, OPENALEX_FILTER_MAX)) {
    const res = await request<OpenAlexList<OpenAlexRawWork>>(
      listUrl("works", `doi:${group.join("|")}`, OPENALEX_FILTER_MAX, opts),
      opts,
    );
    for (const raw of Array.isArray(res?.results) ? res.results : []) {
      const p = parseOpenAlexWork(raw);
      if (p?.doi && !out.has(p.doi)) out.set(p.doi, p);
    }
  }
  return out;
}

/** h-index per OpenAlex author id ("A123", URLs accepted). Unknown ids are absent. */
export async function authorHIndex(openalexAuthorIds: string[], opts: OpenAlexRequestOptions = {}): Promise<Map<string, number>> {
  const unique = [
    ...new Set(openalexAuthorIds.map((id) => normalizeOpenAlexAuthorId(id)).filter((id): id is string => !!id)),
  ];
  const out = new Map<string, number>();
  for (const group of chunk(unique, OPENALEX_FILTER_MAX)) {
    const res = await request<OpenAlexList<{ id?: string | null; summary_stats?: { h_index?: number | null } | null }>>(
      listUrl("authors", `ids.openalex:${group.join("|")}`, OPENALEX_FILTER_MAX, opts, "id,display_name,summary_stats"),
      opts,
    );
    for (const a of Array.isArray(res?.results) ? res.results : []) {
      const id = normalizeOpenAlexAuthorId(a?.id);
      const h = num(a?.summary_stats?.h_index);
      if (id && h != null) out.set(id, h);
    }
  }
  return out;
}

export type SearchOpenAlexOptions = OpenAlexRequestOptions & {
  /** Max works to return (one page; OpenAlex caps per-page at 200). */
  limit: number;
  /** Only works published on/after this "YYYY-MM-DD". */
  since?: string | null;
};

export const OPENALEX_PER_PAGE_MAX = 200;

/** Title/abstract search, most relevant first. `,` `|` `:` are filter syntax, so they're dropped from the query. */
export function openAlexSearchUrl(query: string, opts: Pick<SearchOpenAlexOptions, "limit" | "since" | "mailto">): string | null {
  const q = query.replace(/[,|:]+/g, " ").replace(/\s+/g, " ").trim();
  const limit = Math.min(OPENALEX_PER_PAGE_MAX, Math.max(0, Math.floor(opts.limit)));
  if (!q || limit === 0) return null;
  const filters = [`title_and_abstract.search:${q}`];
  if (opts.since && /^\d{4}-\d{2}-\d{2}/.test(opts.since)) filters.push(`from_publication_date:${opts.since.slice(0, 10)}`);
  const params = new URLSearchParams({ filter: filters.join(","), sort: "relevance_score:desc", "per-page": String(limit) });
  const mailto = (opts.mailto ?? process.env.OPENALEX_MAILTO ?? "").trim();
  if (mailto) params.set("mailto", mailto);
  return `${OPENALEX_API_BASE}/works?${params.toString()}`;
}

/**
 * Keyword search over titles and abstracts. Used by collect as a fallback when
 * arXiv and Semantic Scholar are both unavailable (e.g. rate limited without an S2 key).
 */
export async function searchOpenAlex(query: string, opts: SearchOpenAlexOptions): Promise<OpenAlexPaper[]> {
  const url = openAlexSearchUrl(query, opts);
  if (!url) return [];
  const res = await request<OpenAlexList<OpenAlexRawWork>>(url, {
    ...opts,
    cache: opts.cache ? { ...opts.cache, ttlMs: opts.cache.ttlMs ?? API_CACHE_TTL_MS.search } : undefined,
  });
  const out: OpenAlexPaper[] = [];
  for (const raw of Array.isArray(res?.results) ? res.results : []) {
    const p = parseOpenAlexWork(raw);
    if (p) out.push(p);
  }
  return out;
}
