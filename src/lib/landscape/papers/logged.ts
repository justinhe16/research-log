import { asc } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { entries } from "@/lib/db/schema";
import { findArxivId, normalizeArxivId, normalizeDoi } from "@/lib/landscape/ids";

/*
 * "Already logged" markers: match landscape papers against the Logs `entries`
 * table by arXiv id, DOI, or normalized URL.
 */

export type LoggedIndex = Map<string, string>;

/** Host lowercased; no scheme, "www.", query, hash, or trailing slash. */
export function normalizeUrlKey(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "");
  const slash = s.indexOf("/");
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase().replace(/^www\./, "");
  const rest = slash === -1 ? "" : s.slice(slash);
  const key = (host + rest).replace(/\/+$/, "");
  return key || null;
}

function keysForUrl(url: string): string[] {
  const keys: string[] = [];
  const arxiv = findArxivId(url);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  const doi = normalizeDoi(url);
  if (doi) keys.push(`doi:${doi}`);
  const u = normalizeUrlKey(url);
  if (u) keys.push(`url:${u}`);
  return keys;
}

/** key ("arxiv:<id>" | "doi:<doi>" | "url:<normalized>") -> entry id. Oldest entry wins. */
export function loggedIndex(db: Db): LoggedIndex {
  const index: LoggedIndex = new Map();
  const rows = db
    .select({ id: entries.id, url: entries.url })
    .from(entries)
    .orderBy(asc(entries.createdAt))
    .all();
  for (const row of rows) {
    for (const key of keysForUrl(row.url)) {
      if (!index.has(key)) index.set(key, row.id);
    }
  }
  return index;
}

/** Entry id that logs this paper, or null. */
export function loggedEntryIdFor(
  index: LoggedIndex,
  paper: {
    arxivId?: string | null;
    doi?: string | null;
    arxivUrl?: string | null;
    pdfUrl?: string | null;
  },
): string | null {
  const keys: string[] = [];
  const arxiv =
    normalizeArxivId(paper.arxivId) ?? findArxivId(paper.arxivUrl) ?? findArxivId(paper.pdfUrl);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  const doi = normalizeDoi(paper.doi);
  if (doi) keys.push(`doi:${doi}`);
  for (const u of [paper.arxivUrl, paper.pdfUrl]) {
    const k = normalizeUrlKey(u);
    if (k) keys.push(`url:${k}`);
  }
  for (const k of keys) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}
