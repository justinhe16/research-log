import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, priceFor } from "@/lib/llm/pricing";
import {
  DEPTH_PRESETS,
  DOSSIER_TOKENS_PER_PAPER,
  EXTRACT_BATCH_SIZE,
  EXTRACT_CONCURRENCY,
  EXTRACTION_MODEL,
  RATE_LIMITS,
  SYNTHESIS_MODEL,
} from "./constants";
import type { Depth, DepthConfig, Estimate, EstimateOptions } from "./types";

/*
 * Pure cost/time model for the depth picker. Every number below is a rough
 * per-unit assumption; the structure mirrors the pipeline so each term can be
 * recalibrated from `llm_calls` history and stage timings later.
 */

// --- token assumptions (per call) ---
const EXPAND = { input: 1_200, output: 700 };
const EXTRACT_SYSTEM_TOKENS = 1_500;
const ABSTRACT_TOKENS = 350;
const EXTRACTION_OUTPUT_TOKENS = 220;
const FULLTEXT_INPUT_TOKENS = 16_500;
const FULLTEXT_OUTPUT_TOKENS = 900;
/** Synthesis instructions + cluster listing that ride along in the cached dossier. */
const DOSSIER_BASE_TOKENS = 1_500;
const DOSSIER_TOKENS_PER_CLUSTER = 60;
/** Uncached per-call instructions after the dossier. */
const SYNTH_TAIL_TOKENS = 400;
const SYNTH_OUTPUT = {
  clustersBase: 400,
  perCluster: 200,
  tensions: 1_800,
  gaps: 1_800,
  narrative: 2_000,
  readingPath: 1_500,
};
/** Allowance for retries (failed batches, invalid-ref retries). */
const RETRY_OVERHEAD = 1.1;

// --- time assumptions (seconds) ---
const HTTP_LATENCY_S = 1;
const EMBED_S_PER_PAPER = 0.015;
const RERANK_S_PER_PAIR = 0.013; // Phase A spike: ~13ms/pair fp32 on CPU
const MODEL_LOAD_S = 4;
const PDF_PARSE_S = 4;
const EXTRACT_CALL_S = 12;
const FULLTEXT_EXTRACT_S = 15;
const EXPAND_S = 6;
const SYNTH_FIRST_S = 45; // S1 runs alone to write the cache
const SYNTH_PARALLEL_S = 55; // the rest run in parallel, bounded by the slowest
const LOCAL_ML_S = 3; // graph + cluster
const S2_AUTHOR_IDS_PER_PAPER = 4;
const S2_BATCH = 100;

const RANGE = { low: 0.7, high: 1.5 };

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Share of the selection expected to be new on a refresh after `daysSince` days. */
export function refreshNewFraction(config: DepthConfig, daysSince: number): number {
  const windowDays = (config.windowYears ?? 10) * 365;
  return Math.min(1, Math.max(0.1, daysSince / windowDays));
}

