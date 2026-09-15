import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  ClusterChange,
  DepthConfig,
  DocumentKind,
  EdgeKind,
  ExpandedQuery,
  PaperAuthor,
  PaperOrigin,
  SearchCounters,
  SearchKind,
  SearchStatus,
  StageName,
  StageStatus,
} from "@/lib/landscape/types";

/*
 * Landscape tables. Two families:
 *
 *  - GLOBAL facts about the world (topics, papers, full text, citations, the
 *    extraction cache, the HTTP cache). Shared across every topic and search.
 *  - SEARCH-SCOPED output (searches and everything prefixed `search_`). A search
 *    is an immutable, timestamped run; once `done` its rows are never rewritten,
 *    which is what makes history snapshots and refresh diffs possible.
 *
 * Conventions match `entries`: text UUID ids, ISO timestamp strings, JSON arrays
 * in text columns, and Float32Array embeddings as BLOBs (see `toBuffer`).
 */

const now = sql`(CURRENT_TIMESTAMP)`;

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

export const topics = sqliteTable(
  "topics",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** MiniLM vector of `name + description`, used for the "similar topic" check. */
    embedding: blob("embedding", { mode: "buffer" }),
    defaultDepth: text("default_depth").notNull().default("standard"),

    // --- denormalized for topic cards (written by the finalize stage) ---
    summary: text("summary"),
    // Deliberately not an FK: topics <-> searches would be a reference cycle, and
    // a dangling id here is harmless (cards fall back to "no search yet").
    lastSearchId: text("last_search_id"),
    lastSearchAt: text("last_search_at"),
    paperCount: integer("paper_count").notNull().default(0),

    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("topics_slug_unique").on(t.slug),
    index("topics_last_search_at_idx").on(t.lastSearchAt),
  ],
);

export const papers = sqliteTable(
  "papers",
  {
    id: text("id").primaryKey(),

    // --- external ids: each unique when present (SQLite allows many NULLs) ---
    /** Versionless arXiv id, e.g. "2401.01234" or "hep-th/9901001". */
    arxivId: text("arxiv_id"),
    /** Lowercased bare DOI, no resolver prefix. */
    doi: text("doi"),
    s2Id: text("s2_id"),
    /** Bare OpenAlex work id, e.g. "W2741809807". */
    openalexId: text("openalex_id"),
    /** `normalizeTitle(title)`; the fuzzy dedupe key when no external id matches. */
    normTitle: text("norm_title").notNull(),

    title: text("title").notNull(),
    abstract: text("abstract"),
    authors: text("authors", { mode: "json" }).$type<PaperAuthor[]>().notNull().default(sql`'[]'`),
    year: integer("year"),
    publishedAt: text("published_at"), // ISO date, best effort
    venue: text("venue"),
    arxivUrl: text("arxiv_url"),
    pdfUrl: text("pdf_url"),

    // --- latest known metrics (upsert keeps the max) ---
    citationCount: integer("citation_count"),
    influentialCitationCount: integer("influential_citation_count"),
    maxAuthorHIndex: integer("max_author_h_index"),
    metricsUpdatedAt: text("metrics_updated_at"),

    embedding: blob("embedding", { mode: "buffer" }), // MiniLM of title + abstract

    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("papers_arxiv_id_unique").on(t.arxivId),
    uniqueIndex("papers_doi_unique").on(t.doi),
    uniqueIndex("papers_s2_id_unique").on(t.s2Id),
    uniqueIndex("papers_openalex_id_unique").on(t.openalexId),
    index("papers_norm_title_idx").on(t.normTitle),
  ],
);

export const paperFulltext = sqliteTable("paper_fulltext", {
  paperId: text("paper_id")
    .primaryKey()
    .references(() => papers.id, { onDelete: "cascade" }),
  /** Extracted text, capped at FULLTEXT_MAX_CHARS. */
  text: text("text").notNull(),
  /** Where it came from: "arxiv" | "s2" | other host label. */
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  /** sha256 of `text`; part of the extraction cache key. */
  hash: text("hash").notNull(),
  truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
  fetchedAt: text("fetched_at").notNull().default(now),
});

