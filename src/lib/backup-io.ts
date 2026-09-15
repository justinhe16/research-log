import { eq, inArray, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  BACKUP_VERSION,
  decodeEntry,
  decodeLlmCall,
  decodePaper,
  decodePaperCitation,
  decodePaperExtraction,
  decodePaperFulltext,
  decodeSearch,
  decodeSearchCluster,
  decodeSearchDocument,
  decodeSearchEdge,
  decodeSearchPaper,
  decodeSearchStage,
  decodeTopic,
  encodeEntry,
  encodePaper,
  encodeSearchCluster,
  encodeTopic,
  type ParsedExportFile,
} from "@/lib/backup-format";
import type { Db } from "@/lib/db/create";
import * as S from "@/lib/db/schema";
import { remapDocumentPaperIds } from "@/lib/landscape/documents/remap";
import { DOCUMENT_SCHEMAS } from "@/lib/landscape/llm/synthesize/schemas";
import { upsertPaper } from "@/lib/landscape/papers/repo";
import { refreshTopicDenormalized } from "@/lib/landscape/queries/topic-repo";
import { uniqueSlug } from "@/lib/landscape/slug";
import type { PaperInput } from "@/lib/landscape/types";

/*
 * Backup I/O shared by /api/export, /api/import and the tests. Pure DB logic:
 * takes a `Db` so tests can run against an in-memory database.
 */

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const PAGE = 500;

/** Stream a table in rowid order, a page at a time, so a large export never
 *  holds a whole table (full text especially) in memory at once. */
function* iterateTable<T>(db: Db, table: SQLiteTable): Generator<T> {
  let last = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const batch = db
      .select({ row: table as never, rid: sql<number>`rowid` })
      .from(table)
      .where(sql`rowid > ${last}`)
      .orderBy(sql`rowid`)
      .limit(PAGE)
      .all() as unknown as { row: T; rid: number }[];
    for (const b of batch) yield b.row;
    if (batch.length < PAGE) return;
    last = batch[batch.length - 1].rid;
  }
}

function* jsonArray<T>(rows: Iterable<T>, encode: (row: T) => unknown = (r) => r): Generator<string> {
  let first = true;
  yield "[";
  for (const row of rows) {
    yield `${first ? "\n    " : ",\n    "}${JSON.stringify(encode(row))}`;
    first = false;
  }
  yield first ? "]" : "\n  ]";
}

export type ExportOptions = {
  /** Include `paper_fulltext` (the bulk of a large export). Default true. */
  fulltext?: boolean;
  exportedAt?: string;
};

/**
 * NOT a point-in-time snapshot: tables are read page by page as the stream is
 * consumed, outside any transaction, so writes that land mid-export (e.g. a
 * running search) can leave the file internally inconsistent (a search_papers
 * row whose paper was read before it existed). Import tolerates that by
 * skipping unresolvable child rows; for an exact copy use `npm run db:backup`.
 *
 * The export file as a sequence of JSON text chunks. The concatenation is a
 * `version: 2` backup: `{version, exportedAt, count, entries, landscape}`, one
 * row per line. `api_cache` is never exported.
 */
export function* exportChunks(db: Db, opts: ExportOptions = {}): Generator<string> {
  const count = db.select({ n: sql<number>`count(*)` }).from(S.entries).get()?.n ?? 0;
  const exportedAt = opts.exportedAt ?? new Date().toISOString();

  yield `{\n  "version": ${BACKUP_VERSION},\n  "exportedAt": ${JSON.stringify(exportedAt)},\n  "count": ${count},\n  "entries": `;
  yield* jsonArray(iterateTable<S.EntryRow>(db, S.entries), encodeEntry);

  const tables: [string, SQLiteTable, ((row: never) => unknown)?][] = [
    ["topics", S.topics, encodeTopic],
    ["searches", S.searches],
    ["searchStages", S.searchStages],
    ["papers", S.papers, encodePaper],
    ["paperFulltext", S.paperFulltext],
    ["paperCitations", S.paperCitations],
    ["paperExtractions", S.paperExtractions],
    ["searchPapers", S.searchPapers],
    ["searchClusters", S.searchClusters, encodeSearchCluster],
    ["searchEdges", S.searchEdges],
    ["searchDocuments", S.searchDocuments],
    ["llmCalls", S.llmCalls],
  ];

  yield `,\n  "landscape": {`;
  let first = true;
  for (const [key, table, encode] of tables) {
    if (key === "paperFulltext" && opts.fulltext === false) continue;
    yield `${first ? "" : ","}\n  ${JSON.stringify(key)}: `;
    yield* jsonArray(iterateTable<never>(db, table), encode);
    first = false;
  }
  yield "\n  }\n}\n";
}

