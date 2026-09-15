import { describe, expect, it } from "vitest";
import { diffDocumentSchema } from "../../llm/synthesize/schemas";
import { computeDiff, computeDiffWithMatch, publicationRate, type DiffSide } from "../diff";

const side = (selectedIds: string[], cites: Record<string, number>, clusters: DiffSide["clusters"] = []): DiffSide => ({
  selectedIds,
  citationCounts: new Map(Object.entries(cites)),
  clusters,
});

describe("computeDiff", () => {
  it("lists new and dropped papers in rank order", () => {
    const diff = computeDiff({
      baseSearchId: "s1",
      since: "2026-01-01T00:00:00.000Z",
      base: side(["a", "b", "c"], {}),
      current: side(["d", "a", "e", "c"], {}),
    });
    expect(diff.baseSearchId).toBe("s1");
    expect(diff.since).toBe("2026-01-01T00:00:00.000Z");
    expect(diff.newPaperIds).toEqual(["d", "e"]);
    expect(diff.droppedPaperIds).toEqual(["b"]);
    expect(diffDocumentSchema.safeParse(diff).success).toBe(true);
  });

  it("orders rising papers by delta, applies the threshold and caps at 10", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `p${i}`);
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    ids.forEach((id, i) => {
      before[id] = 100;
      after[id] = 100 + 5 + i; // deltas 5..18, all qualify
    });
    before.low = 10;
    after.low = 14; // delta 4: below threshold
    before.tie = 50;
    after.tie = 68; // delta 18 ties p13 but fewer total citations
    const diff = computeDiff({
      baseSearchId: "s1",
      base: side([...ids, "low", "tie"], before),
      current: side([...ids, "low", "tie", "fresh"], { ...after, fresh: 999 }),
    });
    expect(diff.rising).toHaveLength(10);
    expect(diff.rising[0]).toEqual({ paperId: "p13", citationsBefore: 100, citationsAfter: 118, delta: 18 });
    expect(diff.rising[1].paperId).toBe("tie");
    expect(diff.rising.map((r) => r.delta)).toEqual([18, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
    expect(diff.rising.find((r) => r.paperId === "low" || r.paperId === "fresh")).toBeUndefined();
    expect(diff.since).toBeNull();
  });

  it("includes cluster changes from matching", () => {
    const v = Float32Array.from([1, 0]);
    const { diff, match } = computeDiffWithMatch({
      baseSearchId: "s1",
      base: side(["a", "b", "c"], {}, [{ idx: 0, centroid: v, members: ["a", "b", "c"], label: "Old" }]),
      current: side(["a", "b", "c"], {}, [{ idx: 0, centroid: v, members: ["a", "b", "c"], label: "New" }]),
    });
    expect(diff.clusterChanges).toEqual([{ idx: 0, baseIdxs: [0], change: "stable", label: "New", sizeBefore: 3, sizeAfter: 3 }]);
    expect(match.current).toEqual([{ idx: 0, baseClusterIdx: 0, change: "stable" }]);
  });
});

describe("publicationRate", () => {
  it("computes monthly rate and half-year growth", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const pub = new Map<string, string | null>([
      ["a", "2026-09-01"],
      ["b", "2026-08-01"],
      ["c", "2026-06-01"],
      ["d", "2026-01-01"],
      ["e", "2024-01-01"],
      ["f", null],
    ]);
    const r = publicationRate(["a", "b", "c", "d", "e", "f"], pub, now);
    expect(r.monthlyRate).toBeCloseTo(4 / 12);
    expect(r.growth).toBeCloseTo(2); // 3 recent vs 1 earlier
    expect(publicationRate([], pub, now)).toEqual({ monthlyRate: 0, growth: null });
  });
});
