import { describe, expect, it } from "vitest";
import { rrfFuse } from "@/lib/landscape/rank/rrf";

const r = (...ids: string[]) => ids.map((id) => ({ id }));

describe("rrfFuse", () => {
  it("sums reciprocal ranks with the default k=60", () => {
    const out = rrfFuse([r("a", "b", "c"), r("b", "a")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(out[2].score).toBeCloseTo(1 / 63, 12);
    expect(out[0].ranks).toEqual({ "0": 1, "1": 2 });
    expect(out[2].ranks).toEqual({ "0": 3 });
  });

  it("breaks ties by first appearance", () => {
    expect(rrfFuse([r("x", "y"), r("y", "x")]).map((x) => x.id)).toEqual(["x", "y"]);
    expect(rrfFuse([r("p"), r("q")]).map((x) => x.id)).toEqual(["p", "q"]);
  });

  it("rewards consensus over a single top rank", () => {
    const out = rrfFuse([r("solo", "both"), r("x", "both"), r("y", "both")]);
    expect(out[0].id).toBe("both");
  });

  it("k controls how much the top rank dominates", () => {
    // a: rank 1 once; b: rank 3 twice.
    const rankings = [r("a", "x", "b"), r("y", "z", "b")];
    expect(rrfFuse(rankings, 1)[0].id).toBe("a"); // 1/2 vs 2/4: tie -> first appearance
    expect(rrfFuse(rankings, 0.5)[0].id).toBe("a");
    expect(rrfFuse(rankings, 60)[0].id).toBe("b");
  });

  it("accepts a named Map and ignores duplicate ids within a ranking", () => {
    const out = rrfFuse(new Map([["bm25", r("a", "a", "b")], ["cosine", r("b")]]), 10);
    const b = out.find((x) => x.id === "b")!;
    expect(b.ranks).toEqual({ bm25: 3, cosine: 1 });
    expect(out.find((x) => x.id === "a")!.score).toBeCloseTo(1 / 11, 12);
  });

  it("handles empty input", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });
});
