import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { papers, searchDocuments, type NewPaperRow, type PaperRow } from "@/lib/db/schema";
import { remapDocumentPaperIds } from "@/lib/landscape/documents/remap";
import {
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizeTitle,
} from "@/lib/landscape/ids";
import type { PaperAuthor, PaperInput } from "@/lib/landscape/types";

/*
 * The deduplicated `papers` table. Every source record goes through
 * `upsertPaper`, which resolves it to exactly one row:
 *
 *   1. match on any external id (arXiv / DOI / S2 / OpenAlex);
 *   2. otherwise fall back to norm_title + year ±1 + first-author last name;
 *   3. 0 matches insert, 1 match fills in, >1 matches merge into the oldest row.
 *
 * All writes are synchronous (better-sqlite3). Transactions use the native
 * client's `transaction()`, which nests as savepoints, so these helpers compose
 * inside a caller's transaction.
 */

/** Titles shorter than this (in words) are too generic for the fuzzy fallback. */
const MIN_FALLBACK_TITLE_WORDS = 4;
const UPSERT_CHUNK = 200;
const IN_CHUNK = 500;

export type PaperMetrics = {
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  maxAuthorHIndex?: number | null;
};

type NormalizedInput = {
  title: string;
  normTitle: string;
  arxivId: string | null;
  doi: string | null;
  s2Id: string | null;
  openalexId: string | null;
  abstract: string | null;
  authors: PaperAuthor[];
  year: number | null;
  publishedAt: string | null;
  venue: string | null;
  arxivUrl: string | null;
  pdfUrl: string | null;
  citationCount: number | null;
  influentialCitationCount: number | null;
  maxAuthorHIndex: number | null;
  fromArxiv: boolean;
};

function tx<T>(db: Db, fn: () => T): T {
  return db.$client.transaction(fn)();
}

