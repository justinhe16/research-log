import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock transformers.js so no model is downloaded. The fake "model" returns a
// logit of -3 for docs mentioning "sparse" and -11 otherwise, shaped [batch, 1].
const state = vi.hoisted(() => ({
  failLoads: 0,
  loads: [] as string[],
  batches: [] as number[],
  /** Head shape for the fake model: 1 = relevance logit, 2 = [neg, pos]. */
  labels: 1,
  /** Logit columns actually emitted (defaults to `labels`). */
  emitCols: null as number | null,
}));

vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: {
    from_pretrained: async (model: string) => {
      state.loads.push(model);
      if (state.failLoads > 0) {
        state.failLoads--;
        throw new Error("network down");
      }
      return (queries: string[], opts: { text_pair: string[] }) => ({ queries, pairs: opts.text_pair });
    },
  },
  AutoModelForSequenceClassification: {
    from_pretrained: async () => {
      const labels = state.labels;
      const model = async (inputs: { pairs: string[] }) => {
        state.batches.push(inputs.pairs.length);
        const cols = state.emitCols ?? labels;
        const rows = inputs.pairs.map((p) => {
          const rel = p.includes("sparse");
          if (cols === 1) return [rel ? -3 : -11];
          if (cols === 2) return rel ? [-1, 2] : [3, -1]; // [neg, pos]
          return Array.from({ length: cols }, () => 0);
        });
        return { logits: { data: Float32Array.from(rows.flat()), dims: [rows.length, cols] } };
      };
      return Object.assign(model, {
        config: { num_labels: labels, id2label: Object.fromEntries(Array.from({ length: labels }, (_, i) => [String(i), `LABEL_${i}`])) },
      });
    },
  },
}));

import { RERANK_MODEL } from "@/lib/landscape/constants";
import {
  CrossEncoderUnavailable,
  scorePairs,
  scorePairsDetailed,
  sigmoid,
} from "@/lib/landscape/rank/cross-encoder";

describe("cross-encoder (mocked transformers)", () => {
  beforeEach(() => {
    (globalThis as { __researchLogCrossEncoders?: unknown }).__researchLogCrossEncoders = undefined;
    state.failLoads = 0;
    state.loads = [];
    state.batches = [];
    state.labels = 1;
    state.emitCols = null;
  });
  afterEach(() => {
    delete process.env.LANDSCAPE_RERANK_MODEL;
  });

  it("scores pairs in order, batches, reports progress and caches the model", async () => {
    const docs = ["sparse autoencoders", "image segmentation", "x".repeat(5000), "sparse coding"];
    const progress: number[] = [];
    const out = await scorePairsDetailed("sae interpretability", docs, {
      batchSize: 3,
      onProgress: (done) => progress.push(done),
    });
    expect(out.raw).toEqual([-3, -11, -11, -3]);
    expect(out.scores[0]).toBeCloseTo(sigmoid(-3), 10);
    expect(out.scores[0]).toBeGreaterThan(out.scores[1]);
    expect(out.scores.every((s) => s > 0 && s < 1)).toBe(true);
    expect(state.batches).toEqual([3, 1]);
    expect(progress).toEqual([3, 4]);

    expect(await scorePairs("q", ["sparse"])).toEqual([sigmoid(-3)]);
    expect(await scorePairs("q", [])).toEqual([]);
    expect(state.loads).toEqual([RERANK_MODEL]);
  });

  it("honours LANDSCAPE_RERANK_MODEL at call time", async () => {
    process.env.LANDSCAPE_RERANK_MODEL = "Xenova/other-reranker";
    await scorePairs("q", ["doc"]);
    expect(state.loads).toEqual(["Xenova/other-reranker"]);
  });

  it("throws CrossEncoderUnavailable on load failure without caching it", async () => {
    state.failLoads = 1;
    await expect(scorePairs("q", ["doc"])).rejects.toBeInstanceOf(CrossEncoderUnavailable);
    expect(await scorePairs("q", ["sparse"])).toEqual([sigmoid(-3)]);
    expect(state.loads.length).toBe(2);
  });

  it("uses the positive label of a 2-column head", async () => {
    state.labels = 2;
    const out = await scorePairsDetailed("q", ["sparse", "other"]);
    expect(out.raw).toEqual([3, -4]);
    // softmax p(pos) for [-1, 2] = e^2 / (e^-1 + e^2)
    expect(out.scores[0]).toBeCloseTo(Math.exp(2) / (Math.exp(-1) + Math.exp(2)), 10);
    expect(out.scores[1]).toBeCloseTo(Math.exp(-1) / (Math.exp(3) + Math.exp(-1)), 10);
  });

  it("rejects heads with other label counts or mismatched logits", async () => {
    state.labels = 3;
    await expect(scorePairs("q", ["doc"])).rejects.toBeInstanceOf(CrossEncoderUnavailable);

    (globalThis as { __researchLogCrossEncoders?: unknown }).__researchLogCrossEncoders = undefined;
    state.labels = 1;
    state.emitCols = 2; // config says 1 label, model emits 2 columns
    await expect(scorePairs("q", ["doc"])).rejects.toBeInstanceOf(CrossEncoderUnavailable);
  });
});
