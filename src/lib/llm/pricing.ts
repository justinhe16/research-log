import type { LlmUsage } from "@/lib/landscape/types";

/** USD per million tokens, first-party API list prices. */
export type ModelPrice = { input: number; output: number };

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
};

/** Prompt-caching multipliers on the input price (5-minute TTL). */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Resolve dated snapshot ids ("claude-haiku-4-5-20251001") to their family price. */
export function priceFor(model: string): ModelPrice {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  const family = Object.keys(MODEL_PRICES).find((k) => model.startsWith(`${k}-`));
  if (family) return MODEL_PRICES[family];
  throw new Error(`No price known for model "${model}". Add it to MODEL_PRICES.`);
}

/** Cost of one call. `inputTokens` excludes cache tokens, matching the API's usage. */
export function costUsd(model: string, usage: LlmUsage): number {
  const p = priceFor(model);
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    usage.inputTokens * perToken(p.input) +
    usage.cacheWriteTokens * perToken(p.input * CACHE_WRITE_MULTIPLIER) +
    usage.cacheReadTokens * perToken(p.input * CACHE_READ_MULTIPLIER) +
    usage.outputTokens * perToken(p.output)
  );
}