/** Empty/whitespace strings become null: SQLite UNIQUE treats "" as a real value. */
function str(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s || null;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function maxNum(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** arXiv-minted DOI (10.48550/arXiv.X). Never stored in the doi slot: it would
 *  block the published journal DOI, and the arXiv id already identifies it. */
function isArxivDoi(doi: string | null | undefined): boolean {
  return typeof doi === "string" && /^10\.48550\/arxiv\./i.test(doi);
}

function normalizeInput(input: PaperInput): NormalizedInput {
  const title = str(input.title) ?? "";
  const s2 = str(input.s2Id);
  const doi = normalizeDoi(input.doi) || null;
  return {
    title,
    normTitle: normalizeTitle(title),
    arxivId: normalizeArxivId(input.arxivId) || (doi && isArxivDoi(doi) ? normalizeArxivId(doi) : null) || null,
    doi: doi && !isArxivDoi(doi) ? doi : null,
    s2Id: s2 || null,
    openalexId: normalizeOpenAlexId(input.openalexId) || null,
    abstract: str(input.abstract),
    authors: Array.isArray(input.authors) ? input.authors.filter((a) => str(a?.name)) : [],
    year: num(input.year),
    publishedAt: str(input.publishedAt),
    venue: str(input.venue),
    arxivUrl: str(input.arxivUrl),
    pdfUrl: str(input.pdfUrl),
    citationCount: num(input.citationCount),
    influentialCitationCount: num(input.influentialCitationCount),
    maxAuthorHIndex: num(input.maxAuthorHIndex),
    fromArxiv: input.source === "arxiv",
  };
}

/** Normalized last name of an author ("Vaswani, Ashish" and "Ashish Vaswani" agree). */
export function authorLastName(name: string | null | undefined): string {
  if (typeof name !== "string") return "";
  const raw = name.includes(",") ? name.split(",")[0] : name;
  const parts = normalizeTitle(raw).split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function authorKey(name: string): string {
  return normalizeTitle(name);
}

/** Existing order wins; missing extra fields are filled from same-named incoming authors. */
function mergeAuthors(existing: PaperAuthor[], incoming: PaperAuthor[]): PaperAuthor[] {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  const byName = new Map<string, PaperAuthor>();
  for (const a of incoming) {
    const k = authorKey(a.name);
    if (k && !byName.has(k)) byName.set(k, a);
  }
  return existing.map((a) => {
    const other = byName.get(authorKey(a.name));
    if (!other) return a;
    const merged: PaperAuthor = { ...a };
    if (merged.s2Id == null && other.s2Id != null) merged.s2Id = other.s2Id;
    if (merged.openalexId == null && other.openalexId != null) merged.openalexId = other.openalexId;
    merged.hIndex = maxNum(num(a.hIndex), num(other.hIndex)) ?? a.hIndex;
    return merged;
  });
}

/**
 * Abstract preference. The row doesn't record where its abstract came from, so:
 * an arXiv-sourced abstract always wins; otherwise a new abstract only replaces an
 * empty one, or a shorter one on a row without an arXiv id (so it can't have been
 * an arXiv abstract).
 */
function pickAbstract(
  current: string | null,
  currentHasArxiv: boolean,
  incoming: string | null,
  incomingFromArxiv: boolean,
): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incomingFromArxiv) return incoming;
  if (!currentHasArxiv && incoming.length > current.length) return incoming;
  return current;
}

function isFallbackMatch(row: PaperRow, n: NormalizedInput): boolean {
  if (row.year == null || n.year == null || Math.abs(row.year - n.year) > 1) return false;
  const a = authorLastName(row.authors?.[0]?.name);
  const b = authorLastName(n.authors[0]?.name);
  if (!a || !b || a !== b) return false;
  // A conflicting external id means a genuinely different record (e.g. two arXiv papers).
  const conflict = (x: string | null, y: string | null) => x != null && y != null && x !== y;
  const rowDoi = isArxivDoi(row.doi) ? null : row.doi;
  const rowArxiv = row.arxivId ?? (isArxivDoi(row.doi) ? normalizeArxivId(row.doi) : null);
  return !(
    conflict(rowArxiv, n.arxivId) ||
    conflict(rowDoi, n.doi) ||
    conflict(row.s2Id, n.s2Id) ||
    conflict(row.openalexId, n.openalexId)
  );
}

function findMatches(db: Db, n: NormalizedInput): PaperRow[] {
  const conds: SQL[] = [];
  if (n.arxivId) {
    conds.push(eq(papers.arxivId, n.arxivId));
    // Legacy rows may hold the arXiv DOI in the doi slot.
    conds.push(eq(papers.doi, `10.48550/arxiv.${n.arxivId.toLowerCase()}`));
  }
  if (n.doi) conds.push(eq(papers.doi, n.doi));
  if (n.s2Id) conds.push(eq(papers.s2Id, n.s2Id));
  if (n.openalexId) conds.push(eq(papers.openalexId, n.openalexId));
  if (conds.length) {
    const rows = db
      .select()
      .from(papers)
      .where(or(...conds))
      .orderBy(asc(papers.createdAt), sql`rowid`)
      .all();
    if (rows.length) return rows;
  }

  const words = n.normTitle ? n.normTitle.split(" ").length : 0;
  if (words < MIN_FALLBACK_TITLE_WORDS) return [];
  return db
    .select()
    .from(papers)
    .where(eq(papers.normTitle, n.normTitle))
    .orderBy(asc(papers.createdAt), sql`rowid`)
    .all()
    .filter((row) => isFallbackMatch(row, n));
}

/** Fold a normalized input into a row's fields (fill nulls, max metrics). */
function foldInto(row: PaperRow, n: NormalizedInput): Partial<NewPaperRow> {
  const next: Partial<NewPaperRow> = {
    arxivId: row.arxivId ?? n.arxivId ?? (isArxivDoi(row.doi) ? normalizeArxivId(row.doi) : null),
    doi: row.doi && !isArxivDoi(row.doi) ? row.doi : (n.doi ?? row.doi),
    s2Id: row.s2Id ?? n.s2Id,
    openalexId: row.openalexId ?? n.openalexId,
    abstract: pickAbstract(row.abstract, row.arxivId != null, n.abstract, n.fromArxiv),
    authors: mergeAuthors(row.authors ?? [], n.authors),
    year: row.year ?? n.year,
    publishedAt: row.publishedAt ?? n.publishedAt,
    venue: row.venue ?? n.venue,
    arxivUrl: row.arxivUrl ?? n.arxivUrl,
    pdfUrl: row.pdfUrl ?? n.pdfUrl,
    citationCount: maxNum(row.citationCount, n.citationCount),
    influentialCitationCount: maxNum(row.influentialCitationCount, n.influentialCitationCount),
    maxAuthorHIndex: maxNum(row.maxAuthorHIndex, n.maxAuthorHIndex),
  };
  if (!row.title && n.title) {
    next.title = n.title;
    next.normTitle = n.normTitle;
  }
  const hasMetrics =
    n.citationCount != null || n.influentialCitationCount != null || n.maxAuthorHIndex != null;
  if (hasMetrics) next.metricsUpdatedAt = sql`CURRENT_TIMESTAMP` as unknown as string;
  return next;
}

function rowToInput(row: PaperRow): NormalizedInput {
  return {
    title: row.title,
    normTitle: row.normTitle,
    arxivId: row.arxivId,
    doi: row.doi,
    s2Id: row.s2Id,
    openalexId: row.openalexId,
    abstract: row.abstract,
    authors: row.authors ?? [],
    year: row.year,
    publishedAt: row.publishedAt,
    venue: row.venue,
    arxivUrl: row.arxivUrl,
    pdfUrl: row.pdfUrl,
    citationCount: row.citationCount,
    influentialCitationCount: row.influentialCitationCount,
    maxAuthorHIndex: row.maxAuthorHIndex,
    fromArxiv: false,
  };
}

function upsertOne(db: Db, input: PaperInput): string {
  const n = normalizeInput(input);
  if (!n.title) throw new Error("upsertPaper: title is required");

  const matches = findMatches(db, n);

  if (matches.length === 0) {
    const id = crypto.randomUUID();
    db.insert(papers)
      .values({
        id,
        arxivId: n.arxivId,
        doi: n.doi,
        s2Id: n.s2Id,
        openalexId: n.openalexId,
        normTitle: n.normTitle,
        title: n.title,
        abstract: n.abstract,
        authors: n.authors,
        year: n.year,
        publishedAt: n.publishedAt,
        venue: n.venue,
        arxivUrl: n.arxivUrl,
        pdfUrl: n.pdfUrl,
        citationCount: n.citationCount,
        influentialCitationCount: n.influentialCitationCount,
        maxAuthorHIndex: n.maxAuthorHIndex,
        metricsUpdatedAt:
          n.citationCount != null || n.influentialCitationCount != null || n.maxAuthorHIndex != null
            ? (sql`CURRENT_TIMESTAMP` as unknown as string)
            : null,
      })
      .run();
    return id;
  }

  let keeper = matches[0];
  if (matches.length > 1) {
    mergeInto(
      db,
      keeper.id,
      matches.slice(1).map((m) => m.id),
    );
    keeper = db.select().from(papers).where(eq(papers.id, keeper.id)).get()!;
  }

  db.update(papers)
    .set({ ...foldInto(keeper, n), updatedAt: sql`CURRENT_TIMESTAMP` as unknown as string })
    .where(eq(papers.id, keeper.id))
    .run();
  return keeper.id;
}

/** Resolve one source record to a paper id (insert, fill in, or merge). */
export function upsertPaper(db: Db, input: PaperInput): string {
  return tx(db, () => upsertOne(db, input));
}

/**
 * Upsert many records in chunked transactions; returns ids in input order.
 * Cost is per row: each input runs one indexed id lookup (plus a norm_title
 * lookup when no id matches) and one insert/update, so ~2-3 statements per
 * paper. Fine for a few thousand candidates; chunking just bounds lock time.
 */
export function upsertPapers(db: Db, inputs: PaperInput[]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < inputs.length; i += UPSERT_CHUNK) {
    const chunk = inputs.slice(i, i + UPSERT_CHUNK);
    tx(db, () => {
      for (const input of chunk) ids.push(upsertOne(db, input));
    });
  }
  return ids;
}

