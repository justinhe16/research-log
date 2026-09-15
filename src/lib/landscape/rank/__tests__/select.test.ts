import { describe, expect, it } from "vitest";
import { influencePrior, selectPapers, type SelectRow } from "@/lib/landscape/rank/select";

const NOW = new Date("2026-09-15T00:00:00Z");

const row = (
  paperId: string,
  rerank: number | null,
  extra: Partial<Omit<SelectRow, "paperId" | "rerank">> = {},
): SelectRow => ({ paperId, rerank, rrf: 0, citationCount: null, publishedAt: "2025-01-01", ...extra });

const vec = (...xs: number[]) => Float32Array.from(xs);
const opts = (selectCount: number, foundationalReserve = 0, frontierReserve = 0) => ({
  selectCount,
  foundationalReserve,
  frontierReserve,
  now: NOW,
});

describe("influencePrior", () => {
  it("blends citation and velocity percentiles; unknown citations are null", () => {
    const p = influencePrior(
      [
        { citationCount: 1000, publishedAt: "2023-01-01" },
        { citationCount: 10, publishedAt: "2026-06-01" },
        { citationCount: null, publishedAt: "2025-01-01" },
      ],
      NOW,
    );
    expect(p[0]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeNull();
  });
});

describe("selectPapers", () => {
  it("takes the top by relevance when there is no influence signal", () => {
    const rows = [row("a", 0.1), row("b", 0.9), row("c", 0.5), row("d", 0.7)];
    const out = selectPapers(rows, opts(2));
    expect(out.selected).toEqual(["b", "d"]);
    expect(out.foundational).toEqual([]);
    expect([...out.finalRank.entries()]).toEqual([
      ["b", 1],
      ["d", 2],
      ["c", 3],
      ["a", 4],
    ]);
  });

  it("breaks near-ties in relevance towards influential papers, but not across a relevance gap", () => {
    const rows = [
      row("niche", 0.91, { citationCount: 0, publishedAt: "2025-03-01" }),
      row("classic", 0.84, { citationCount: 1500, publishedAt: "2023-09-01" }),
      row("offtopic", 0.05, { citationCount: 50_000, publishedAt: "2019-01-01" }),
    ];
    const out = selectPapers(rows, opts(2));
    expect(out.selected).toEqual(["classic", "niche"]);
    expect(out.scores.get("classic")!).toBeGreaterThan(out.scores.get("niche")!);
    expect(out.selected).not.toContain("offtopic");
  });

  it("reserves foundational slots for older, most-cited relevant papers", () => {
    const rows = [
      row("r1", 0.95, { citationCount: 1, publishedAt: "2025-10-01" }),
      row("r2", 0.94, { citationCount: 2, publishedAt: "2025-11-01" }),
      row("r3", 0.93, { citationCount: 3, publishedAt: "2025-12-01" }),
      row("f1", 0.75, { citationCount: 900, publishedAt: "2023-01-01" }),
      row("low", 0.2, { citationCount: 99_999, publishedAt: "2020-01-01" }), // below the relevance ratio
    ];
    const out = selectPapers(rows, opts(3, 1));
    expect(out.foundational).toEqual(["f1"]);
    expect(out.selected).toContain("f1");
    expect(out.selected).not.toContain("low");
    expect(out.selected).toHaveLength(3);
  });

  it("reserves frontier slots for the most relevant recent papers even with no citations", () => {
    const rows = [
      row("old1", 0.9, { citationCount: 500, publishedAt: "2022-01-01" }),
      row("old2", 0.88, { citationCount: 400, publishedAt: "2022-06-01" }),
      row("old3", 0.87, { citationCount: 300, publishedAt: "2023-01-01" }),
      row("new", 0.89, { citationCount: 0, publishedAt: "2026-08-01" }),
      row("newer-less-relevant", 0.5, { citationCount: 0, publishedAt: "2026-09-01" }),
    ];
    const without = selectPapers(rows, opts(2));
    expect(without.selected).not.toContain("new");
    const withReserve = selectPapers(rows, opts(2, 0, 1));
    expect(withReserve.frontier).toEqual(["new"]);
    expect(withReserve.selected).toContain("new");
    expect(withReserve.selected).not.toContain("newer-less-relevant");
  });

  it("skips near-duplicates and penalizes redundant picks", () => {
    const rows = [
      row("a", 0.9, { embedding: vec(1, 0, 0) }),
      row("a-copy", 0.89, { embedding: vec(1, 0.01, 0) }),
      row("similar", 0.88, { embedding: vec(0.85, 0.53, 0) }), // cos ~0.85 to a
      row("different", 0.86, { embedding: vec(0, 1, 0) }),
    ];
    const out = selectPapers(rows, opts(2));
    expect(out.selected).toEqual(["a", "different"]);
    expect(out.duplicates).toContain("a-copy");
    const three = selectPapers(rows, opts(3));
    expect(three.selected).toEqual(["a", "similar", "different"]);
    expect(three.selected).not.toContain("a-copy");
  });

  it("treats an identical normalized title as a duplicate record", () => {
    const rows = [
      row("preprint", 0.9, { title: "Sparse Autoencoders Reveal Cell-Type Programs" }),
      row("journal", 0.88, { title: "Sparse autoencoders reveal cell-type programs." }),
      row("other", 0.5, { title: "Something else" }),
    ];
    const out = selectPapers(rows, opts(2));
    expect(out.selected).toEqual(["preprint", "other"]);
    expect(out.duplicates).toEqual(["journal"]);
  });

  it("scales rrf into relevance when nothing was reranked", () => {
    const rows = [
      row("a", null, { rrf: 0.01 }),
      row("b", null, { rrf: 0.03 }),
      row("c", null, { rrf: 0.02 }),
      row("d", null, { rrf: 0.005 }),
    ];
    expect(selectPapers(rows, opts(2)).selected).toEqual(["b", "c"]);
  });

  it("fills with un-reranked rows only after reranked ones, by rrf", () => {
    const rows = [row("n", null, { rrf: 0.9, citationCount: 10_000 }), row("a", 0.2), row("b", 0.1)];
    const out = selectPapers(rows, opts(1, 1));
    expect(out.selected).toEqual(["a"]);
    expect([...out.finalRank.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
      ["n", 3],
    ]);
    expect(selectPapers(rows, opts(3)).selected).toEqual(["a", "b", "n"]);
  });

  it("handles small pools and zero counts", () => {
    const empty = selectPapers([], opts(5, 2, 2));
    expect(empty.selected).toEqual([]);
    expect(empty.finalRank.size).toBe(0);
    const rows = [row("a", 0.5), row("b", 0.4)];
    expect(selectPapers(rows, opts(5, 2, 2)).selected).toEqual(["a", "b"]);
    expect(selectPapers(rows, opts(0, 2)).selected).toEqual([]);
  });
});
