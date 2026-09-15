/**
 * Semantic Scholar Academic Graph API client (search, batch metadata, citation
 * expansion, author h-index) plus pure response parsers.
 *
 * Server-only. Network goes through `./http` (rate limiting, retries, api_cache,
 * `x-api-key`); tests inject `fetchJson` so they never touch it.
 *
 * API facts (checked against graph/v1/swagger.json):
 *  - /paper/search: limit <= 100, `offset` paging, `next` absent on the last page;
 *    offset + limit must stay under 1000. `year` = "2019" | "2016-2020" | "2010-" | "-2015";
 *    `publicationDateOrYear` = "YYYY-MM-DD:" style ranges.
 *  - POST /paper/batch: <= 500 ids, body `{ids}`, response is an array aligned with
 *    the ids (null for unknown ids). Ids may be S2 ids, "ARXIV:x", "DOI:x", ...
 *  - /paper/{id}/references|citations: limit <= 1000, items carry `isInfluential`,
 *    `intents`, `contexts` and `citedPaper` / `citingPaper`.
 *  - POST /author/batch: <= 1000 ids; `hIndex`, `citationCount` are author fields.
 *  - `authors.hIndex` is only valid on FullPaper responses (/paper/{id}, /paper/batch).
 *    Search and the nested papers in references/citations only expose
 *    `authors.authorId,name` -- use `batchAuthors` for h-index there.
 */
import type { Db } from "@/lib/db/create";
import { API_CACHE_TTL_MS, S2_BATCH_SIZE } from "../constants";
import { normalizeArxivId, normalizeDoi } from "../ids";
import type { PaperAuthor, PaperInput } from "../types";
import type { CachedHttpOptions } from "./http";

export const S2_API_BASE = "https://api.semanticscholar.org/graph/v1";
export const S2_SEARCH_PAGE_MAX = 100;
/** /paper/search rejects offset + limit >= 1000. */
export const S2_SEARCH_WINDOW = 1000;
export const S2_CITATIONS_PAGE_MAX = 1000;
export const S2_AUTHOR_BATCH_MAX = 1000;

/** Fields valid on every paper shape (search, batch, nested citation papers). */
export const S2_PAPER_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "venue",
  "year",
  "publicationDate",
  "citationCount",
  "influentialCitationCount",
  "referenceCount",
  "openAccessPdf",
  "authors",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type S2FetchJson = <T>(url: string, opts: CachedHttpOptions) => Promise<T>;

export type S2CacheOptions = { db?: Db; ttlMs?: number; bypass?: boolean };

export type S2RequestOptions = {
  fetchJson?: S2FetchJson;
  /** Enables api_cache; `source` is fixed to "s2". */
  cache?: S2CacheOptions;
  signal?: AbortSignal;
};

export type S2RawAuthor = {
  authorId?: string | null;
  name?: string | null;
  hIndex?: number | null;
  citationCount?: number | null;
};

export type S2RawPaper = {
  paperId?: string | null;
  externalIds?: Record<string, string | number | null> | null;
  title?: string | null;
  abstract?: string | null;
  venue?: string | null;
  publicationVenue?: { name?: string | null } | null;
  journal?: { name?: string | null } | null;
  year?: number | null;
  publicationDate?: string | null;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  referenceCount?: number | null;
  openAccessPdf?: { url?: string | null; status?: string | null } | null;
  authors?: S2RawAuthor[] | null;
};

type S2Page<T> = { total?: number; offset?: number; next?: number; data?: T[] | null };

type S2CitationEdge = {
  isInfluential?: boolean | null;
  intents?: string[] | null;
  contexts?: string[] | null;
  citedPaper?: S2RawPaper | null;
  citingPaper?: S2RawPaper | null;
};

/** A parsed S2 paper. `referenceCount` is an S2-only extra (not stored in `papers`). */
export type S2Paper = PaperInput & { s2Id: string | null; source: "s2"; referenceCount: number | null };

export type S2CitationLink = {
  paper: S2Paper;
  isInfluential: boolean;
  /** e.g. ["methodology", "background", "result"]. */
  intents: string[];
};

export type S2AuthorMetrics = { authorId: string; hIndex: number | null; citationCount: number | null };

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

function externalId(ext: S2RawPaper["externalIds"], key: string): string | null {
  if (!ext || typeof ext !== "object") return null;
  const hit = Object.entries(ext).find(([k]) => k.toLowerCase() === key.toLowerCase());
  const v = hit?.[1];
  return v == null ? null : String(v);
}