function mergeInto(db: Db, keepId: string, dropIds: string[]): void {
  const drops = [...new Set(dropIds)].filter((d) => d !== keepId);
  if (!drops.length) return;

  const keep = db.select().from(papers).where(eq(papers.id, keepId)).get();
  if (!keep) throw new Error(`mergePapers: paper ${keepId} not found`);
  const dropRows = db
    .select()
    .from(papers)
    .where(inArray(papers.id, drops))
    .orderBy(asc(papers.createdAt), sql`rowid`)
    .all();
  if (!dropRows.length) return;

  // Fold every dropped row's facts into the keeper (in memory first).
  let folded: PaperRow = keep;
  for (const d of dropRows) {
    const patch = foldInto(folded, rowToInput(d));
    delete patch.metricsUpdatedAt;
    folded = { ...folded, ...patch } as PaperRow;
    if (d.metricsUpdatedAt && (!folded.metricsUpdatedAt || d.metricsUpdatedAt > folded.metricsUpdatedAt)) {
      folded.metricsUpdatedAt = d.metricsUpdatedAt;
    }
  }

  for (const d of dropRows) {
    const drop = d.id;

    // search_papers (PK search_id, paper_id): fold conflicting rows into the keeper's.
    db.run(sql`
      UPDATE search_papers AS k SET
        selected = max(k.selected, d.selected),
        foundational = max(k.foundational, d.foundational),
        game_changer = max(k.game_changer, d.game_changer),
        source_rank = coalesce(min(k.source_rank, d.source_rank), k.source_rank, d.source_rank),
        final_rank = coalesce(min(k.final_rank, d.final_rank), k.final_rank, d.final_rank),
        bm25 = coalesce(k.bm25, d.bm25),
        cosine = coalesce(k.cosine, d.cosine),
        rrf = coalesce(k.rrf, d.rrf),
        rerank = coalesce(k.rerank, d.rerank),
        citation_count = coalesce(max(k.citation_count, d.citation_count), k.citation_count, d.citation_count),
        influential_citation_count = coalesce(max(k.influential_citation_count, d.influential_citation_count), k.influential_citation_count, d.influential_citation_count),
        velocity = coalesce(k.velocity, d.velocity),
        pagerank = coalesce(k.pagerank, d.pagerank),
        max_author_h_index = coalesce(max(k.max_author_h_index, d.max_author_h_index), k.max_author_h_index, d.max_author_h_index),
        influence = coalesce(k.influence, d.influence),
        cluster_idx = coalesce(k.cluster_idx, d.cluster_idx),
        extraction_id = coalesce(k.extraction_id, d.extraction_id)
      FROM search_papers AS d
      WHERE k.paper_id = ${keepId} AND d.paper_id = ${drop} AND d.search_id = k.search_id
    `);
    db.run(sql`UPDATE OR IGNORE search_papers SET paper_id = ${keepId} WHERE paper_id = ${drop}`);
    db.run(sql`DELETE FROM search_papers WHERE paper_id = ${drop}`);

    // paper_extractions (unique paper_id, version, source, source_hash): point
    // references at the keeper's equivalent before the duplicate is deleted.
    db.run(sql`
      UPDATE search_papers SET extraction_id = (
        SELECT k.id FROM paper_extractions d JOIN paper_extractions k
          ON k.paper_id = ${keepId} AND k.version = d.version
          AND k.source = d.source AND k.source_hash = d.source_hash
        WHERE d.id = search_papers.extraction_id
      )
      WHERE extraction_id IN (
        SELECT d.id FROM paper_extractions d JOIN paper_extractions k
          ON k.paper_id = ${keepId} AND k.version = d.version
          AND k.source = d.source AND k.source_hash = d.source_hash
        WHERE d.paper_id = ${drop}
      )
    `);
    db.run(sql`UPDATE OR IGNORE paper_extractions SET paper_id = ${keepId} WHERE paper_id = ${drop}`);
    db.run(sql`DELETE FROM paper_extractions WHERE paper_id = ${drop}`);

    // paper_citations (PK citing_id, cited_id), both directions.
    db.run(sql`
      UPDATE paper_citations AS k SET is_influential = max(k.is_influential, d.is_influential)
      FROM paper_citations AS d
      WHERE d.citing_id = ${drop} AND k.citing_id = ${keepId} AND k.cited_id = d.cited_id
    `);
    db.run(sql`
      UPDATE paper_citations AS k SET is_influential = max(k.is_influential, d.is_influential)
      FROM paper_citations AS d
      WHERE d.cited_id = ${drop} AND k.cited_id = ${keepId} AND k.citing_id = d.citing_id
    `);
    db.run(sql`UPDATE OR IGNORE paper_citations SET citing_id = ${keepId} WHERE citing_id = ${drop}`);
    db.run(sql`UPDATE OR IGNORE paper_citations SET cited_id = ${keepId} WHERE cited_id = ${drop}`);
    db.run(sql`DELETE FROM paper_citations WHERE citing_id = ${drop} OR cited_id = ${drop}`);
    db.run(sql`DELETE FROM paper_citations WHERE citing_id = ${keepId} AND cited_id = ${keepId}`);

    // search_edges (PK search_id, source_id, target_id, kind), both directions.
    db.run(sql`
      UPDATE search_edges AS k SET weight = max(k.weight, d.weight)
      FROM search_edges AS d
      WHERE d.source_id = ${drop} AND k.source_id = ${keepId}
        AND k.search_id = d.search_id AND k.target_id = d.target_id AND k.kind = d.kind
    `);
    db.run(sql`
      UPDATE search_edges AS k SET weight = max(k.weight, d.weight)
      FROM search_edges AS d
      WHERE d.target_id = ${drop} AND k.target_id = ${keepId}
        AND k.search_id = d.search_id AND k.source_id = d.source_id AND k.kind = d.kind
    `);
    db.run(sql`UPDATE OR IGNORE search_edges SET source_id = ${keepId} WHERE source_id = ${drop}`);
    db.run(sql`UPDATE OR IGNORE search_edges SET target_id = ${keepId} WHERE target_id = ${drop}`);
    db.run(sql`DELETE FROM search_edges WHERE source_id = ${drop} OR target_id = ${drop}`);
    db.run(sql`DELETE FROM search_edges WHERE source_id = ${keepId} AND target_id = ${keepId}`);

    // paper_fulltext (PK paper_id): the keeper's own text wins.
    db.run(sql`UPDATE OR IGNORE paper_fulltext SET paper_id = ${keepId} WHERE paper_id = ${drop}`);
    db.run(sql`DELETE FROM paper_fulltext WHERE paper_id = ${drop}`);
  }

  remapDocumentsInto(db, keepId, dropRows.map((d) => d.id));

  // Clear ids on the dropped rows first so the keeper can take them without
  // tripping the unique indexes, then write the keeper and delete the rest.
  db.update(papers)
    .set({ arxivId: null, doi: null, s2Id: null, openalexId: null })
    .where(inArray(papers.id, dropRows.map((d) => d.id)))
    .run();

  db.update(papers)
    .set({
      arxivId: folded.arxivId,
      doi: folded.doi,
      s2Id: folded.s2Id,
      openalexId: folded.openalexId,
      abstract: folded.abstract,
      authors: folded.authors,
      year: folded.year,
      publishedAt: folded.publishedAt,
      venue: folded.venue,
      arxivUrl: folded.arxivUrl,
      pdfUrl: folded.pdfUrl,
      citationCount: folded.citationCount,
      influentialCitationCount: folded.influentialCitationCount,
      maxAuthorHIndex: folded.maxAuthorHIndex,
      metricsUpdatedAt: folded.metricsUpdatedAt,
      embedding: keep.embedding ?? dropRows.find((d) => d.embedding)?.embedding ?? null,
      updatedAt: sql`CURRENT_TIMESTAMP` as unknown as string,
    })
    .where(eq(papers.id, keepId))
    .run();

  db.delete(papers)
    .where(inArray(papers.id, dropRows.map((d) => d.id)))
    .run();
}

