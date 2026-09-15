import {
  COSINE_RELEVANCE_CENTER,
  COSINE_RELEVANCE_TEMPERATURE,
  RERANK_LOGIT_CENTER,
  RERANK_LOGIT_TEMPERATURE,
} from "../constants";

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** Temperature-scaled sigmoid of a cross-encoder logit: a well-spread 0..1 relevance whose
 *  order is exactly the logit order (see RERANK_LOGIT_CENTER for the calibration). */
export function logitRelevance(logit: number): number {
  if (!Number.isFinite(logit)) return logit > 0 ? 1 : 0;
  return sigmoid((logit - RERANK_LOGIT_CENTER) / RERANK_LOGIT_TEMPERATURE);
}

/** Same scale for the bi-encoder cosine fallback. */
export function cosineRelevance(cosine: number): number {
  if (!Number.isFinite(cosine)) return 0;
  return sigmoid((cosine - COSINE_RELEVANCE_CENTER) / COSINE_RELEVANCE_TEMPERATURE);
}
