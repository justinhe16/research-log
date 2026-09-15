import { describe, expect, it } from "vitest";
import { selectPapers, type SelectRow } from "@/lib/landscape/rank/select";

const row = (paperId: string, rerank: number | null, influence: number | null = null, rrf = 0): SelectRow => ({
  paperId,
  rerank,
  rrf,
  influence,
});

describe("selectPapers", () => {
  it("takes the top by rerank with no reserve", () => {
    const rows = [row("a", 0.1), row("b", 0.9), row("c", 0.5), row("d", 0.7)];
    const out = selectPapers(rows, { selectCount: 2, foundationalReserve: 0 });
    expect(out.selected).toEqual(["b", "d"]);
    expect(out.foundational).toEqual([]);
    expect([...out.finalRank.entries()]).toEqual([
      ["b", 1],
      ["d", 2],
      ["c", 3],
      ["a", 4],
    ]);
  });

  it("swaps bottom slots for high-influence papers above the floor", () => {
    const rows = [
      row("r1", 0.95, 0.1),
      row("r2", 0.9, 0.2),
      row("r3", 0.85, 0.1),
      row("r4", 0.8, 0.05),
      row("f1", 0.6, 0.99), // foundational, clears the floor
      row("f2", 0.5, 0.9),
      row("low", 0.01, 1.0), // most influential but below the 25th percentile
      row("x1", 0.3, 0.0),
      row("x2", 0.2, null),
    ];
    const out = selectPapers(rows, { selectCount: 4, foundationalReserve: 2 });
    // floor = sorted reranks [.01,.2,.3,.5,.6,.8,.85,.9,.95][floor(.25*8)=2] = 0.3
    expect(out.foundational).toEqual(["f1", "f2"]);
    // r4 (0.05) and r3 (0.1) are the weakest in the bottom two slots.
    expect(out.selected).toEqual(["r1", "r2", "f1", "f2"]);
    expect(out.finalRank.get("f2")).toBe(4);
    expect(out.finalRank.get("r3")).toBe(5);
    expect(out.finalRank.size).toBe(rows.length);
  });

  it("does not swap when the candidate is less influential than the slot", () => {
    const rows = [row("a", 0.9, 0.5), row("b", 0.8, 0.9), row("c", 0.7, 0.6), row("d", 0.6, 0.3)];
    const out = selectPapers(rows, { selectCount: 2, foundationalReserve: 1, floorPercentile: 0 });
    // Bottom slot is b (0.9); best candidate c (0.6) can't beat it.
    expect(out.selected).toEqual(["a", "b"]);
    expect(out.foundational).toEqual([]);
  });

  it("respects a higher floor percentile", () => {
    const rows = [row("a", 0.9, 0), row("b", 0.8, 0), row("c", 0.5, 1), row("d", 0.4, 1)];
    expect(selectPapers(rows, { selectCount: 2, foundationalReserve: 1, floorPercentile: 1 }).foundational).toEqual(
      [],
    );
    expect(selectPapers(rows, { selectCount: 2, foundationalReserve: 1 }).foundational).toEqual(["c"]);
  });

  it("orders by rrf when nothing was reranked", () => {
    const rows = [row("a", null, 0.1, 0.01), row("b", null, 0.1, 0.03), row("c", null, 0.9, 0.02), row("d", null, 0.2, 0.005)];
    const out = selectPapers(rows, { selectCount: 2, foundationalReserve: 1 });
    // order b, c, a, d; floor = rrf 25th pct = 0.005. Best candidate d (0.2) can't beat c (0.9).
    expect(out.selected).toEqual(["b", "c"]);
    const withReserve = selectPapers(rows, { selectCount: 1, foundationalReserve: 1 });
    expect(withReserve.selected).toEqual(["c"]);
    expect(withReserve.foundational).toEqual(["c"]);
  });

  it("puts un-reranked rows after reranked ones and never reserves them in a mixed pool", () => {
    const rows = [row("n", null, 1, 0.9), row("a", 0.2, 0), row("b", 0.1, 0.5)];
    const out = selectPapers(rows, { selectCount: 1, foundationalReserve: 1, floorPercentile: 0 });
    expect(out.selected).toEqual(["b"]);
    expect(out.foundational).toEqual(["b"]);
    expect([...out.finalRank.entries()]).toEqual([
      ["b", 1],
      ["a", 2],
      ["n", 3],
    ]);
  });

  it("handles small pools and zero counts", () => {
    expect(selectPapers([], { selectCount: 5, foundationalReserve: 2 })).toEqual({
      selected: [],
      finalRank: new Map(),
      foundational: [],
    });
    const rows = [row("a", 0.5, 1), row("b", 0.4, 0)];
    expect(selectPapers(rows, { selectCount: 5, foundationalReserve: 2 }).selected).toEqual(["a", "b"]);
    expect(selectPapers(rows, { selectCount: 0, foundationalReserve: 2 }).selected).toEqual([]);
  });
});
