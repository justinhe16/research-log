import { EMBEDDING_MODEL, SUMMARY_MODEL, SYNTHESIS_MODEL } from "@/lib/constants";
import type { Depth, DepthConfig, StageName } from "./types";

export { EMBEDDING_MODEL, SYNTHESIS_MODEL };

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Query expansion + batched extraction. */
export const EXPANSION_MODEL = SUMMARY_MODEL;
export const EXTRACTION_MODEL = SUMMARY_MODEL;
/** Local cross-encoder for rerank (transformers.js). Falls back to cosine if it fails to load.
 *  Spike: ~13ms/pair on M-series CPU, fp32, ~2s for 150 pairs. Output is a raw logit.
 *  The reranker may honour a LANDSCAPE_RERANK_MODEL env override server-side; this
 *  file stays env-free because the UI imports it too. */
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Bump when the extraction prompt/schema changes: invalidates the paper_extractions cache. */
export const EXTRACTION_VERSION = 1;

// ---------------------------------------------------------------------------
// Depth presets (plan §2)
// ---------------------------------------------------------------------------

export const DEPTH_PRESETS: Record<Depth, DepthConfig> = {
  quick: {
    depth: "quick",
    expandedQueries: 4,
    arxivPerQuery: 30,
    s2PerQuery: 20,
    poolCap: 120,
    windowYears: 4,
    citations: { hops: 0, seeds: 0, hop2Seeds: 0, maxAdmitted: 0, minSeedLinks: 2 },
    rerankTopN: 60,
    selectCount: 15,
    foundationalReserve: 2,
    fulltextCount: 0,
    kRange: { min: 2, max: 4 },
    synthesisCalls: 3,
  },
  standard: {
    depth: "standard",
    expandedQueries: 8,
    arxivPerQuery: 50,
    s2PerQuery: 40,
    poolCap: 350,
    windowYears: 6,
    citations: { hops: 1, seeds: 15, hop2Seeds: 0, maxAdmitted: 100, minSeedLinks: 2 },
    rerankTopN: 150,
    selectCount: 40,
    foundationalReserve: 6,
    fulltextCount: 4,
    kRange: { min: 3, max: 7 },
    synthesisCalls: 5,
  },
  deep: {
    depth: "deep",
    expandedQueries: 12,
    arxivPerQuery: 100,
    s2PerQuery: 80,
    poolCap: 900,
    windowYears: null,
    citations: { hops: 2, seeds: 30, hop2Seeds: 10, maxAdmitted: 350, minSeedLinks: 2 },
    rerankTopN: 250,
    selectCount: 100,
    foundationalReserve: 15,
    fulltextCount: 10,
    kRange: { min: 4, max: 10 },
    synthesisCalls: 5,
  },
};

export const DEPTH_LABELS: Record<Depth, string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
};

// ---------------------------------------------------------------------------
// Pipeline stages -> UI phases
// ---------------------------------------------------------------------------

export const STAGE_PHASES = [
  { id: "discover", label: "Discover", stages: ["plan", "expand", "collect", "embed"] },
  { id: "rank", label: "Rank", stages: ["prerank", "citations", "enrich", "rerank"] },
  { id: "structure", label: "Structure", stages: ["graph", "cluster"] },
  { id: "read", label: "Read", stages: ["fulltext", "extract"] },
  { id: "synthesize", label: "Synthesize", stages: ["diff", "synthesize", "finalize"] },
] as const satisfies readonly { id: string; label: string; stages: readonly StageName[] }[];
export type StagePhaseId = (typeof STAGE_PHASES)[number]["id"];

export const STAGE_LABELS: Record<StageName, string> = {
  plan: "Planning",
  expand: "Expanding queries",
  collect: "Collecting papers",
  embed: "Embedding",
  prerank: "Ranking candidates",
  citations: "Following citations",
  enrich: "Fetching metrics",
  rerank: "Reranking",
  graph: "Building citation graph",
  cluster: "Clustering",
  fulltext: "Fetching full text",
  extract: "Reading papers",
  diff: "Comparing with last search",
  synthesize: "Synthesizing landscape",
  finalize: "Finalizing",
};

/** Rough share of wall time per stage (sums to 1), used to map stage progress to
 *  the overall 0..1 ring. Recalibrate from real runs. */
