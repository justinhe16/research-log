import { describe, expect, it } from "vitest";
import {
  findArxivId,
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizeTitle,
} from "@/lib/landscape/ids";

describe("normalizeArxivId", () => {
  it.each([
    ["2401.01234", "2401.01234"],
    ["2401.01234v3", "2401.01234"],
    ["arXiv:2401.01234v2", "2401.01234"],
    ["ARXIV: 1706.03762", "1706.03762"],
    ["https://arxiv.org/abs/1706.03762", "1706.03762"],
    ["https://arxiv.org/abs/1706.03762v7", "1706.03762"],
    ["http://arxiv.org/pdf/1706.03762v7.pdf", "1706.03762"],
    ["https://arxiv.org/pdf/1706.03762", "1706.03762"],
    ["https://www.arxiv.org/abs/2401.01234?context=cs", "2401.01234"],
    ["https://export.arxiv.org/abs/0704.0001", "0704.0001"],
    ["https://arxiv.org/html/2401.01234v1/", "2401.01234"],
    ["hep-th/9901001", "hep-th/9901001"],
    ["hep-th/9901001v2", "hep-th/9901001"],
    ["arXiv:math.GT/0309136", "math.GT/0309136"],
    ["https://arxiv.org/abs/cond-mat/0102536v1", "cond-mat/0102536"],
    ["10.48550/arXiv.2401.01234", "2401.01234"],
    ["https://doi.org/10.48550/ARXIV.1706.03762", "1706.03762"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeArxivId(input)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "not an id", "24.01234", "https://example.com/abs/1706.03762", "10.1145/3292500"])(
    "rejects %s",
    (input) => {
      expect(normalizeArxivId(input as string | null)).toBeNull();
    },
  );
});

describe("findArxivId", () => {
  it("finds ids inside arXiv URLs and prefixed strings", () => {
    expect(findArxivId("see https://arxiv.org/abs/2401.01234v2 for details")).toBe("2401.01234");
    expect(findArxivId("https://arxiv.org/pdf/2401.01234v1.pdf")).toBe("2401.01234");
  });

  it("does not treat an arbitrary numeric path as an arXiv id", () => {
    expect(findArxivId("https://example.com/posts/2401.01234")).toBeNull();
  });
});

describe("normalizeDoi", () => {
  it.each([
    ["10.1145/3292500.3330701", "10.1145/3292500.3330701"],
    ["doi:10.1145/ABC.def", "10.1145/abc.def"],
    ["https://doi.org/10.1038/nature14539", "10.1038/nature14539"],
    ["http://dx.doi.org/10.1038/Nature14539.", "10.1038/nature14539"],
    ["https://doi.org/10.1000/a%2Fb", "10.1000/a/b"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected);
  });

  it("rejects non-DOIs", () => {
    expect(normalizeDoi("")).toBeNull();
    expect(normalizeDoi("hello")).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("collapses case, punctuation and diacritics", () => {
    expect(normalizeTitle("BERT: Pre-training of Deep Bidirectional Transformers")).toBe(
      normalizeTitle("Bert pre training of deep bidirectional  transformers."),
    );
    expect(normalizeTitle("Café  Über—Naïve")).toBe("cafe uber naive");
  });

  it("strips markup and inline math delimiters", () => {
    expect(normalizeTitle("Scaling <i>laws</i> for $\\ell_1$ sparsity")).toBe("scaling laws for ell1 sparsity");
  });

  it("returns empty string for missing input", () => {
    expect(normalizeTitle(undefined)).toBe("");
  });
});

describe("normalizeOpenAlexId", () => {
  it("accepts URLs and bare ids", () => {
    expect(normalizeOpenAlexId("https://openalex.org/W2741809807")).toBe("W2741809807");
    expect(normalizeOpenAlexId("w123")).toBe("W123");
    expect(normalizeOpenAlexId("A123")).toBeNull();
  });
});