/** Parse one S2 paper object. Returns null when there is no usable title. */
export function parseS2Paper(json: unknown): S2Paper | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as S2RawPaper;
  const title = str(raw.title);
  if (!title) return null;

  const rawDoi = externalId(raw.externalIds, "DOI");
  const arxivId = normalizeArxivId(externalId(raw.externalIds, "ArXiv")) ?? normalizeArxivId(rawDoi);

  const authors: PaperAuthor[] = [];
  for (const a of Array.isArray(raw.authors) ? raw.authors : []) {
    const name = str(a?.name);
    if (!name) continue;
    const author: PaperAuthor = { name, s2Id: str(a.authorId) };
    const h = num(a.hIndex);
    if (h != null) author.hIndex = h;
    authors.push(author);
  }
  const hs = authors.map((a) => a.hIndex).filter((h): h is number => typeof h === "number");

  const publishedAt = str(raw.publicationDate);
  const year = num(raw.year) ?? (publishedAt && /^\d{4}/.test(publishedAt) ? Number(publishedAt.slice(0, 4)) : null);
  const pdfUrl = str(raw.openAccessPdf?.url);

  return {
    title,
    s2Id: str(raw.paperId),
    arxivId,
    doi: normalizeDoi(rawDoi),
    abstract: str(raw.abstract),
    authors,
    year,
    publishedAt,
    venue: str(raw.venue) ?? str(raw.publicationVenue?.name) ?? str(raw.journal?.name),
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
    pdfUrl: pdfUrl && /^https?:\/\//i.test(pdfUrl) ? pdfUrl : null,
    citationCount: num(raw.citationCount),
    influentialCitationCount: num(raw.influentialCitationCount),
    referenceCount: num(raw.referenceCount),
    maxAuthorHIndex: hs.length ? Math.max(...hs) : null,
    source: "s2",
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const defaultFetchJson: S2FetchJson = async <T>(url: string, opts: CachedHttpOptions) => {
  const http = await import("./http");
  return http.fetchJson<T>(url, opts);
};

function request<T>(url: string, ttlMs: number, o: S2RequestOptions, json?: unknown): Promise<T> {
  const fetchJson = o.fetchJson ?? defaultFetchJson;
  const opts: CachedHttpOptions = { host: "s2", signal: o.signal };
  if (json !== undefined) {
    opts.method = "POST";
    opts.json = json;
  }
  if (o.cache) {
    opts.cache = { db: o.cache.db, source: "s2", ttlMs: o.cache.ttlMs ?? ttlMs, bypass: o.cache.bypass };
  }
  return fetchJson<T>(url, opts);
}

function fieldList(fields: readonly string[] | undefined): string {
  return (fields && fields.length ? fields : S2_PAPER_FIELDS).join(",");
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export type SearchS2Options = S2RequestOptions & {
  /** Max papers to return (capped by the 1000-result search window). */
  limit: number;
  /** Only papers published on/after this "YYYY-MM-DD" (refresh). */
  since?: string | null;
  yearRange?: { from?: number | null; to?: number | null } | null;
  fields?: readonly string[];
};

/** S2 `year` param: "2019-2023", "2019-", "-2023", or null for no bound. */
export function s2YearParam(range: SearchS2Options["yearRange"]): string | null {
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  if (from == null && to == null) return null;
  if (from != null && to != null && from === to) return String(from);
  return `${from ?? ""}-${to ?? ""}`;
}

/** S2 search results in relevance order, paginated until `limit` or exhaustion. */
export async function searchS2(query: string, opts: SearchS2Options): Promise<S2Paper[]> {
  const q = query.trim();
  const limit = Math.min(Math.max(0, Math.floor(opts.limit)), S2_SEARCH_WINDOW - 1);
  if (!q || limit === 0) return [];

  const out: S2Paper[] = [];
  let offset = 0;
  while (out.length < limit && offset < S2_SEARCH_WINDOW - 1) {
    const pageSize = Math.min(S2_SEARCH_PAGE_MAX, limit - out.length, S2_SEARCH_WINDOW - 1 - offset);
    if (pageSize <= 0) break;
    const params = new URLSearchParams({
      query: q,
      offset: String(offset),
      limit: String(pageSize),
      fields: fieldList(opts.fields),
    });
    const year = s2YearParam(opts.yearRange);
    if (year) params.set("year", year);
    if (opts.since) params.set("publicationDateOrYear", `${opts.since}:`);

    const page = await request<S2Page<S2RawPaper>>(
      `${S2_API_BASE}/paper/search?${params.toString()}`,
      API_CACHE_TTL_MS.search,
      opts,
    );
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const raw of data) {
      const p = parseS2Paper(raw);
      if (p) out.push(p);
      if (out.length >= limit) break;
    }
    if (data.length === 0 || typeof page.next !== "number" || page.next <= offset) break;
    offset = page.next;
  }
  return out.slice(0, limit);
}

/**
 * Metadata for many papers. Result is aligned with `ids` (null = unknown to S2).
 * Ids may be S2 paper ids, "ARXIV:2401.01234", "DOI:10.x/y", "CorpusId:123", ...
 */
export async function batchPapers(
  ids: string[],
  fields?: readonly string[],
  opts: S2RequestOptions = {},
): Promise<(S2Paper | null)[]> {
  const out: (S2Paper | null)[] = [];
  const url = `${S2_API_BASE}/paper/batch?fields=${encodeURIComponent(fieldList(fields))}`;
  for (const group of chunk(ids, Math.min(S2_BATCH_SIZE, 500))) {
    const res = await request<(S2RawPaper | null)[]>(url, API_CACHE_TTL_MS.metadata, opts, { ids: group });
    const arr = Array.isArray(res) ? res : [];
    for (let i = 0; i < group.length; i++) out.push(parseS2Paper(arr[i] ?? null));
  }
  return out;
}

export type CitationListOptions = S2RequestOptions & {
  /** Max links to return. */
  limit: number;
  /** Fields for the nested paper (no `authors.hIndex` here). */
  fields?: readonly string[];
};

async function citationList(
  paperId: string,
  kind: "references" | "citations",
  opts: CitationListOptions,
): Promise<S2CitationLink[]> {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (!paperId.trim() || limit === 0) return [];
  const nestedKey = kind === "references" ? "citedPaper" : "citingPaper";
  const fields = ["isInfluential", "intents", ...(opts.fields?.length ? opts.fields : S2_PAPER_FIELDS)].join(",");

  const out: S2CitationLink[] = [];
  let offset = 0;
  while (out.length < limit) {
    const pageSize = Math.min(S2_CITATIONS_PAGE_MAX, limit - out.length);
    const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize), fields });
    const page = await request<S2Page<S2CitationEdge>>(
      `${S2_API_BASE}/paper/${encodeURIComponent(paperId.trim())}/${kind}?${params.toString()}`,
      API_CACHE_TTL_MS.citations,
      opts,
    );
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const edge of data) {
      // Unresolved references come back as a paper with a null paperId; skip them.
      const paper = parseS2Paper(edge?.[nestedKey]);
      if (!paper || !paper.s2Id) continue;
      out.push({
        paper,
        isInfluential: edge.isInfluential === true,
        intents: Array.isArray(edge.intents) ? edge.intents.filter((x): x is string => typeof x === "string") : [],
      });
      if (out.length >= limit) break;
    }
    if (data.length === 0 || typeof page.next !== "number" || page.next <= offset) break;
    offset = page.next;
  }
  return out;
}