/** The whole export as one string (tests, scripts). */
export function exportBackupString(db: Db, opts: ExportOptions = {}): string {
  let out = "";
  for (const chunk of exportChunks(db, opts)) out += chunk;
  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type LandscapeImportResult = {
  topics: number;
  papers: number;
  /** Incoming papers resolved onto an existing paper (different id, same work). */
  papersMerged: number;
  fulltext: number;
  citations: number;
  extractions: number;
  searches: number;
  searchStages: number;
  searchPapers: number;
  searchClusters: number;
  searchEdges: number;
  searchDocuments: number;
  llmCalls: number;
  /** Queued/running searches stored as `interrupted`. */
  interrupted: number;
  /** Topics whose slug was taken by another topic and got a `-2`-style suffix. */
  renamedSlugs: number;
  skipped: {
    /** Topic id already present (merge mode). */
    topics: number;
    /** Paper id already present (merge mode); its row is left untouched. */
    papers: number;
    /** Search id already present (merge mode). */
    searches: number;
    /** Search whose topic is neither in the file nor the database. */
    searchesMissingTopic: number;
    /** Child rows dropped: already present, or their parent search/paper was skipped. */
    rows: number;
  };
};

export type ImportResult = {
  imported: number;
  skipped: number;
  replaced: boolean;
  missingEmbeddings: number;
  landscape?: LandscapeImportResult;
};

const CHUNK = 100; // rows per multi-row INSERT; widest table is ~22 columns
const IN_CHUNK = 500;

function existingIds(db: Db, column: SQLiteColumn, ids: string[]): Set<string> {
  const found = new Set<string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const rows = db
      .select({ id: column })
      .from(column.table)
      .where(inArray(column, unique.slice(i, i + IN_CHUNK)))
      .all() as { id: string }[];
    for (const r of rows) found.add(r.id);
  }
  return found;
}

/** Insert rows in chunks with ON CONFLICT DO NOTHING; returns rows actually written. */
function insertIgnore<T extends SQLiteTable>(db: Db, table: T, rows: T["$inferInsert"][]): number {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = db
      .insert(table)
      .values(rows.slice(i, i + CHUNK) as never)
      .onConflictDoNothing()
      .run();
    written += res.changes;
  }
  return written;
}