export const STAGE_WEIGHTS: Record<StageName, number> = {
  plan: 0.01,
  expand: 0.03,
  collect: 0.15,
  embed: 0.04,
  prerank: 0.01,
  citations: 0.1,
  enrich: 0.07,
  rerank: 0.04,
  graph: 0.04,
  cluster: 0.02,
  fulltext: 0.06,
  extract: 0.2,
  diff: 0.01,
  synthesize: 0.21,
  finalize: 0.01,
};

// ---------------------------------------------------------------------------
// Ranking, graph, clustering
// ---------------------------------------------------------------------------

/** Reciprocal rank fusion constant. */
export const RRF_K = 60;
/** BM25 field weighting: the title counts this many times. */
export const BM25_TITLE_WEIGHT = 2;
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Influence = weighted blend of within-pool percentiles. Sums to 1. */
export const INFLUENCE_WEIGHTS = {
  citations: 0.3,
  velocity: 0.25,
  influential: 0.15,
  pagerank: 0.2,
  hIndex: 0.1,
} as const;

export const PAGERANK_DAMPING = 0.85;
export const PAGERANK_ITERATIONS = 50;
/** Max game-changer candidates flagged by the graph stage (synthesis picks up to 5). */
export const GAME_CHANGER_CANDIDATES = 8;
/** `similar` edges: per-paper top-k neighbours above this cosine. */
export const SIMILAR_EDGE_MIN_COSINE = 0.6;
export const SIMILAR_EDGE_TOP_K = 3;

/** Clusters smaller than this are merged into their nearest neighbour. */
export const MIN_CLUSTER_SIZE = 3;
export const KMEANS_SEED = 42;
export const KMEANS_MAX_ITERATIONS = 100;
export const CLUSTER_KEY_TERMS = 8;
/** Number of theme colors (--chart-1..10). */
export const CLUSTER_COLORS = 10;

/** Refresh: min citation delta to count a paper as rising. */
export const RISING_MIN_DELTA = 5;
export const RISING_MAX = 10;

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/** Cosine (MiniLM, name + description) at or above which a topic counts as similar. */
export const TOPIC_SIMILARITY_THRESHOLD = 0.8;
export const TOPIC_NAME_MAX = 120;
export const TOPIC_DESCRIPTION_MAX = 1000;

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** Abstracts per Haiku extraction call. */
export const EXTRACT_BATCH_SIZE = 5;
export const EXTRACT_CONCURRENCY = 3;
/** The extract stage fails only if more than this share of papers fail. */
export const EXTRACT_MAX_FAILURE_RATE = 0.3;
/** Characters of full text sent to a single extraction call. */
export const FULLTEXT_PROMPT_MAX_CHARS = 60_000;
/** Refs: if more than this share of refs in a document are unknown, retry the call. */
export const MAX_INVALID_REF_RATE = 0.5;
export const MAX_GAME_CHANGERS = 5;
/** Approximate dossier size per paper card (Sonnet 5 tokenizer; spike measured ~112). */
export const DOSSIER_TOKENS_PER_PAPER = 130;

// ---------------------------------------------------------------------------
// Sources & fetching
// ---------------------------------------------------------------------------

/** Minimum spacing between requests to a host, in ms. */
export const RATE_LIMITS = {
  arxiv: 3100,
  s2WithKey: 1050,
  s2WithoutKey: 3000,
  openalex: 120,
  /** PDFs from arxiv.org share the arXiv budget; other hosts get this. */
  pdf: 1000,
} as const;

export const HTTP_TIMEOUT_MS = 20_000;
export const HTTP_MAX_RETRIES = 3;
export const HTTP_BACKOFF_BASE_MS = 1000;
/** api_cache TTLs. Search results go stale faster than paper metadata. */
export const API_CACHE_TTL_MS = {
  search: 24 * 60 * 60 * 1000,
  metadata: 7 * 24 * 60 * 60 * 1000,
  citations: 3 * 24 * 60 * 60 * 1000,
} as const;

export const FULLTEXT_MAX_CHARS = 80_000;
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
/** S2 batch endpoints accept up to 500 ids; stay well under. */
export const S2_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const MAX_CONCURRENT_SEARCHES = 2;
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** A running search whose heartbeat is older than this is swept to `interrupted`. */
export const STALE_HEARTBEAT_MS = 60_000;
/** Rows per chunked transaction before yielding the event loop. */
export const DB_CHUNK_SIZE = 200;
/** Client poll interval for SearchProgress. */
export const SEARCH_POLL_INTERVAL_MS = 2_000;
