import { describe, expect, it } from "vitest";
import { isStopword } from "@/lib/landscape/rank/stopwords";
import { stem, tokenize } from "@/lib/landscape/rank/tokenize";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Graph/Neural, NETWORK!", { stem: false })).toEqual(["graph", "neural", "network"]);
  });

  it("drops English and academic stopwords", () => {
    expect(tokenize("In this paper we propose a novel approach to retrieval; results show gains")).toEqual([
      "retrieval",
      "gain",
    ]);
    expect(isStopword("propose")).toBe(true);
  });

  it("keeps hyphenated compounds joined and split", () => {
    expect(tokenize("self-supervised learning", { stem: false })).toEqual([
      "selfsupervised",
      "self",
      "supervised",
      "learning",
    ]);
    expect(tokenize("a pre‑trained model", { stem: false })).toEqual(["pretrained", "pre", "trained", "model"]);
  });

  it("drops stopword parts but keeps the compound", () => {
    expect(tokenize("out-of-distribution", { stem: false })).toEqual(["outofdistribution", "distribution"]);
    expect(tokenize("state-of-the-art")).toEqual([]);
  });

  it("is unicode-aware and folds diacritics", () => {
    expect(tokenize("Café naïve Übersetzung 東京", { stem: false })).toEqual(["cafe", "naive", "ubersetzung", "東京"]);
  });

  it("keeps numbers and drops single characters", () => {
    expect(tokenize("GPT-4 x 2024", { stem: false })).toEqual(["gpt4", "gpt", "2024"]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(undefined as unknown as string)).toEqual([]);
  });

  it("can keep stopwords", () => {
    expect(tokenize("the model", { removeStopwords: false, stem: false })).toEqual(["the", "model"]);
  });
});

describe("stem", () => {
  it("conflates simple inflections", () => {
    for (const w of ["model", "models", "modeling"]) expect(stem(w)).toBe("model");
    expect(stem("networks")).toBe("network");
    expect(stem("learning")).toBe("learn");
    expect(stem("embedding")).toBe("embed");
    expect(stem("embedded")).toBe("embed");
    expect(stem("running")).toBe("run");
    expect(stem("studies")).toBe("study");
    expect(stem("classes")).toBe("class");
    expect(stem("modelling")).toBe("model");
    expect(stem("labelled")).toBe("label");
  });

  it("protects -as words and shares a stem for bias forms", () => {
    expect(stem("bias")).toBe("bias");
    expect(stem("biases")).toBe("bias");
    expect(stem("biased")).toBe("bias");
    expect(stem("alias")).toBe("alias");
    expect(stem("aliases")).toBe("alias");
    expect(stem("filling")).toBe("fill");
    expect(stem("spelled")).toBe("spell");
  });

  it("leaves short, non-alphabetic and exceptional words alone", () => {
    expect(stem("gas")).toBe("gas");
    expect(stem("corpus")).toBe("corpus");
    expect(stem("analysis")).toBe("analysis");
    expect(stem("string")).toBe("string");
    expect(stem("speed")).toBe("speed");
    expect(stem("bert4rec")).toBe("bert4rec");
  });
});