function firstById<T>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = key(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Restore a parsed backup in ONE transaction (all or nothing).
 *
 * Merge (default): nothing already in the database is overwritten.
 *  - entries / topics / searches / llm_calls: existing ids are skipped. A topic
 *    whose slug belongs to a different topic is imported under a suffixed slug.
 *  - papers go through `upsertPaper`, so an incoming paper that is the same work
 *    as an existing one (arXiv/DOI/S2/OpenAlex id, or title fallback) resolves
 *    to the existing row; every child row is rewritten through that id remap.
 *    A paper with no match keeps its original id and columns.
 *  - searches whose topic is missing are skipped (with their child rows).
 *  - composite-key rows use ON CONFLICT DO NOTHING.
 *
 * Replace (`replace: true`): entries are wiped; if the file has a `landscape`
 * section, every Landscape table except `api_cache` is wiped too (a v1 file
 * leaves Landscape data alone). Then the same insert path runs.
 *
 * In both modes queued/running searches become `interrupted` (no job exists for
 * them in this process) and their running stages go back to `pending`.
 */
export function importBackup(db: Db, file: ParsedExportFile, opts: { replace?: boolean } = {}): ImportResult {
  const replace = opts.replace === true;
  const now = new Date().toISOString();

  // Decode fully before touching the DB: a bad blob halfway through the file
  // must not leave a half-written database behind.
  let duplicates = 0;
  const entryRows = firstById(file.entries, (e) => e.id).map(decodeEntry);
  duplicates = file.entries.length - entryRows.length;

  return db.$client.transaction((): ImportResult => {
    if (replace) {
      if (file.landscape) wipeLandscape(db);
      db.delete(S.entries).run();
    }

    const existing = replace ? new Set<string>() : existingIds(db, S.entries.id, entryRows.map((r) => r.id));
    const toInsert = entryRows.filter((r) => !existing.has(r.id));
    for (let i = 0; i < toInsert.length; i += 200) {
      db.insert(S.entries).values(toInsert.slice(i, i + 200)).run();
    }

    const result: ImportResult = {
      imported: toInsert.length,
      skipped: duplicates + (entryRows.length - toInsert.length),
      replaced: replace,
      missingEmbeddings: toInsert.filter((r) => r.embedding == null).length,
    };
    if (file.landscape) result.landscape = importLandscape(db, file.landscape, now);
    return result;
  })();
}

function wipeLandscape(db: Db): void {
  // Reverse FK order. api_cache is deliberately kept.
  db.delete(S.llmCalls).run();
  db.delete(S.searchDocuments).run();
  db.delete(S.searchEdges).run();
  db.delete(S.searchClusters).run();
  db.delete(S.searchPapers).run();
  db.delete(S.searchStages).run();
  db.delete(S.searches).run();
  db.delete(S.paperExtractions).run();
  db.delete(S.paperCitations).run();
  db.delete(S.paperFulltext).run();
  db.delete(S.papers).run();
  db.delete(S.topics).run();
}

function maxPaperRowid(db: Db): number {
  return db.select({ m: sql<number | null>`max(rowid)` }).from(S.papers).get()?.m ?? 0;
}

function toPaperInput(p: S.NewPaperRow): PaperInput {
  return {
    title: p.title,
    arxivId: p.arxivId,
    doi: p.doi,
    s2Id: p.s2Id,
    openalexId: p.openalexId,
    abstract: p.abstract,
    authors: p.authors,
    year: p.year,
    publishedAt: p.publishedAt,
    venue: p.venue,
    arxivUrl: p.arxivUrl,
    pdfUrl: p.pdfUrl,
    citationCount: p.citationCount,
    influentialCitationCount: p.influentialCitationCount,
    maxAuthorHIndex: p.maxAuthorHIndex,
  };
}

function importLandscape(
  db: Db,
  land: NonNullable<ParsedExportFile["landscape"]>,
  now: string,
): LandscapeImportResult {
  const r: LandscapeImportResult = {
    topics: 0,
    papers: 0,
    papersMerged: 0,
    fulltext: 0,
    citations: 0,
    extractions: 0,
    searches: 0,
    searchStages: 0,
    searchPapers: 0,
    searchClusters: 0,
    searchEdges: 0,
    searchDocuments: 0,
    llmCalls: 0,
    interrupted: 0,
    renamedSlugs: 0,
    skipped: { topics: 0, papers: 0, searches: 0, searchesMissingTopic: 0, rows: 0 },
  };

  // --- topics ---------------------------------------------------------------
  const topicRows = firstById(land.topics, (t) => t.id).map((t) => decodeTopic(t, now));
  const presentTopics = existingIds(db, S.topics.id, topicRows.map((t) => t.id));
  const importedTopics: S.NewTopicRow[] = [];
  for (const t of topicRows) {
    if (presentTopics.has(t.id)) {
      r.skipped.topics++;
      continue;
    }
    const clash = db.select({ id: S.topics.id }).from(S.topics).where(eq(S.topics.slug, t.slug)).get();
    if (clash) {
      t.slug = uniqueSlug(db, t.slug);
      r.renamedSlugs++;
    }
    db.insert(S.topics).values(t).run();
    importedTopics.push(t);
    r.topics++;
  }

  // --- papers (dedupe resolver + id remap) ------------------------------------
  const paperRemap = new Map<string, string>();
  const paperRows = firstById(land.papers, (p) => p.id).map((p) => decodePaper(p, now));
  const presentPapers = existingIds(db, S.papers.id, paperRows.map((p) => p.id));
  const resolve = (p: S.NewPaperRow) => {
    if (!p.title.trim()) {
      // upsertPaper needs a title; keep an untitled row verbatim.
      db.insert(S.papers).values(p).onConflictDoNothing().run();
      return p.id;
    }
    const before = maxPaperRowid(db);
    const got = upsertPaper(db, toPaperInput(p));
    const rid = db.select({ rid: sql<number>`rowid` }).from(S.papers).where(eq(S.papers.id, got)).get()?.rid ?? 0;
    if (rid > before) {
      // Freshly inserted: restore the original id and every column verbatim.
      // External ids stay as upsertPaper normalized them (already normalized in
      // any file this app exported), so the unique indexes can't trip.
      const { id, arxivId: _a, doi: _d, s2Id: _s, openalexId: _o, ...rest } = p;
      void _a;
      void _d;
      void _s;
      void _o;
      db.update(S.papers).set({ ...rest, id }).where(eq(S.papers.id, got)).run();
      r.papers++;
      return id;
    }
    // Matched an existing paper: it wins; only fill a missing vector.
    if (p.embedding) {
      db.update(S.papers)
        .set({ embedding: p.embedding })
        .where(sql`${S.papers.id} = ${got} and ${S.papers.embedding} is null`)
        .run();
    }
    r.papersMerged++;
    return got;
  };
  for (const p of paperRows) {
    if (presentPapers.has(p.id)) {
      paperRemap.set(p.id, p.id);
      r.skipped.papers++;
      continue;
    }
    paperRemap.set(p.id, resolve(p));
  }
  // Second pass: a later upsert can match several existing rows and merge them,
  // deleting a row an earlier incoming paper was already mapped to. Re-running
  // upsertPaper for those lands on the keeper (it now carries the merged ids).
  const live = existingIds(db, S.papers.id, [...paperRemap.values()]);
  for (const p of paperRows) {
    const target = paperRemap.get(p.id)!;
    if (live.has(target)) continue;
    const keeper = upsertPaper(db, toPaperInput(p));
    if (!existingIds(db, S.papers.id, [keeper]).has(keeper)) {
      throw new Error(`paper ${p.id} could not be resolved after a merge`);
    }
    paperRemap.set(p.id, keeper);
  }

  // Papers referenced by child rows but not in the file must already exist.
  const referenced = new Set<string>();
  const addRef = (pid: string) => {
    if (!paperRemap.has(pid)) referenced.add(pid);
  };
  for (const f of land.paperFulltext ?? []) addRef(f.paperId);
  for (const c of land.paperCitations) {
    addRef(c.citingId);
    addRef(c.citedId);
  }
  for (const e of land.paperExtractions) addRef(e.paperId);
  for (const sp of land.searchPapers) addRef(sp.paperId);
  for (const e of land.searchEdges) {
    addRef(e.sourceId);
    addRef(e.targetId);
  }
  for (const pid of existingIds(db, S.papers.id, [...referenced])) paperRemap.set(pid, pid);
  const mapPaper = (pid: string) => paperRemap.get(pid);

  const skipRows = (n: number) => {
    r.skipped.rows += n;
  };

  // --- fulltext / citations / extractions -------------------------------------
  const fulltext = (land.paperFulltext ?? []).flatMap((f) => {
    const paperId = mapPaper(f.paperId);
    return paperId ? [{ ...decodePaperFulltext(f, now), paperId }] : [];
  });
  r.fulltext = insertIgnore(db, S.paperFulltext, fulltext);
  skipRows((land.paperFulltext?.length ?? 0) - r.fulltext);

  const citations = land.paperCitations.flatMap((c) => {
    const citingId = mapPaper(c.citingId);
    const citedId = mapPaper(c.citedId);
    if (!citingId || !citedId) return [];
    // A remap can collapse both ends onto one paper; mergePapers drops those too.
    if (citingId === citedId && c.citingId !== c.citedId) return [];
    return [{ ...decodePaperCitation(c, now), citingId, citedId }];
  });
  r.citations = insertIgnore(db, S.paperCitations, citations);
  skipRows(land.paperCitations.length - r.citations);

  const extractionRemap = new Map<string, string>();
  const presentExtractions = existingIds(db, S.paperExtractions.id, land.paperExtractions.map((e) => e.id));
  for (const e of firstById(land.paperExtractions, (x) => x.id)) {
    if (presentExtractions.has(e.id)) {
      extractionRemap.set(e.id, e.id);
      skipRows(1);
      continue;
    }
    const paperId = mapPaper(e.paperId);
    if (!paperId) {
      skipRows(1);
      continue;
    }
    // The cache key is unique: an equivalent extraction may already exist.
    const same = db
      .select({ id: S.paperExtractions.id })
      .from(S.paperExtractions)
      .where(
        sql`${S.paperExtractions.paperId} = ${paperId} and ${S.paperExtractions.version} = ${e.version}
          and ${S.paperExtractions.source} = ${e.source} and ${S.paperExtractions.sourceHash} = ${e.sourceHash}`,
      )
      .get();
    if (same) {
      extractionRemap.set(e.id, same.id);
      skipRows(1);
      continue;
    }
    db.insert(S.paperExtractions).values({ ...decodePaperExtraction(e, now), paperId }).run();
    extractionRemap.set(e.id, e.id);
    r.extractions++;
  }

  // --- searches ---------------------------------------------------------------
  const searchRows = firstById(land.searches, (s) => s.id).map((s) => decodeSearch(s, now));
  const presentSearches = existingIds(db, S.searches.id, searchRows.map((s) => s.id));
  const liveTopics = existingIds(db, S.topics.id, searchRows.map((s) => s.topicId));
  const inserted = new Set<string>();
  const interrupted = new Set<string>();
  const topicsGainingSearches = new Set<string>();
  for (const s of searchRows) {
    if (presentSearches.has(s.id)) {
      r.skipped.searches++;
      continue;
    }
    if (!liveTopics.has(s.topicId)) {
      r.skipped.searchesMissingTopic++;
      continue;
    }
    const active = s.status === "queued" || s.status === "running";
    if (active) interrupted.add(s.id);
    // base_search_id is a self-FK; link it after every search is in.
    db.insert(S.searches)
      .values({
        ...s,
        baseSearchId: null,
        ...(active ? { status: "interrupted" as const, finishedAt: s.finishedAt ?? now } : {}),
      })
      .run();
    inserted.add(s.id);
    topicsGainingSearches.add(s.topicId);
    r.searches++;
  }
  r.interrupted = interrupted.size;
  const bases = searchRows.filter((s) => inserted.has(s.id) && s.baseSearchId);
  const liveBases = existingIds(db, S.searches.id, bases.map((s) => s.baseSearchId!));
  for (const s of bases) {
    if (liveBases.has(s.baseSearchId!)) {
      db.update(S.searches).set({ baseSearchId: s.baseSearchId }).where(eq(S.searches.id, s.id)).run();
    }
  }

  // --- search-scoped children (only for searches written by this import) ------
  const ofInserted = <T extends { searchId: string }>(rows: T[]) => {
    const kept = rows.filter((x) => inserted.has(x.searchId));
    skipRows(rows.length - kept.length);
    return kept;
  };

  const stages = ofInserted(land.searchStages).map((st) => {
    const row = decodeSearchStage(st);
    return interrupted.has(st.searchId) && row.status === "running"
      ? { ...row, status: "pending" as const, finishedAt: null }
      : row;
  });
  r.searchStages = insertIgnore(db, S.searchStages, stages);
  skipRows(stages.length - r.searchStages);

  const liveExtractions = existingIds(
    db,
    S.paperExtractions.id,
    land.searchPapers.flatMap((sp) => (sp.extractionId && !extractionRemap.has(sp.extractionId) ? [sp.extractionId] : [])),
  );
  const searchPapers = ofInserted(land.searchPapers).flatMap((sp) => {
    const paperId = mapPaper(sp.paperId);
    if (!paperId) return [];
    const ext = sp.extractionId;
    const extractionId = ext ? (extractionRemap.get(ext) ?? (liveExtractions.has(ext) ? ext : null)) : null;
    return [{ ...decodeSearchPaper(sp), paperId, extractionId }];
  });
  r.searchPapers = insertIgnore(db, S.searchPapers, searchPapers);
  skipRows(land.searchPapers.filter((x) => inserted.has(x.searchId)).length - r.searchPapers);

  const clusters = ofInserted(land.searchClusters).map(decodeSearchCluster);
  r.searchClusters = insertIgnore(db, S.searchClusters, clusters);
  skipRows(clusters.length - r.searchClusters);

  const edgesIn = ofInserted(land.searchEdges);
  const edges = edgesIn.flatMap((e) => {
    const sourceId = mapPaper(e.sourceId);
    const targetId = mapPaper(e.targetId);
    if (!sourceId || !targetId) return [];
    if (sourceId === targetId && e.sourceId !== e.targetId) return [];
    return [{ ...decodeSearchEdge(e), sourceId, targetId }];
  });
  r.searchEdges = insertIgnore(db, S.searchEdges, edges);
  skipRows(edgesIn.length - r.searchEdges);

  // Synthesis documents embed paper ids in their JSON: remap them like any other
  // child row, then re-validate so a bad file can't store a malformed document.
  const docs = ofInserted(land.searchDocuments).map((d) => {
    const row = decodeSearchDocument(d, now);
    if (row.data == null) return row;
    const data = remapDocumentPaperIds(row.kind, row.data, (pid) => mapPaper(pid) ?? null);
    const checked = DOCUMENT_SCHEMAS[row.kind].safeParse(data);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new Error(
        `search document ${row.searchId}/${row.kind} is malformed at \`${issue?.path.join(".")}\`: ${issue?.message}`,
      );
    }
    return { ...row, data: checked.data };
  });
  r.searchDocuments = insertIgnore(db, S.searchDocuments, docs);
  skipRows(docs.length - r.searchDocuments);

  // --- llm_calls (history outlives searches: a missing search becomes null) ----
  const callRows = firstById(land.llmCalls, (c) => c.id).map((c) => decodeLlmCall(c, now));
  const liveCallSearches = existingIds(db, S.searches.id, callRows.flatMap((c) => (c.searchId ? [c.searchId] : [])));
  const calls = callRows.map((c) => ({
    ...c,
    searchId: c.searchId && liveCallSearches.has(c.searchId) ? c.searchId : null,
  }));
  r.llmCalls = insertIgnore(db, S.llmCalls, calls);
  skipRows(land.llmCalls.length - r.llmCalls);

  // --- topic card denormalization ----------------------------------------------
  // Recompute when an imported topic points at a search that didn't make it, or
  // an existing topic gained searches from the file.
  const importedTopicIds = new Set(importedTopics.map((t) => t.id));
  const lastIds = importedTopics.flatMap((t) => (t.lastSearchId ? [t.lastSearchId] : []));
  const liveLast = existingIds(db, S.searches.id, lastIds);
  const refresh = new Set<string>();
  for (const t of importedTopics) {
    if (t.lastSearchId && !liveLast.has(t.lastSearchId)) refresh.add(t.id);
  }
  for (const tid of topicsGainingSearches) {
    if (!importedTopicIds.has(tid)) refresh.add(tid);
  }
  for (const tid of refresh) refreshTopicDenormalized(db, tid);

  return r;
}
