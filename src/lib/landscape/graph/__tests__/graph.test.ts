import { describe, expect, it } from "vitest";
import { pagerank } from "@/lib/landscape/graph/pagerank";
import {
  gameChangerCandidates,
  influenceScores,
  percentileRanks,
  velocity,
  type InfluenceRow,
} from "@/lib/landscape/graph/metrics";
import { buildEdges } from "@/lib/landscape/graph/edges";

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("pagerank", () => {
  it("returns an empty map for an empty graph", () => {
    expect(pagerank([], []).size).toBe(0);
  });

  it("gives uniform scores with no edges", () => {
    const pr = pagerank(["a", "b", "c", "d"], []);
    for (const v of pr.values()) expect(v).toBeCloseTo(0.25, 9);
  });

  it("ranks a star's cited center highest and sums to 1", () => {
    const leaves = ["a", "b", "c", "d", "e"];
    const pr = pagerank(["hub", ...leaves], leaves.map((l) => ({ source: l, target: "hub" })));
    expect(sum(pr)).toBeCloseTo(1, 9);
    for (const l of leaves) expect(pr.get("hub")!).toBeGreaterThan(pr.get(l)!);
  });

  it("increases along a citation chain", () => {
    const pr = pagerank(["a", "b", "c", "d"], [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "d" },
    ]);
    expect(sum(pr)).toBeCloseTo(1, 9);
    expect(pr.get("b")!).toBeGreaterThan(pr.get("a")!);
    expect(pr.get("c")!).toBeGreaterThan(pr.get("b")!);
    expect(pr.get("d")!).toBeGreaterThan(pr.get("c")!);
  });

  it("redistributes dangling mass and ignores unknown nodes, self-loops and duplicates", () => {
    const pr = pagerank(["a", "b", "c"], [
      { source: "a", target: "b" },
      { source: "a", target: "b" },
      { source: "b", target: "b" },
      { source: "a", target: "zzz" },
      { source: "zzz", target: "c" },
    ]);
    expect(sum(pr)).toBeCloseTo(1, 9);
    // b and c are both dangling; c only receives the uniform share.
    expect(pr.get("b")!).toBeGreaterThan(pr.get("c")!);
    expect(pr.get("c")!).toBeCloseTo(pr.get("a")!, 9);
  });
});

describe("velocity", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("computes citations per year", () => {
    expect(velocity(20, "2024-01-01", now)).toBeCloseTo(10, 1);
  });
  it("floors the age at floorMonths", () => {
    expect(velocity(3, "2025-12-20", now)).toBeCloseTo(12, 6);
    expect(velocity(3, "2025-12-20", now, 6)).toBeCloseTo(6, 6);
  });
  it("returns null for missing inputs", () => {
    expect(velocity(null, "2024-01-01", now)).toBeNull();
    expect(velocity(5, null, now)).toBeNull();
    expect(velocity(5, "not a date", now)).toBeNull();
  });
});

