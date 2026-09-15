import { describe, expect, it } from "vitest";
import { buildBm25Index, scoreBm25, type Bm25Doc } from "@/lib/landscape/rank/bm25";

const docs: Bm25Doc[] = [
  { id: "d1", fields: { title: "graph neural", abstract: "graph data" } },
  { id: "d2", fields: { title: "image vision", abstract: "image segmentation" } },
  { id: "d3", fields: { title: "neural network", abstract: "graph graph network" } },
];

const byId = (rows: { id: string; score: number }[]) => Object.fromEntries(rows.map((r) => [r.id, r.score]));

describe("BM25F", () => {
  it("matches a hand computation on three docs", () => {
    const index = buildBm25Index(docs); // k1=1.2, b=0.75, title x2
    const scores = byId(scoreBm25(index, "graph"));

    // df(graph)=2, N=3
    const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));
    const avgTitle = 2;
    const avgAbstract = 7 / 3;
    // d1: title tf=1 len=2, abstract tf=1 len=2
    const d1tf = (2 * 1) / (0.25 + (0.75 * 2) / avgTitle) + 1 / (0.25 + (0.75 * 2) / avgAbstract);
    // d3: abstract tf=2 len=3
    const d3tf = 2 / (0.25 + (0.75 * 3) / avgAbstract);

    expect(scores.d1).toBeCloseTo((idf * d1tf) / (1.2 + d1tf), 10);
    expect(scores.d3).toBeCloseTo((idf * d3tf) / (1.2 + d3tf), 10);
    expect(scores.d1).toBeCloseTo(0.339447, 5);
    expect(scores.d3).toBeCloseTo(0.271903, 5);
    expect(scores.d2).toBe(0);
  });

  it("sorts by score with ties in index order", () => {
    const index = buildBm25Index(docs);
    expect(scoreBm25(index, "graph").map((r) => r.id)).toEqual(["d1", "d3", "d2"]);
    expect(scoreBm25(index, "nothing").map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("boosts title matches over abstract matches", () => {
    const pair: Bm25Doc[] = [
      { id: "abs", fields: { title: "alpha beta", abstract: "transformer gamma" } },
      { id: "title", fields: { title: "transformer beta", abstract: "alpha gamma" } },
    ];
    expect(scoreBm25(buildBm25Index(pair), "transformer")[0].id).toBe("title");
    // With equal weights the two are symmetric.
    const flat = byId(scoreBm25(buildBm25Index(pair, { fieldWeights: { title: 1 } }), "transformer"));
    expect(flat.title).toBeCloseTo(flat.abs, 10);
  });

  it("stems and dedupes query terms", () => {
    const index = buildBm25Index(docs);
    const once = byId(scoreBm25(index, ["graph"]));
    const twice = byId(scoreBm25(index, ["graphs", "graph"]));
    expect(twice.d1).toBeCloseTo(once.d1, 12);
  });

  it("penalizes exclude terms", () => {
    const index = buildBm25Index(docs);
    const plain = byId(scoreBm25(index, "graph neural"));
    const excl = byId(scoreBm25(index, "graph neural", { excludeTerms: ["network"] }));
    expect(excl.d1).toBeCloseTo(plain.d1, 12);
    expect(excl.d3).toBeLessThan(plain.d3);
    expect(scoreBm25(index, "neural", { excludeTerms: "network" }).map((r) => r.id)[0]).toBe("d1");
    // A term both queried and excluded counts only as excluded.
    expect(byId(scoreBm25(index, "network", { excludeTerms: "network" })).d3).toBeLessThan(0);
  });

  it("handles empty queries and empty corpora", () => {
    const index = buildBm25Index(docs);
    expect(scoreBm25(index, "").every((r) => r.score === 0)).toBe(true);
    expect(scoreBm25(index, []).length).toBe(3);
    expect(scoreBm25(buildBm25Index([]), "graph")).toEqual([]);
    const blank = buildBm25Index([{ id: "x", fields: { title: null, abstract: undefined } }]);
    expect(scoreBm25(blank, "graph")).toEqual([{ id: "x", score: 0 }]);
  });
});
