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
    foundationalReserve: 4,
    frontierReserve: 3,
    canonical: { perSource: 100, maxAdmitted: 15 },
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
    foundationalReserve: 8,
    frontierReserve: 6,
    canonical: { perSource: 150, maxAdmitted: 40 },
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
    foundationalReserve: 18,
    frontierReserve: 12,
    canonical: { perSource: 200, maxAdmitted: 80 },
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

// --- Relevance calibration & selection (rank/select.ts) ---

/** Stored relevance (search_papers.rerank, 0..1) = sigmoid((logit - CENTER) / TEMPERATURE).
 *  ms-marco-MiniLM-L-6 logits on a real pool: on-topic abstracts 7.5..9.6, borderline 4..7,
 *  off-topic < 2. A plain sigmoid saturates at 0.9993-0.9999 for the whole on-topic band, so
 *  it cannot separate candidates; with center 5 / temperature 2 that band maps to ~0.78..0.91
 *  and the order is exactly the logit order. Recalibrate if LANDSCAPE_RERANK_MODEL changes. */
export const RERANK_LOGIT_CENTER = 5;
export const RERANK_LOGIT_TEMPERATURE = 2;
/** Cosine fallback (MiniLM bi-encoder): on-topic 0.55..0.75, off-topic < 0.45. */
export const COSINE_RELEVANCE_CENTER = 0.45;
export const COSINE_RELEVANCE_TEMPERATURE = 0.08;
/** Bump when the stored rerank scale changes, so refresh never reuses base scores on another scale. */
export const RERANK_SCORE_VERSION = 2;

/** Selection score = relevance (dominant) + influence prior. With relevance spread over ~0.13
 *  inside the on-topic band, a 0.3 prior weight lets a well-cited on-topic paper beat a
 *  marginally higher-scoring uncited one, while an off-topic classic (relevance < 0.2) still
 *  loses to any on-topic paper. Sums to 1. */
export const SELECTION_WEIGHTS = { relevance: 0.7, influence: 0.3 } as const;
/** Influence prior at rerank time (before the graph stage): within-candidate percentiles of
 *  log1p(citations) and citation velocity. Sums to 1. */
export const INFLUENCE_PRIOR_WEIGHTS = { citations: 0.65, velocity: 0.35 } as const;
/** Reserve (foundational / frontier) candidates need relevance >= this share of the best relevance. */
export const RESERVE_MIN_RELEVANCE_RATIO = 0.75;
/** "Recent" for the frontier reserve (and not eligible for the foundational one). */
export const FRONTIER_MONTHS = 12;
/** Diversity (MMR-style): redundancy = max(0, maxCosineToSelected - FLOOR) / (1 - FLOOR),
 *  subtracted with this weight. Same-field papers sit around 0.6-0.7 and are not penalized. */
export const MMR_SIM_FLOOR = 0.7;
export const MMR_WEIGHT = 0.15;
/** At or above this cosine two candidates are treated as the same work (e.g. preprint + journal copy). */
export const DUPLICATE_COSINE = 0.97;

/** Canonical recall and expansion drift: cosine (MiniLM) to the topic vector. Real pool:
 *  on-topic papers 0.5..0.75, off-topic keyword matches <= 0.45. */
export const CANONICAL_MIN_COSINE = 0.5;
/** Expanded queries below this cosine to the topic are dropped as drift. Short query text is
 *  noisy under MiniLM: on-topic facets measured 0.2..0.8 ("SAE evaluation benchmarks" 0.22 for
 *  "sparse autoencoders for interpretability") while real drift ("lottery ticket hypothesis
 *  pruning") scored 0.02, so only clear drift is cut. */
export const EXPAND_MIN_COSINE = 0.15;
/** Never drop more than this share of the expanded queries (acronym topics embed poorly). */
export const EXPAND_MAX_DROP_SHARE = 0.5;

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
/** A citation is promoted to `builds_on` when influential or the pair's cosine is at least this. */
export const BUILDS_ON_MIN_COSINE = 0.6;
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
/** After a 429 the host waits at least this long (or Retry-After, if longer) and its request
 *  spacing doubles for the rest of the process, up to `max`. Hosts not listed use the plain
 *  backoff and a 4x cap. */
export const RATE_LIMIT_PENALTY = {
  arxiv: { minBackoffMs: 10_000, maxIntervalMs: 10_000 },
  s2: { minBackoffMs: 5_000, maxIntervalMs: 10_000 },
} as const;
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