export const paperCitations = sqliteTable(
  "paper_citations",
  {
    citingId: text("citing_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    citedId: text("cited_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    isInfluential: integer("is_influential", { mode: "boolean" }).notNull().default(false),
    /** S2 intents, e.g. ["methodology", "background"]. */
    intents: text("intents", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.citingId, t.citedId] }),
    index("paper_citations_cited_idx").on(t.citedId),
  ],
);

export const paperExtractions = sqliteTable(
  "paper_extractions",
  {
    id: text("id").primaryKey(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    /** EXTRACTION_VERSION at write time; bumping it invalidates the cache. */
    version: integer("version").notNull(),
    source: text("source").$type<"abstract" | "fulltext">().notNull(),
    /** sha256 of the exact input text (abstract or full text). */
    sourceHash: text("source_hash").notNull(),
    model: text("model").notNull(),

    problem: text("problem").notNull().default(""),
    method: text("method").notNull().default(""),
    results: text("results").notNull().default(""),
    contribution: text("contribution").notNull().default(""),
    limitations: text("limitations"),
    datasets: text("datasets", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    benchmarks: text("benchmarks", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),

    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("paper_extractions_cache_key").on(t.paperId, t.version, t.source, t.sourceHash),
  ],
);

export const apiCache = sqliteTable(
  "api_cache",
  {
    /** `${host}:${sha256(method + url + body)}`. */
    key: text("key").primaryKey(),
    host: text("host").notNull(),
    url: text("url").notNull(),
    status: integer("status").notNull(),
    body: text("body").notNull(),
    fetchedAt: text("fetched_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("api_cache_expires_at_idx").on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Search-scoped
// ---------------------------------------------------------------------------

export const searches = sqliteTable(
  "searches",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SearchKind>().notNull().default("initial"),
    /** The done search a refresh/full re-run was derived from. */
    baseSearchId: text("base_search_id").references((): AnySQLiteColumn => searches.id, {
      onDelete: "set null",
    }),
    depth: text("depth").notNull(),
    /** Resolved DepthConfig snapshot, so later preset edits never rewrite history. */
    config: text("config", { mode: "json" }).$type<DepthConfig>().notNull(),
    /** Written by the expand stage (or copied from the base search on refresh). */
    queries: text("queries", { mode: "json" }).$type<ExpandedQuery[]>().notNull().default(sql`'[]'`),
    /** ISO date lower bound for collection (refresh: base search's start date). */
    since: text("since"),

    status: text("status").$type<SearchStatus>().notNull().default("queued"),
    stage: text("stage").$type<StageName>(),
    /** 0..1 overall progress, for the topic-card ring. */
    progress: real("progress").notNull().default(0),
    counters: text("counters", { mode: "json" }).$type<SearchCounters>().notNull().default(sql`'{}'`),
    error: text("error"),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),

    // --- rolled-up LLM usage (sum of llm_calls) ---
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),

    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    /** Bumped by the runner; a running search with a stale heartbeat is swept to `interrupted`. */
    heartbeatAt: text("heartbeat_at"),
  },
  (t) => [
    index("searches_topic_created_idx").on(t.topicId, t.createdAt),
    index("searches_status_idx").on(t.status),
    // At most one queued/running search per topic. Enforced by the DB so two racing
    // POSTs can't both start a run.
    uniqueIndex("searches_one_active_per_topic")
      .on(t.topicId)
      .where(sql`status in ('queued', 'running')`),
  ],
);

export const searchStages = sqliteTable(
  "search_stages",
  {
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    stage: text("stage").$type<StageName>().notNull(),
    status: text("status").$type<StageStatus>().notNull().default("pending"),
    /** Stage-specific resume state (e.g. which extraction batches finished). */
    checkpoint: text("checkpoint", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.stage] })],
);

