import { describe, expect, it, vi } from "vitest";

// Fake feature-extraction pipeline: a 2-dim vector [len(text), index-in-batch],
// flattened like the real tensor ([batch, dims]). No model download.
const calls = vi.hoisted(() => ({ batches: [] as string[][] }));

vi.mock("@huggingface/transformers", () => ({
  pipeline: async () => async (texts: string | string[]) => {
    const list = Array.isArray(texts) ? texts : [texts];
    calls.batches.push(list);
    return { data: Float32Array.from(list.flatMap((t, i) => [t.length, i])), dims: [list.length, 2] };
  },
}));

import { embedMany } from "@/lib/embedding";

describe("embedMany", () => {
  it("embeds in batches, preserving order and reporting progress", async () => {
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    const progress: [number, number][] = [];
    const out = await embedMany(texts, { batchSize: 2, onProgress: (d, t) => progress.push([d, t]) });
    expect(out.map((v) => Array.from(v))).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 1],
      [5, 0],
    ]);
    expect(calls.batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it("returns [] for no texts and rejects empty ones", async () => {
    expect(await embedMany([])).toEqual([]);
    await expect(embedMany(["ok", "   "])).rejects.toThrow(/index 1/);
  });
});