describe("percentileRanks", () => {
  it("maps nulls to 0 and averages ties", () => {
    expect(percentileRanks([10, null, 20, 20, 30])).toEqual([0, 0, 0.5, 0.5, 1]);
  });
  it("handles all ties, a single value and empty input", () => {
    expect(percentileRanks([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
    expect(percentileRanks([null, 7])).toEqual([0, 1]);
    expect(percentileRanks([])).toEqual([]);
  });
});

describe("influenceScores", () => {
  const base = (id: string, x: number): InfluenceRow => ({
    id,
    citationCount: x,
    velocity: x,
    influentialCitationCount: x,
    pagerank: x,
    maxAuthorHIndex: x,
  });

  it("is monotone in every metric and bounded 0..1", () => {
    const scores = influenceScores([base("a", 1), base("b", 2), base("c", 3)]);
    expect(scores.get("a")).toBe(0);
    expect(scores.get("c")).toBeCloseTo(1, 9);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("a")!);
    expect(scores.get("c")!).toBeGreaterThan(scores.get("b")!);
  });

  it("raising one metric never lowers the score", () => {
    const rows = [base("a", 1), base("b", 2), base("c", 3)];
    const before = influenceScores(rows).get("a")!;
    const after = influenceScores([{ ...rows[0], pagerank: 99 }, rows[1], rows[2]]).get("a")!;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(0.2, 9); // pagerank weight
  });
});

describe("gameChangerCandidates", () => {
  it("only considers papers at or above the median citation count", () => {
    const rows = [
      { id: "low", citationCount: 1, velocity: 100, pagerank: 1 },
      { id: "m1", citationCount: 10, velocity: 5, pagerank: 0.2 },
      { id: "m2", citationCount: 20, velocity: 50, pagerank: 0.5 },
      { id: "m3", citationCount: null, velocity: 1, pagerank: 0.1 },
      { id: "top", citationCount: 30, velocity: 60, pagerank: 0.6 },
    ];
    // Median of [1,10,20,0,30] = 10.
    expect(gameChangerCandidates(rows)).toEqual(["top", "m2", "m1"]);
    expect(gameChangerCandidates(rows, { count: 1 })).toEqual(["top"]);
    expect(gameChangerCandidates([])).toEqual([]);
  });
});

describe("buildEdges", () => {
  const embeddings = new Map<string, number[]>([
    ["a", [1, 0, 0]],
    ["b", [0.9, 0.1, 0]], // very close to a
    ["c", [0, 1, 0]],
    ["d", [0.1, 0.9, 0]], // close to c
    ["e", [0, 0, 1]],
    ["x", [1, 0, 0]], // out of scope
  ]);
  const input = {
    selectedIds: ["a", "b", "c", "d"],
    foundationalIds: ["e"],
    citations: [
      { citing: "a", cited: "e", isInfluential: false }, // cosine 0 -> cites
      { citing: "d", cited: "c", isInfluential: false }, // cosine high -> builds_on
      { citing: "a", cited: "c", isInfluential: true }, // influential -> builds_on
      { citing: "a", cited: "c", isInfluential: false }, // duplicate
      { citing: "a", cited: "x", isInfluential: true }, // out of scope
      { citing: "b", cited: "b", isInfluential: true }, // self
    ],
    embeddings,
    similarK: 3,
  };

  it("assigns kinds, scopes, dedupes and orders deterministically", () => {
    const edges = buildEdges(input);
    expect(edges.map((e) => [e.kind, e.source, e.target])).toEqual([
      ["cites", "a", "e"],
      ["builds_on", "a", "c"],
      ["builds_on", "d", "c"],
      ["similar", "a", "b"],
    ]);
    expect(edges[3].weight).toBeGreaterThan(0.55);
  });

  it("excludes citation-linked pairs from similar edges", () => {
    const edges = buildEdges(input);
    expect(edges.some((e) => e.kind === "similar" && e.source === "c" && e.target === "d")).toBe(false);
  });

  it("is independent of input order", () => {
    const shuffled = buildEdges({
      ...input,
      selectedIds: [...input.selectedIds].reverse(),
      citations: [...input.citations].reverse(),
      embeddings: new Map([...embeddings].reverse()),
    });
    expect(shuffled).toEqual(buildEdges(input));
  });

  it("limits similar neighbours to top-k and dedupes undirected pairs", () => {
    const emb = new Map<string, number[]>([
      ["p", [1, 0]],
      ["q", [0.99, 0.1]],
      ["r", [0.95, 0.3]],
    ]);
    const edges = buildEdges({ selectedIds: ["p", "q", "r"], foundationalIds: [], citations: [], embeddings: emb, similarK: 1 });
    const pairs = edges.map((e) => `${e.source}-${e.target}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toEqual(["p-q", "q-r"]);
    expect(edges.every((e) => e.source < e.target)).toBe(true);
  });
});
