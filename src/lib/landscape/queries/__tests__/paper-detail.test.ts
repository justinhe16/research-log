import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { getPaperDetail } from "@/lib/landscape/queries/paper-detail";
import { seedLandscape } from "./seed";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  seedLandscape(db);
});

afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

describe("getPaperDetail", () => {
  it("returns null for an unknown paper", () => {
    expect(getPaperDetail(db, "missing")).toBeNull();
  });

  it("returns global fields only without a searchId", () => {
    const d = getPaperDetail(db, "p1")!;
    expect(d.search).toBeNull();
    expect(d).toMatchObject({
      id: "p1",
      title: "Paper 1",
      abstract: "Abstract of paper 1. It has two sentences.",
      authors: ["Author 1", "Second 1"],
      authorsDetailed: [{ name: "Author 1", hIndex: 11 }, { name: "Second 1" }],
      citationCount: 100,
      velocity: null,
      pagerank: null,
      loggedEntryId: "entry-1",
      hasExtraction: true,
    });
  });

  it("prefers the current-version full-text extraction", () => {
    const d = getPaperDetail(db, "p1", "s1")!;
    expect(d.extraction).toEqual({
      source: "fulltext",
      model: "haiku",
      problem: "pf",
      method: "mf",
      results: "rf",
      contribution: "Fulltext contribution 1",
      limitations: "lim",
      datasets: ["d1"],
      benchmarks: ["b1"],
      createdAt: "2026-09-01T10:00:30.000Z",
    });
    expect(d.tldr).toBe("Fulltext contribution 1");
  });

  it("adds the search block with in-landscape relations", () => {
    const d = getPaperDetail(db, "p1", "s1")!;
    expect(d.citationCount).toBe(90);
    expect(d.velocity).toBe(20);
    expect(d.pagerank).toBeCloseTo(0.5);
    expect(d.search).toMatchObject({
      searchId: "s1",
      ref: "P1",
      rank: 1,
      selected: true,
      influence: 0.9,
      clusterIdx: 0,
      clusterLabel: "Named zero",
      origin: "query",
      foundational: true,
      gameChanger: false,
    });
    expect(d.search!.relevance).toBeCloseTo(1);
    // p5 is not selected, so the similar edge is excluded.
    expect(d.search!.relations).toEqual([
      { paper: { id: "p2", title: "Paper 2", year: 2022, clusterIdx: 0, rank: 2 }, kind: "cites", direction: "in", weight: 1 },
      { paper: { id: "p3", title: "Paper 3", year: 2023, clusterIdx: 1, rank: 3 }, kind: "builds_on", direction: "in", weight: 0.8 },
    ]);
  });

  it("describes an unselected candidate and outgoing edges", () => {
    const d5 = getPaperDetail(db, "p5", "s1")!;
    expect(d5.search).toMatchObject({ selected: false, rank: null, ref: "", clusterIdx: null, clusterLabel: null });
    expect(d5.search!.relevance).toBeCloseTo(0);
    expect(d5.search!.relations).toEqual([
      { paper: { id: "p1", title: "Paper 1", year: 2021, clusterIdx: 0, rank: 1 }, kind: "similar", direction: "in", weight: 0.7 },
    ]);

    const d3 = getPaperDetail(db, "p3", "s1")!;
    expect(d3.search!.gameChanger).toBe(true);
    expect(d3.search!.clusterLabel).toBe("heuristic one");
    expect(d3.search!.relations).toEqual([
      { paper: { id: "p1", title: "Paper 1", year: 2021, clusterIdx: 0, rank: 1 }, kind: "builds_on", direction: "out", weight: 0.8 },
    ]);
  });

  it("ignores a searchId the paper is not part of", () => {
    const d = getPaperDetail(db, "p1", "other-search")!;
    expect(d.search).toBeNull();
    expect(d.citationCount).toBe(100);
  });

  it("falls back to the search-linked extraction and reports none for p4", () => {
    expect(getPaperDetail(db, "p2", "s1")!.extraction?.contribution).toBe("Contribution 2");
    const d4 = getPaperDetail(db, "p4", "s1")!;
    expect(d4.extraction).toBeNull();
    expect(d4.hasExtraction).toBe(false);
  });
});