export const searchPapers = sqliteTable(
  "search_papers",
  {
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    origin: text("origin").$type<PaperOrigin>().notNull(),
    /** Best (lowest) 0-based rank this paper had in any source result list. */
    sourceRank: integer("source_rank"),
    /** Which expanded-query indexes surfaced it. */
    queryHits: text("query_hits", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),

    // --- ranking ---
    bm25: real("bm25"),
    cosine: real("cosine"),
    rrf: real("rrf"),
    rerank: real("rerank"),
    /** 1-based rank after rerank + reserve; null for unselected candidates. */
    finalRank: integer("final_rank"),
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    /** Selected via the foundational reserve rather than on relevance alone. */
    foundational: integer("foundational", { mode: "boolean" }).notNull().default(false),

    // --- metrics snapshotted at search time (what makes "rising" computable) ---
    citationCount: integer("citation_count"),
    influentialCitationCount: integer("influential_citation_count"),
    /** Citations per year since publication. */
    velocity: real("velocity"),
    pagerank: real("pagerank"),
    maxAuthorHIndex: integer("max_author_h_index"),
    /** 0..1 weighted percentile blend, see INFLUENCE_WEIGHTS. */
    influence: real("influence"),

    clusterIdx: integer("cluster_idx"),
    extractionId: text("extraction_id").references(() => paperExtractions.id, {
      onDelete: "set null",
    }),
    gameChanger: integer("game_changer", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.searchId, t.paperId] }),
    index("search_papers_paper_idx").on(t.paperId),
    index("search_papers_selected_idx").on(t.searchId, t.selected, t.finalRank),
  ],
);

export const searchClusters = sqliteTable(
  "search_clusters",
  {
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /** Heuristic label from key terms; replaced by the S1 synthesis name when present. */
    label: text("label").notNull(),
    summary: text("summary"),
    keyTerms: text("key_terms", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    centroid: blob("centroid", { mode: "buffer" }),
    size: integer("size").notNull(),
    yearMin: integer("year_min"),
    yearMax: integer("year_max"),
    /** Matched cluster idx in the base search (refresh only). */
    baseClusterIdx: integer("base_cluster_idx"),
    change: text("change").$type<ClusterChange>(),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.idx] })],
);

export const searchEdges = sqliteTable(
  "search_edges",
  {
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<EdgeKind>().notNull(),
    weight: real("weight").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.searchId, t.sourceId, t.targetId, t.kind] }),
    index("search_edges_target_idx").on(t.searchId, t.targetId),
  ],
);

export const searchDocuments = sqliteTable(
  "search_documents",
  {
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DocumentKind>().notNull(),
    status: text("status").$type<"done" | "error">().notNull().default("done"),
    /** Zod-validated document (see llm/synthesize/schemas.ts); null when status=error. */
    data: text("data", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    model: text("model"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.kind] })],
);

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    // set null, not cascade: call history outlives deleted topics so estimates
    // can keep being recalibrated from it.
    searchId: text("search_id").references(() => searches.id, { onDelete: "set null" }),
    stage: text("stage").$type<StageName>(),
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("llm_calls_search_idx").on(t.searchId),
    index("llm_calls_purpose_idx").on(t.purpose, t.model),
  ],
);

export type TopicRow = typeof topics.$inferSelect;
export type NewTopicRow = typeof topics.$inferInsert;
export type PaperRow = typeof papers.$inferSelect;
export type NewPaperRow = typeof papers.$inferInsert;
export type PaperFulltextRow = typeof paperFulltext.$inferSelect;
export type PaperCitationRow = typeof paperCitations.$inferSelect;
export type PaperExtractionRow = typeof paperExtractions.$inferSelect;
export type NewPaperExtractionRow = typeof paperExtractions.$inferInsert;
export type ApiCacheRow = typeof apiCache.$inferSelect;
export type SearchRow = typeof searches.$inferSelect;
export type NewSearchRow = typeof searches.$inferInsert;
export type SearchStageRow = typeof searchStages.$inferSelect;
export type SearchPaperRow = typeof searchPapers.$inferSelect;
export type NewSearchPaperRow = typeof searchPapers.$inferInsert;
export type SearchClusterRow = typeof searchClusters.$inferSelect;
export type SearchEdgeRow = typeof searchEdges.$inferSelect;
export type SearchDocumentRow = typeof searchDocuments.$inferSelect;
export type LlmCallRow = typeof llmCalls.$inferSelect;
export type NewLlmCallRow = typeof llmCalls.$inferInsert;