/** Rewrite paper ids embedded in `search_documents.data` from dropped ids to the
 *  keeper. The LIKE prefilter keeps this from rewriting every stored document. */
function remapDocumentsInto(db: Db, keepId: string, dropIds: string[]): void {
  const dropped = new Set(dropIds);
  for (let i = 0; i < dropIds.length; i += IN_CHUNK) {
    const chunk = dropIds.slice(i, i + IN_CHUNK);
    const rows = db
      .select({ searchId: searchDocuments.searchId, kind: searchDocuments.kind, data: searchDocuments.data })
      .from(searchDocuments)
      .where(
        or(...chunk.map((id) => sql`${searchDocuments.data} LIKE ${`%"${id.replace(/[\\%_]/g, "\\$&")}"%`} ESCAPE '\\'`)),
      )
      .all();
    for (const row of rows) {
      if (row.data == null) continue;
      const next = remapDocumentPaperIds(row.kind, row.data, (id) => (dropped.has(id) ? keepId : id));
      if (JSON.stringify(next) === JSON.stringify(row.data)) continue;
      db.update(searchDocuments)
        .set({ data: next, updatedAt: new Date().toISOString() })
        .where(and(eq(searchDocuments.searchId, row.searchId), eq(searchDocuments.kind, row.kind)))
        .run();
    }
  }
}

