import { describe, expect, it } from "vitest";
import { clusterKeyTerms, placeholderLabel, tokenizeForTerms } from "../terms";

describe("tokenizeForTerms", () => {
  it("lowercases, drops stopwords and numbers, keeps hyphenated words", () => {
    expect(tokenizeForTerms("The Self-Attention model in 2023 is used for Transformers")).toEqual([
      "self-attention",
      "transformers",
    ]);
  });
});

describe("clusterKeyTerms", () => {
  const docs = [
    { clusterIdx: 0, text: "Graph neural networks for molecule property prediction with learning" },
    { clusterIdx: 0, text: "Message passing graph neural networks and learning on molecules" },
    { clusterIdx: 0, text: "Scalable graph neural networks learning" },
    { clusterIdx: 1, text: "Reinforcement learning reward shaping for robot control" },
    { clusterIdx: 1, text: "Offline reinforcement learning with reward models for robot manipulation" },
    { clusterIdx: 1, text: "Reward hacking in reinforcement learning" },
  ];

  it("ranks distinctive terms above terms shared across clusters", () => {
    const terms = clusterKeyTerms(docs, { topN: 4 });
    expect(terms).toHaveLength(2);
    expect(terms[0][0]).toBe("graph neural");
    expect(terms[0].slice(0, 2)).toEqual(["graph neural", "neural networks"]);
    // Bigrams never bridge a removed stopword ("learning on molecules").
    expect(terms.flat()).not.toContain("learning molecules");
    expect(terms[1]).toContain("reinforcement learning");
    expect(terms[1]).toContain("reward");
    expect(terms[1]).not.toContain("graph neural");
    for (const t of terms) expect(t.length).toBeLessThanOrEqual(4);
  });

  it("returns empty arrays for clusters without docs, and accepts a custom tokenizer", () => {
    const terms = clusterKeyTerms([{ clusterIdx: 2, text: "alpha beta" }], { tokenize: (s) => s.split(" ") });
    expect(terms[0]).toEqual([]);
    expect(terms[1]).toEqual([]);
    expect(terms[2]).toContain("alpha beta");
    expect(clusterKeyTerms([])).toEqual([]);
  });
});

describe("placeholderLabel", () => {
  it("joins two non-overlapping terms", () => {
    expect(placeholderLabel(["graph neural", "graph", "message passing"])).toBe("Graph neural / message passing");
    expect(placeholderLabel([])).toBe("Untitled cluster");
  });
});
