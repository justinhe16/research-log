import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { landscapeSnapshotFixture } from "@/components/landscape/__fixtures__/snapshot";
import { createDb, type Db } from "@/lib/db/create";
import { searchDocuments, searches, topics } from "@/lib/db/schema";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";
import { getLandscapeSnapshot } from "@/lib/landscape/queries/snapshot";
import { getLatestDoneSearchId, listSearchesForTopic } from "@/lib/landscape/queries/searches";
import { seedLandscape } from "./seed";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

const keys = (o: object) => Object.keys(o).sort();

describe("getLandscapeSnapshot", () => {
  it("returns null for an unknown search", () => {
    expect(getLandscapeSnapshot(db, "nope")).toBeNull();
  });

  it("has exactly the fixture's shape", () => {
    seedLandscape(db);
    const snap = getLandscapeSnapshot(db, "s1")!;
    const fx = landscapeSnapshotFixture;

    expect(keys(snap)).toEqual(keys(fx));
    expect(keys(snap.topic)).toEqual(keys(fx.topic));
    expect(keys(snap.search)).toEqual(keys(fx.search));
    expect(keys(snap.search.queries[0])).toEqual(keys(fx.search.queries[0]));
    expect(keys(snap.papers[0])).toEqual(keys(fx.papers[0]));
    expect(keys(snap.clusters[0])).toEqual(keys(fx.clusters[0]));
    expect(keys(snap.edges[0])).toEqual(keys(fx.edges[0]));
    expect(keys(snap.documents)).toEqual(keys(fx.documents));
    // Value types line up field by field (null is allowed wherever the contract says so).
    for (const [k, v] of Object.entries(fx.papers[0])) {
      const got = (snap.papers[0] as Record<string, unknown>)[k];
      if (got !== null && v !== null) expect(typeof got, k).toBe(typeof v);
    }
  });

  it("maps papers: order, refs, normalization, extraction, logged and game-changer markers", () => {
    seedLandscape(db);
    const snap = getLandscapeSnapshot(db, "s1")!;

    expect(snap.papers.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]); // p5 unselected
    const [p1, p2, p3, p4] = snap.papers;

    expect(p1).toMatchObject({
      ref: "P1",
      rank: 1,
      authors: ["Author 1", "Second 1"],
      citationCount: 90, // search-time snapshot beats the global value
      velocity: 20,
      foundational: true,
      loggedEntryId: "entry-1", // matched by versionless arXiv id
      hasExtraction: true,
      tldr: "Fulltext contribution 1", // no linked extraction -> current fulltext wins
      origin: "query",
    });
    // Relevance: min-max over the whole pool (rerank -2..8).
    expect(p1.relevance).toBeCloseTo(1);
    expect(p2.relevance).toBeCloseTo(0.6);
    expect(p4.relevance).toBeCloseTo(0.2);
    // PageRank divided by pool max (0.04).
    expect(p1.pagerank).toBeCloseTo(0.5);
    expect(p3.pagerank).toBeCloseTo(1);

    expect(p2).toMatchObject({ tldr: "Contribution 2", hasExtraction: true, loggedEntryId: null, citationCount: 200 });
    // p4: no extraction, no abstract.
    expect(p4).toMatchObject({ hasExtraction: false, tldr: null, origin: "citation" });
    // Narrative present -> its game-changers win over the graph-stage candidate flag.
    expect(p3.gameChanger).toBe(true);
    expect(p4.gameChanger).toBe(false);
    expect(p3.tldr).toBe("Abstract of paper 3. It has two sentences.");
  });

  it("merges cluster rows with the clusters document", () => {
    seedLandscape(db);
    const snap = getLandscapeSnapshot(db, "s1")!;
    expect(snap.clusters).toEqual([
      {
        idx: 0,
        label: "Named zero",
        summary: "doc summary",
        keyTerms: ["a", "b"],
        size: 2,
        yearMin: 2021,
        yearMax: 2022,
        paperIds: ["p1", "p2"],
        color: 1,
        baseClusterIdx: null,
        change: null,
      },
      {
        idx: 1,
        label: "heuristic one",
        summary: "row summary",
        keyTerms: ["c"],
        size: 2,
        yearMin: 2023,
        yearMax: 2024,
        paperIds: ["p3", "p4"],
        color: 2,
        baseClusterIdx: null,
        change: null,
      },
    ]);
    expect(snap.topic.summary).toBe("Synthesized summary");
  });

  it("keeps only edges among selected papers", () => {
    seedLandscape(db);
    const snap = getLandscapeSnapshot(db, "s1")!;
    expect(snap.edges).toEqual(
      expect.arrayContaining([
        { source: "p2", target: "p1", kind: "cites", weight: 1 },
        { source: "p3", target: "p1", kind: "builds_on", weight: 0.8 },
      ]),
    );
    expect(snap.edges).toHaveLength(2);
  });

  it("nulls invalid and errored documents and reports them as failed", () => {
    seedLandscape(db);
    const snap = getLandscapeSnapshot(db, "s1")!;
    expect(snap.documents.clusters?.topicSummary).toBe("Synthesized summary");
    expect(snap.documents.narrative?.gameChangers).toHaveLength(1);
    expect(snap.documents.tensions).toBeNull();
    expect(snap.documents.gaps).toBeNull();
    expect(snap.documents.readingPath).toBeNull();
    expect(snap.documents.diff).toBeNull();
    expect(snap.failedDocuments).toEqual(["tensions", "gaps"]);
  });

  it("carries the running search summary", () => {
    seedLandscape(db);
    const snap = getLandscapeSnapshot(db, "s1")!;
    expect(snap.search).toMatchObject({
      id: "s1",
      topicId: "t1",
      status: "running",
      stage: "extract",
      progress: 0.6,
      paperCount: 4,
      since: null,
      baseSearchId: null,
      queries: [{ text: "sae", arxiv: "abs:sae", categories: ["cs.LG"] }],
    });
  });

  it("handles an early partial search: no papers, clusters or documents", () => {
    seedLandscape(db);
    db.insert(searches)
      .values({ id: "s2", topicId: "t1", depth: "quick", config: DEPTH_PRESETS.quick, status: "done", createdAt: "2026-09-02T00:00:00.000Z" })
      .run();
    const snap = getLandscapeSnapshot(db, "s2")!;
    expect(snap.papers).toEqual([]);
    expect(snap.clusters).toEqual([]);
    expect(snap.edges).toEqual([]);
    expect(Object.values(snap.documents).every((d) => d === null)).toBe(true);
    expect(snap.failedDocuments).toEqual([]);
    // No synthesis for this search -> card summary.
    expect(snap.topic.summary).toBe("Card summary");
  });

  it("falls back to the candidate flag before the narrative exists", () => {
    seedLandscape(db);
    db.delete(searchDocuments).run();
    const snap = getLandscapeSnapshot(db, "s1")!;
    expect(snap.papers.filter((p) => p.gameChanger).map((p) => p.id)).toEqual(["p4"]);
    expect(snap.clusters[0].label).toBe("heuristic zero");
  });
});

describe("searches read model", () => {
  it("lists searches newest first and finds the latest done one", () => {
    seedLandscape(db);
    db.insert(searches)
      .values([
        { id: "old", topicId: "t1", depth: "quick", config: DEPTH_PRESETS.quick, status: "done", createdAt: "2026-01-01 00:00:00", finishedAt: "2026-01-01 00:05:00" },
        { id: "mid", topicId: "t1", depth: "deep", config: DEPTH_PRESETS.deep, status: "done", createdAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:10:00.000Z" },
        { id: "err", topicId: "t1", depth: "quick", config: DEPTH_PRESETS.quick, status: "error", createdAt: "2026-08-01T00:00:00.000Z" },
      ])
      .run();
    db.insert(topics).values({ id: "t2", slug: "other", name: "Other" }).run();

    expect(listSearchesForTopic(db, "t1").map((s) => s.id)).toEqual(["s1", "err", "mid", "old"]);
    expect(listSearchesForTopic(db, "t1")[0].paperCount).toBe(4);
    expect(getLatestDoneSearchId(db, "t1")).toBe("mid");
    expect(getLatestDoneSearchId(db, "t2")).toBeNull();
    expect(listSearchesForTopic(db, "t2")).toEqual([]);
  });
});