export function estimate(depthOrConfig: Depth | DepthConfig, opts: EstimateOptions): Estimate {
  const config = typeof depthOrConfig === "string" ? DEPTH_PRESETS[depthOrConfig] : depthOrConfig;
  const refresh = opts.refresh;
  const newFraction = refresh ? refreshNewFraction(config, refresh.daysSince) : 1;
  const notes: string[] = [];

  const haiku = priceFor(EXTRACTION_MODEL);
  const sonnet = priceFor(SYNTHESIS_MODEL);
  const usd = (tokens: number, perMTok: number) => (tokens * perMTok) / 1_000_000;

  // ---- Haiku: expand + extraction ------------------------------------------
  let haikuCalls = 0;
  let haikuIn = 0;
  let haikuOut = 0;

  if (!refresh) {
    haikuCalls += 1;
    haikuIn += EXPAND.input;
    haikuOut += EXPAND.output;
  }

  const toExtract = Math.ceil(config.selectCount * newFraction);
  const batches = Math.ceil(toExtract / EXTRACT_BATCH_SIZE);
  haikuCalls += batches;
  haikuIn += batches * EXTRACT_SYSTEM_TOKENS + toExtract * ABSTRACT_TOKENS;
  haikuOut += toExtract * EXTRACTION_OUTPUT_TOKENS;

  const fulltext = Math.ceil(config.fulltextCount * newFraction);
  haikuCalls += fulltext;
  haikuIn += fulltext * FULLTEXT_INPUT_TOKENS;
  haikuOut += fulltext * FULLTEXT_OUTPUT_TOKENS;

  const haikuCost = usd(haikuIn, haiku.input) + usd(haikuOut, haiku.output);

  // ---- Sonnet: synthesis over a cached dossier -----------------------------
  const clusters = config.kRange.max;
  const dossier =
    DOSSIER_BASE_TOKENS + config.selectCount * DOSSIER_TOKENS_PER_PAPER + clusters * DOSSIER_TOKENS_PER_CLUSTER;
  const clustersOut = SYNTH_OUTPUT.clustersBase + clusters * SYNTH_OUTPUT.perCluster;
  const followUpOutputs =
    config.synthesisCalls === 3
      ? [SYNTH_OUTPUT.tensions + SYNTH_OUTPUT.gaps, SYNTH_OUTPUT.narrative + SYNTH_OUTPUT.readingPath]
      : [SYNTH_OUTPUT.tensions, SYNTH_OUTPUT.gaps, SYNTH_OUTPUT.narrative, SYNTH_OUTPUT.readingPath];

  const sonnetCalls = 1 + followUpOutputs.length;
  const sonnetOut = clustersOut + followUpOutputs.reduce((a, b) => a + b, 0);
  const sonnetUncachedIn = sonnetCalls * SYNTH_TAIL_TOKENS;
  const sonnetCacheWrite = dossier;
  const sonnetCacheRead = dossier * followUpOutputs.length;
  const sonnetCost =
    usd(sonnetUncachedIn, sonnet.input) +
    usd(sonnetCacheWrite, sonnet.input * CACHE_WRITE_MULTIPLIER) +
    usd(sonnetCacheRead, sonnet.input * CACHE_READ_MULTIPLIER) +
    usd(sonnetOut, sonnet.output);

  const expectedCost = (haikuCost + sonnetCost) * RETRY_OVERHEAD;

  // ---- Wall time -----------------------------------------------------------
  const s2Interval = (opts.hasS2Key ? RATE_LIMITS.s2WithKey : RATE_LIMITS.s2WithoutKey) / 1000;
  const arxivInterval = RATE_LIMITS.arxiv / 1000;
  const s2Request = s2Interval + HTTP_LATENCY_S;
  const queries = config.expandedQueries + 1;

  let seconds = 0;
  if (!refresh) seconds += EXPAND_S;
  seconds += queries * (arxivInterval + HTTP_LATENCY_S) + queries * s2Request; // collect
  seconds += config.poolCap * newFraction * EMBED_S_PER_PAPER; // embeddings are cached per paper
  if (config.citations.hops > 0) {
    // references + citations per seed
    seconds += (config.citations.seeds + config.citations.hop2Seeds) * 2 * s2Request;
  }
  const enrichBatches =
    Math.ceil(config.poolCap / S2_BATCH) + Math.ceil((config.rerankTopN * S2_AUTHOR_IDS_PER_PAPER) / S2_BATCH);
  seconds += enrichBatches * s2Request;
  seconds += MODEL_LOAD_S + config.rerankTopN * RERANK_S_PER_PAIR;
  seconds += LOCAL_ML_S;
  seconds += fulltext * (arxivInterval + HTTP_LATENCY_S + PDF_PARSE_S);
  seconds += Math.ceil(batches / EXTRACT_CONCURRENCY) * EXTRACT_CALL_S + fulltext * FULLTEXT_EXTRACT_S;
  seconds += SYNTH_FIRST_S * (config.synthesisCalls === 3 ? 0.6 : 1) + SYNTH_PARALLEL_S;

  const minutes = seconds / 60;

  if (!opts.hasS2Key) {
    notes.push("No Semantic Scholar API key: requests are throttled, so collection and citations run slower.");
  }
  if (refresh) {
    notes.push(
      `Refresh reuses the previous queries and only reads new papers (~${Math.round(newFraction * 100)}% of the selection).`,
    );
  }

  return {
    depth: config.depth,
    costUsd: {
      expected: round(expectedCost, 3),
      low: round(expectedCost * RANGE.low, 3),
      high: round(expectedCost * RANGE.high, 3),
    },
    minutes: {
      expected: round(minutes, 1),
      low: round(minutes * RANGE.low, 1),
      high: round(minutes * RANGE.high, 1),
    },
    llmCalls: { haiku: haikuCalls, sonnet: sonnetCalls },
    tokens: {
      input: haikuIn + sonnetUncachedIn + sonnetCacheWrite + sonnetCacheRead,
      output: haikuOut + sonnetOut,
    },
    notes,
  };
}