/** Papers `paperId` cites (outgoing), capped at `limit`. */
export function references(paperId: string, opts: CitationListOptions): Promise<S2CitationLink[]> {
  return citationList(paperId, "references", opts);
}

/** Papers citing `paperId` (incoming), capped at `limit`. */
export function citations(paperId: string, opts: CitationListOptions): Promise<S2CitationLink[]> {
  return citationList(paperId, "citations", opts);
}

/** h-index and citation count per S2 author id. Unknown ids are omitted from the map. */
export async function batchAuthors(ids: string[], opts: S2RequestOptions = {}): Promise<Map<string, S2AuthorMetrics>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, S2AuthorMetrics>();
  const url = `${S2_API_BASE}/author/batch?fields=${encodeURIComponent("name,hIndex,citationCount")}`;
  for (const group of chunk(unique, S2_AUTHOR_BATCH_MAX)) {
    const res = await request<(S2RawAuthor | null)[]>(url, API_CACHE_TTL_MS.metadata, opts, { ids: group });
    const arr = Array.isArray(res) ? res : [];
    for (let i = 0; i < group.length; i++) {
      const a = arr[i];
      if (!a) continue;
      const authorId = str(a.authorId) ?? group[i];
      out.set(authorId, { authorId, hIndex: num(a.hIndex), citationCount: num(a.citationCount) });
    }
  }
  return out;
}