/**
 * Merge `dropIds` into `keepId`: child rows (search_papers, search_edges,
 * paper_extractions, paper_citations, paper_fulltext) are repointed with
 * conflict-aware updates, ids and metadata are coalesced, dropped rows deleted.
 */
export function mergePapers(db: Db, keepId: string, dropIds: string[]): void {
  tx(db, () => mergeInto(db, keepId, dropIds));
}

/** Overwrite the latest metrics with the provided (non-null) values. */
export function updatePaperMetrics(db: Db, id: string, metrics: PaperMetrics): void {
  const set: Partial<NewPaperRow> = {};
  if (num(metrics.citationCount) != null) set.citationCount = metrics.citationCount;
  if (num(metrics.influentialCitationCount) != null)
    set.influentialCitationCount = metrics.influentialCitationCount;
  if (num(metrics.maxAuthorHIndex) != null) set.maxAuthorHIndex = metrics.maxAuthorHIndex;
  if (!Object.keys(set).length) return;
  db.update(papers)
    .set({
      ...set,
      metricsUpdatedAt: sql`CURRENT_TIMESTAMP` as unknown as string,
      updatedAt: sql`CURRENT_TIMESTAMP` as unknown as string,
    })
    .where(eq(papers.id, id))
    .run();
}

/** Rows for `ids`, in input order; missing ids are skipped. */
export function getPapersByIds(db: Db, ids: string[]): PaperRow[] {
  const unique = [...new Set(ids)];
  const byId = new Map<string, PaperRow>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const rows = db
      .select()
      .from(papers)
      .where(inArray(papers.id, unique.slice(i, i + IN_CHUNK)))
      .all();
    for (const r of rows) byId.set(r.id, r);
  }
  return unique.map((id) => byId.get(id)).filter((r): r is PaperRow => r != null);
}
