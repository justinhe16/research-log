/*
 * Local cross-encoder reranker (transformers.js). Scores (query, document) pairs
 * jointly, which is far more precise than bi-encoder cosine but ~13ms/pair, so
 * it only runs on the prerank top-N. If the model can't load or inference
 * fails, callers get `CrossEncoderUnavailable` and fall back to cosine.
 */

import { RERANK_MODEL } from "../constants";

/** ms-marco models are trained on passages; abstracts past this add latency, not signal. */
const MAX_DOC_CHARS = 1500;
const MAX_TOKENS = 512;

type Tensor = { data: Float32Array | number[]; dims?: number[] };
type Tokenizer = (
  text: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
) => unknown;
type ModelConfig = { num_labels?: number; id2label?: Record<string, string> };
type SequenceClassifier = ((inputs: unknown) => Promise<{ logits: Tensor }>) & {
  config?: ModelConfig;
};

export type CrossEncoder = {
  model: string;
  tokenizer: Tokenizer;
  classifier: SequenceClassifier;
  /** Logit columns per pair from the model config (1 = relevance head,
   *  2 = [negative, positive] classifier); null if the config doesn't say. */
  numLabels: number | null;
};

function numLabelsFromConfig(config: ModelConfig | undefined): number | null {
  if (typeof config?.num_labels === "number" && config.num_labels > 0) return config.num_labels;
  const labels = config?.id2label ? Object.keys(config.id2label).length : 0;
  return labels > 0 ? labels : null;
}

export class CrossEncoderUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CrossEncoderUnavailable";
  }
}

// Keyed by model id; cached on globalThis so dev HMR doesn't reload the weights.
const globalForRerank = globalThis as unknown as {
  __researchLogCrossEncoders?: Map<string, Promise<CrossEncoder>>;
};

function cache(): Map<string, Promise<CrossEncoder>> {
  globalForRerank.__researchLogCrossEncoders ??= new Map();
  return globalForRerank.__researchLogCrossEncoders;
}

/** RERANK_MODEL, unless LANDSCAPE_RERANK_MODEL is set (read at call time). */
export function rerankModelId(): string {
  return process.env.LANDSCAPE_RERANK_MODEL?.trim() || RERANK_MODEL;
}

export function getCrossEncoder(model: string = rerankModelId()): Promise<CrossEncoder> {
  const models = cache();
  let pending = models.get(model);
  if (!pending) {
    pending = (async () => {
      try {
        const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
          "@huggingface/transformers"
        );
        const tokenizer = await AutoTokenizer.from_pretrained(model);
        const classifier = await AutoModelForSequenceClassification.from_pretrained(model, {
          dtype: "fp32",
        });
        const typed = classifier as unknown as SequenceClassifier;
        const numLabels = numLabelsFromConfig(typed.config);
        if (numLabels !== null && numLabels !== 1 && numLabels !== 2) {
          throw new Error(`unsupported head with ${numLabels} labels (expected 1 or 2)`);
        }
        return { model, tokenizer: tokenizer as unknown as Tokenizer, classifier: typed, numLabels };
      } catch (err) {
        throw new CrossEncoderUnavailable(
          `Failed to load cross-encoder ${model}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    })().catch((err) => {
      // Don't cache a failed load: a transient download error shouldn't stick.
      if (models.get(model) === pending) models.delete(model);
      throw err;
    });
    models.set(model, pending);
  }
  return pending;
}

export function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

export type ScorePairsOptions = {
  batchSize?: number;
  /** Called after each batch with the number of pairs scored so far. */
  onProgress?: (done: number, total: number) => void;
  /** Override the model id (defaults to `rerankModelId()`). */
  model?: string;
};

export type PairScores = {
  /** sigmoid(raw), 0..1, in input order. For a 2-label head this equals the
   *  softmax probability of the positive label (index 1). */
  scores: number[];
  /** Raw logits (ms-marco MiniLM: roughly -3 relevant, -11 irrelevant). For a
   *  2-label head: logit[1] - logit[0]. */
  raw: number[];
};

/**
 * Score `query` against each doc. Returns both sigmoid-normalized and raw
 * scores in input order. Throws `CrossEncoderUnavailable` on load or inference
 * failure.
 */
export async function scorePairsDetailed(
  query: string,
  docs: readonly string[],
  { batchSize = 16, onProgress, model }: ScorePairsOptions = {},
): Promise<PairScores> {
  if (docs.length === 0) return { scores: [], raw: [] };
  const encoder = await getCrossEncoder(model ?? rerankModelId());
  const size = Math.max(1, Math.floor(batchSize));
  const q = (query ?? "").replace(/\s+/g, " ").trim();
  const raw: number[] = [];

  for (let start = 0; start < docs.length; start += size) {
    const batch = docs
      .slice(start, start + size)
      .map((d) => (d ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_DOC_CHARS));
    let logits: Tensor;
    try {
      const inputs = encoder.tokenizer(new Array(batch.length).fill(q), {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: MAX_TOKENS,
      });
      ({ logits } = await encoder.classifier(inputs));
    } catch (err) {
      throw new CrossEncoderUnavailable(
        `Cross-encoder inference failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const cols = logits.data.length / batch.length;
    if (!Number.isInteger(cols) || (cols !== 1 && cols !== 2) || (encoder.numLabels !== null && cols !== encoder.numLabels)) {
      throw new CrossEncoderUnavailable(
        `Cross-encoder returned ${logits.data.length} logits for ${batch.length} pairs` +
          (encoder.numLabels !== null ? ` (config num_labels=${encoder.numLabels})` : ""),
      );
    }
    for (let j = 0; j < batch.length; j++) {
      // 1 column: the relevance logit. 2 columns: positive (index 1) minus
      // negative, whose sigmoid is the softmax probability of the positive label.
      const row = j * cols;
      raw.push(cols === 1 ? Number(logits.data[row]) : Number(logits.data[row + 1]) - Number(logits.data[row]));
    }
    onProgress?.(raw.length, docs.length);
    if (start + size < docs.length) await new Promise<void>((r) => setImmediate(r));
  }

  return { scores: raw.map(sigmoid), raw };
}

/** Sigmoid-normalized (0..1) relevance per doc, in input order. */
export async function scorePairs(
  query: string,
  docs: readonly string[],
  opts: ScorePairsOptions = {},
): Promise<number[]> {
  return (await scorePairsDetailed(query, docs, opts)).scores;
}
