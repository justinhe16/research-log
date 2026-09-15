import { describe, expect, it } from "vitest";
import { matchClusters, type MatchableCluster } from "../match";

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const axis = (i: number, dim = 8) => {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
};
const c = (idx: number, centroid: Float32Array, members: string[], label?: string): MatchableCluster => ({
  idx,
  centroid,
  members,
  label,
});

describe("matchClusters", () => {
  it("classifies stable, grew, shrank, new and gone", () => {
    const base = [
      c(0, axis(0), ids("a", 10), "A"),
      c(1, axis(1), ids("b", 10), "B"),
      c(2, axis(2), ids("s", 10), "S"),
      c(3, axis(3), ids("g", 6), "G"),
    ];
    const current = [
      c(0, axis(0), [...ids("a", 10), "a-new"], "A2"), // stable (+10%)
      c(1, axis(1), [...ids("b", 10), ...ids("bx", 4)], "B2"), // grew (+40%)
      c(2, axis(2), ids("s", 6), "S2"), // shrank (-40%)
      c(3, axis(5), ids("n", 5), "N"), // new
    ];
    const res = matchClusters(base, current);
    expect(res.current).toEqual([
      { idx: 0, baseClusterIdx: 0, change: "stable" },
      { idx: 1, baseClusterIdx: 1, change: "grew" },
      { idx: 2, baseClusterIdx: 2, change: "shrank" },
      { idx: 3, baseClusterIdx: null, change: "new" },
    ]);
    expect(res.changes[3]).toEqual({ idx: 3, baseIdxs: [], change: "new", label: "N", sizeBefore: 0, sizeAfter: 5 });
    expect(res.changes[4]).toEqual({ idx: null, baseIdxs: [3], change: "gone", label: "G", sizeBefore: 6, sizeAfter: 0 });
    expect(res.changes).toHaveLength(5);
  });

  it("detects a split", () => {
    const members = ids("x", 12);
    const base = [c(0, axis(0), members, "X")];
    const current = [c(0, axis(0), members.slice(0, 6), "X1"), c(1, axis(0), members.slice(6), "X2")];
    const res = matchClusters(base, current);
    expect(res.current.map((r) => r.change)).toEqual(["split", "split"]);
    expect(res.current.map((r) => r.baseClusterIdx)).toEqual([0, 0]);
    expect(res.changes.every((ch) => ch.change === "split" && ch.sizeBefore === 12 && ch.baseIdxs[0] === 0)).toBe(true);
    expect(res.changes.some((ch) => ch.change === "gone")).toBe(false);
  });

  it("detects a merge", () => {
    const base = [c(0, axis(0), ids("p", 8), "P"), c(1, axis(1), ids("q", 8), "Q")];
    const mid = new Float32Array(8);
    mid[0] = mid[1] = Math.SQRT1_2;
    const current = [c(0, mid, [...ids("p", 8), ...ids("q", 8)], "PQ")];
    const res = matchClusters(base, current);
    expect(res.current).toHaveLength(1);
    expect(res.current[0].change).toBe("merged");
    expect(res.current[0].baseClusterIdx).not.toBeNull();
    expect(res.changes).toEqual([{ idx: 0, baseIdxs: [0, 1], change: "merged", label: "PQ", sizeBefore: 16, sizeAfter: 16 }]);
  });

  it("matches by centroid when members changed entirely but topic is the same", () => {
    const res = matchClusters([c(4, axis(0), ids("old", 5))], [c(0, axis(0), ids("new", 5))]);
    expect(res.current[0]).toEqual({ idx: 0, baseClusterIdx: 4, change: "stable" });
  });
  it("never reports a base as gone when it is a current cluster's greedy match (split elsewhere)", () => {
    const shared = ids("sh", 4);
    const b1Own = ids("b1-", 6);
    const base = [c(1, axis(1), [...shared, ...b1Own], "B1"), c(3, axis(3), ids("b3-", 10), "B3")];
    const current = [
      c(0, axis(3), [...shared, ...ids("c0-", 2)], "C0"),
      c(1, axis(6), [...b1Own.slice(0, 4), ...ids("c1-", 2)], "C1"),
    ];
    const res = matchClusters(base, current);
    expect(res.changes.some((ch) => ch.change === "gone")).toBe(false);
    const c0 = res.changes.find((ch) => ch.idx === 0)!;
    expect(c0.change).toBe("split");
    expect(c0.baseIdxs).toEqual([3, 1]);
    expect(res.current[0]).toEqual({ idx: 0, baseClusterIdx: 3, change: "split" });
    expect(res.current[1]).toEqual({ idx: 1, baseClusterIdx: 1, change: "split" });
  });

  it("accepts many-to-many: one base in both a split row and a merged row", () => {
    const a = ids("a", 12);
    const base = [c(0, axis(0), a, "A"), c(1, axis(1), ids("b", 6), "B")];
    const current = [
      c(0, axis(0), a.slice(0, 6), "A-half"), // the part of A that stayed alone
      c(1, axis(2), [...a.slice(6), ...ids("b", 6)], "A-half+B"), // other half of A merged with B
    ];
    const res = matchClusters(base, current);
    expect(res.current.map((r) => r.change)).toEqual(["split", "merged"]);
    expect(res.changes[0].baseIdxs).toEqual([0]);
    expect([...res.changes[1].baseIdxs].sort()).toEqual([0, 1]);
    expect(res.changes.some((ch) => ch.change === "gone")).toBe(false);
  });
});
