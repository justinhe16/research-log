/*
 * Landscape contracts. Everything that crosses a module or network boundary is
 * typed here: DB JSON column shapes, pipeline interfaces, and the wire DTOs the
 * API returns and the UI consumes. Pure types only -- no runtime imports -- so
 * both server and client code (and the drizzle schema) can depend on it freely.
 *
 * Conventions:
 *  - Timestamps are ISO 8601 strings; dates without time are "YYYY-MM-DD".
 *  - Scores documented as "0..1" are normalized; others are raw.
 *  - `paperId` always means our internal `papers.id`, never an external id.
 */

import type {
  ClustersDocument,
  DiffDocument,
  GapsDocument,
  NarrativeDocument,
  ReadingPathDocument,
  TensionsDocument,
} from "./llm/synthesize/schemas";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];

/** initial: first search of a topic. refresh: incremental from the latest done
 *  search. full: a from-scratch re-run (e.g. "Re-run deeper"). */
export const SEARCH_KINDS = ["initial", "refresh", "full"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** `interrupted` = the process died mid-run (found by the stale-heartbeat sweep).
 *  error / cancelled / interrupted are all resumable. */
export const SEARCH_STATUSES = ["queued", "running", "done", "error", "cancelled", "interrupted"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

/** Statuses that hold the one-active-search-per-topic slot. */
export const ACTIVE_SEARCH_STATUSES = ["queued", "running"] as const satisfies readonly SearchStatus[];
export const RESUMABLE_SEARCH_STATUSES = ["error", "cancelled", "interrupted"] as const satisfies readonly SearchStatus[];

/** Pipeline stages, in execution order. */
export const STAGES = [
  "plan",
  "expand",
  "collect",
  "embed",
  "prerank",
  "citations",
  "enrich",
  "rerank",
  "graph",
  "cluster",
  "fulltext",
  "extract",
  "diff",
  "synthesize",
  "finalize",
] as const;
export type StageName = (typeof STAGES)[number];

/** `skipped` = not applicable to this run (e.g. diff on an initial search,
 *  citations at Quick). The runner treats done and skipped identically. */
export const STAGE_STATUSES = ["pending", "running", "done", "skipped", "error"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** How a paper entered a search's candidate pool. */
export const PAPER_ORIGINS = ["query", "citation", "carryover"] as const;
export type PaperOrigin = (typeof PAPER_ORIGINS)[number];

/** cites: direct citation (source cites target). builds_on: citation that S2
 *  marks influential or methodology-intent. similar: embedding neighbours. */
export const EDGE_KINDS = ["cites", "builds_on", "similar"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const DOCUMENT_KINDS = ["clusters", "tensions", "gaps", "narrative", "reading_path", "diff"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Cluster change relative to the base search (refresh only). */
export const CLUSTER_CHANGES = ["new", "gone", "grew", "shrank", "split", "merged", "stable"] as const;
export type ClusterChange = (typeof CLUSTER_CHANGES)[number];

export const PAPER_SOURCES = ["arxiv", "s2", "openalex"] as const;
export type PaperSource = (typeof PAPER_SOURCES)[number];

// ---------------------------------------------------------------------------
// Config & estimates
// ---------------------------------------------------------------------------

/** Every knob a search's behaviour depends on. Snapshotted into `searches.config`. */
export type DepthConfig = {
  depth: Depth;
  /** Number of Haiku-expanded queries (the topic name itself is always query 0 on top). */
  expandedQueries: number;
  arxivPerQuery: number;
  s2PerQuery: number;
  /** Max candidates kept in `search_papers` after collect + citations. */
  poolCap: number;
  /** Publication window in years back from today; null = no limit. */
  windowYears: number | null;
  citations: {
    /** 0 = citation expansion off. */
    hops: 0 | 1 | 2;
    /** Seeds for hop 1, taken from the top of prerank. */
    seeds: number;
    /** Seeds for hop 2, taken from the top of hop-1 admissions. 0 when hops < 2. */
    hop2Seeds: number;
    /** Max papers admitted via citations across all hops. */
    maxAdmitted: number;
    /** A non-influential paper must link to at least this many seeds to be admitted. */
    minSeedLinks: number;
  };
  /** Candidates scored by the cross-encoder. */
  rerankTopN: number;
  /** Papers selected into the landscape (and extracted). Includes the reserve. */
  selectCount: number;
  /** Of `selectCount`, slots reserved for highly-cited older papers ranked lower on relevance. */
  foundationalReserve: number;
  /** Of `selectCount`, slots reserved for the most relevant recent papers (published within
   *  FRONTIER_MONTHS). Optional so older config snapshots stay valid; missing = 0. */
  frontierReserve?: number;
  /** Canonical-paper recall: collect also searches the topic sorted by citation count and admits
   *  up to `maxAdmitted` works (of `perSource` fetched per source) whose cosine to the topic clears
   *  CANONICAL_MIN_COSINE. Missing (older snapshots) = off. */
  canonical?: { perSource: number; maxAdmitted: number };
  /** Selected papers additionally extracted from full text. */
  fulltextCount: number;
  kRange: { min: number; max: number };
  /** 3 = Quick merged mode (S2+S3 in one call, S5 folded into S4). */
  synthesisCalls: 3 | 5;
};

export type Estimate = {
  depth: Depth;
  /** Point estimate plus a range; UI shows "~$0.30". */
  costUsd: { expected: number; low: number; high: number };
  minutes: { expected: number; low: number; high: number };
  llmCalls: { haiku: number; sonnet: number };
  /** Expected token totals across all calls (cache reads/writes counted in `input`). */
  tokens: { input: number; output: number };
  /** Human hints, e.g. "No Semantic Scholar key: collection is slower." */
  notes: string[];
};

export type EstimateOptions = {
  hasS2Key: boolean;
  /** Present for a refresh: days since the base search started. */
  refresh?: { daysSince: number };
};

// ---------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------

export type PaperAuthor = {
  name: string;
  s2Id?: string | null;
  openalexId?: string | null;
  hIndex?: number | null;
};

/** One expanded query. `text` is the plain query used for S2/OpenAlex and BM25/cosine;
 *  `arxiv` is the arXiv API `search_query` string (e.g. `abs:"sparse autoencoder" AND cat:cs.LG`). */
export type ExpandedQuery = {
  text: string;
  arxiv: string;
  /** arXiv categories this query should be restricted to, e.g. ["cs.LG", "cs.CL"]. */
  categories: string[];
};

/** Live counters on `searches.counters`. All optional: stages fill them in as they run. */
export type SearchCounters = {
  queries?: number;
  /** Raw hits returned by sources, before dedupe. */
  fetched?: number;
  /** Unique papers in the candidate pool. */
  candidates?: number;
  embedded?: number;
  citationAdmitted?: number;
  enriched?: number;
  reranked?: number;
  selected?: number;
  clusters?: number;
  fulltextFetched?: number;
  /** Extractions available (cache hits + new). */
  extracted?: number;
  extractionCacheHits?: number;
  extractionFailed?: number;
  documentsDone?: number;
  documentsFailed?: number;
  llmCalls?: number;
  /** Refresh only. */
  newPapers?: number;
  /** Canonical (citation-sorted) recall admissions. */
  canonicalAdmitted?: number;
  /** Expanded queries dropped for drifting off-topic. */
  queriesDropped?: number;
  /** Refresh with an empty diff: number of documents copied from the base search instead of
   *  re-synthesized (0 or absent = synthesized normally). A number so every counter stays numeric. */
  synthesisReused?: number;
};

// ---------------------------------------------------------------------------
// Pipeline contracts
// ---------------------------------------------------------------------------

/** Input to `upsertPaper`. Every field but `title` is optional; ids are normalized
 *  by the caller with `ids.ts` helpers (upsert re-normalizes defensively). */
export type PaperInput = {
  title: string;
  arxivId?: string | null;
  doi?: string | null;
  s2Id?: string | null;
  openalexId?: string | null;
  abstract?: string | null;
  authors?: PaperAuthor[];
  year?: number | null;
  publishedAt?: string | null;
  venue?: string | null;
  arxivUrl?: string | null;
  pdfUrl?: string | null;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  maxAuthorHIndex?: number | null;
  /** Which source produced this record (for logging/provenance only). */
  source?: PaperSource;
};

export const LLM_PURPOSES = [
  "expand",
  "extract_abstracts",
  "extract_fulltext",
  "synth_clusters",
  "synth_tensions",
  "synth_gaps",
  "synth_tensions_gaps", // Quick merged S2+S3
  "synth_narrative",
  "synth_narrative_path", // Quick merged S4+S5
  "synth_reading_path",
] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LlmCallRecord = LlmUsage & {
  purpose: LlmPurpose;
  model: string;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  error?: string | null;
};

/** Sink for per-call usage. The pipeline's implementation writes `llm_calls` rows
 *  and bumps the search's token/cost roll-up; tests can pass an in-memory array. */
export interface LlmRecorder {
  record(call: LlmCallRecord): void | Promise<void>;
}

/** Handed to every stage function. */
export interface StageContext {
  searchId: string;
  topicId: string;
  kind: SearchKind;
  config: DepthConfig;
  /** Base search for refresh/full; null on initial. */
  baseSearchId: string | null;
  /** Checkpoint persisted by a previous (interrupted) attempt at this stage, if any. */
  checkpoint: Record<string, unknown> | null;
  /** Persist resume state for this stage (merged shallowly, written immediately). */
  saveCheckpoint(patch: Record<string, unknown>): void;
  /** Merge counters into `searches.counters` and bump the heartbeat. */
  updateCounters(patch: Partial<SearchCounters>): void;
  /** Within-stage progress 0..1; the runner maps it into overall progress. */
  setStageProgress(fraction: number): void;
  /** Throws `SearchCancelledError` if cancel was requested. Call between units of work. */
  throwIfCancelled(): void;
  /** Cancels in-flight fetches / LLM calls when the search is cancelled. */
  signal: AbortSignal;
  recorder: LlmRecorder;
  hasS2Key: boolean;
  log(message: string): void;
}

// ---------------------------------------------------------------------------
// Wire DTOs
// ---------------------------------------------------------------------------

/** Lightweight search reference for cards and history menus. */
export type SearchSummary = {
  id: string;
  topicId: string;
  kind: SearchKind;
  depth: Depth;
  status: SearchStatus;
  stage: StageName | null;
  progress: number;
  paperCount: number;
  costUsd: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TopicCard = {
  id: string;
  slug: string;
  name: string;
  description: string;
  defaultDepth: Depth;
  summary: string | null;
  paperCount: number;
  lastSearchAt: string | null;
  /** Latest done search, if any. */
  lastSearch: SearchSummary | null;
  /** Queued/running search, for the live progress ring. */
  activeSearch: SearchSummary | null;
  createdAt: string;
  updatedAt: string;
};

/** A topic detail page header = card + full search history (newest first). */
export type TopicDetail = TopicCard & { searches: SearchSummary[] };

export type SimilarTopic = {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** Cosine similarity 0..1 against the proposed name + description. */
  similarity: number;
  lastSearchAt: string | null;
  paperCount: number;
};

export type StageState = {
  stage: StageName;
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

/** `GET /searches/[id]`, polled while a search is active. */
export type SearchProgress = SearchSummary & {
  error: string | null;
  cancelRequested: boolean;
  /** One entry per STAGES element, in order. */
  stages: StageState[];
  counters: SearchCounters;
  tokens: LlmUsage;
  /** Documents that failed synthesis and can be retried. */
  failedDocuments: DocumentKind[];
  heartbeatAt: string | null;
};

export type PaperLite = {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  publishedAt: string | null;
  venue: string | null;
  arxivId: string | null;
  doi: string | null;
  arxivUrl: string | null;
  pdfUrl: string | null;
  /** Short ref used in LLM documents ("P1"...), stable within one search. Not shown to users. */
  ref: string;
  /** 1-based final rank within the search. */
  rank: number;
  /** Cross-encoder (or cosine fallback) score, normalized 0..1 within the search. */
  relevance: number;
  /** 0..1, see INFLUENCE_WEIGHTS. */
  influence: number;
  citationCount: number | null;
  influentialCitationCount: number | null;
  /** Citations per year since publication. */
  velocity: number | null;
  /** Normalized 0..1 within the search. */
  pagerank: number | null;
  maxAuthorHIndex: number | null;
  clusterIdx: number | null;
  origin: PaperOrigin;
  foundational: boolean;
  gameChanger: boolean;
  /** Matching entry in the Logs tab, if this paper was already logged. */
  loggedEntryId: string | null;
  hasExtraction: boolean;
  /** 2-3 line blurb for cards/tooltips: the extraction's contribution, else abstract head. */
  tldr: string | null;
};

export type PaperExtractionDTO = {
  source: "abstract" | "fulltext";
  model: string;
  problem: string;
  method: string;
  results: string;
  contribution: string;
  limitations: string | null;
  datasets: string[];
  benchmarks: string[];
  createdAt: string;
};

export type PaperRelation = {
  paper: Pick<PaperLite, "id" | "title" | "year" | "clusterIdx" | "rank">;
  kind: EdgeKind;
  /** out: this paper -> other (e.g. cites). in: other -> this paper. */
  direction: "in" | "out";
  weight: number;
};

/** `GET /papers/[paperId]?searchId=`. Search-scoped fields are null without searchId. */
export type PaperDetail = Omit<PaperLite, "ref" | "rank" | "relevance" | "influence" | "clusterIdx" | "origin" | "foundational" | "gameChanger"> & {
  abstract: string | null;
  authorsDetailed: PaperAuthor[];
  extraction: PaperExtractionDTO | null;
  search: {
    searchId: string;
    ref: string;
    rank: number | null;
    selected: boolean;
    relevance: number;
    influence: number;
    clusterIdx: number | null;
    clusterLabel: string | null;
    origin: PaperOrigin;
    foundational: boolean;
    gameChanger: boolean;
    /** Edges touching this paper within the search's selection. */
    relations: PaperRelation[];
  } | null;
};

export type ClusterDTO = {
  idx: number;
  /** Synthesis name when available, else the heuristic key-term label. */
  label: string;
  summary: string | null;
  keyTerms: string[];
  size: number;
  yearMin: number | null;
  yearMax: number | null;
  /** Selected paper ids in this cluster, ordered by rank. */
  paperIds: string[];
  /** Theme color slot 1..10 (maps to --chart-N). */
  color: number;
  baseClusterIdx: number | null;
  change: ClusterChange | null;
};

export type EdgeDTO = {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
};

export type SearchDiff = DiffDocument;

export type LandscapeDocuments = {
  clusters: ClustersDocument | null;
  tensions: TensionsDocument | null;
  gaps: GapsDocument | null;
  narrative: NarrativeDocument | null;
  readingPath: ReadingPathDocument | null;
  /** Refresh only. */
  diff: SearchDiff | null;
};

/** `GET /searches/[id]/snapshot`: everything the topic page renders. Documents
 *  reference papers by `paperId`; clients look them up in `papers`. */
export type LandscapeSnapshot = {
  topic: Pick<TopicCard, "id" | "slug" | "name" | "description" | "summary">;
  search: SearchSummary & { queries: ExpandedQuery[]; since: string | null; baseSearchId: string | null };
  /** Selected papers only, ordered by rank. */
  papers: PaperLite[];
  clusters: ClusterDTO[];
  /** Edges among selected papers only. */
  edges: EdgeDTO[];
  documents: LandscapeDocuments;
  /** Kinds whose synthesis failed (render an error state + "Retry synthesis"). */
  failedDocuments: DocumentKind[];
};

// ---------------------------------------------------------------------------
// API request bodies
// ---------------------------------------------------------------------------

export type CreateTopicInput = {
  name: string;
  description?: string;
  depth: Depth;
  /** Create even if similar topics exist (otherwise 409 with `similar`). */
  force?: boolean;
};

export type CreateTopicResponse = { topic: TopicCard; search: SearchProgress };
/** 409 body from `POST /topics`. */
export type SimilarTopicsConflict = { error: string; similar: SimilarTopic[] };

export type UpdateTopicInput = Partial<Pick<TopicCard, "name" | "description" | "defaultDepth">>;

export type SimilarTopicsInput = { name: string; description?: string };

export type StartSearchInput = { mode: "refresh" | "full"; depth?: Depth };

export type RetryDocumentsInput = { kinds?: DocumentKind[] };
