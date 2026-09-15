import { beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
vi.mock("@/lib/llm/call-tool", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/call-tool")>()), callTool }));

const { arxivQueryFor, expandInputSchema, expandQueries, fallbackQueries, normalizeCategory, normalizeExpansion } = await import("../expand");
const { buildArxivQuery, isSaneArxivQuery } = await import("@/lib/landscape/sources/arxiv");

beforeEach(() => {
  callTool.mockReset();
});

describe("arXiv query handling", () => {
  it("keeps sane model queries after light cleanup", () => {
    expect(arxivQueryFor('<q>(abs:"sparse and dense" or ti:SAE) and cat:cs.LG</q>', "x")).toBe(
      '(abs:"sparse and dense" OR ti:SAE) AND cat:cs.LG',
    );
  });
  it("falls back to the shared builder for malformed queries", () => {
    for (const bad of ['abs:"sparse autoencoder', "(abs:sae AND ti:x", "title:sae", "abs:sae AND", ""]) {
      expect(arxivQueryFor(bad, "sparse autoencoders")).toBe(buildArxivQuery({ text: "sparse autoencoders" }));
    }
  });
  it("normalizes categories", () => {
    expect(normalizeCategory("stat.ml")).toBe("stat.ML");
    expect(normalizeCategory("hep-th")).toBe("hep-th");
    expect(normalizeCategory("null")).toBeNull();
  });
});

describe("normalizeExpansion", () => {
  it("coerces stringified arrays, dedupes, drops the topic name, repairs arxiv", () => {
    const raw = expandInputSchema.parse({
      queries: JSON.stringify([
        { text: "Sparse Autoencoders", arxiv: "abs:sae", categories: "cs.LG, cs.CL" },
        { text: "dictionary learning <b>LLM</b> features", arxiv: 'abs:"broken', categories: '["cs.LG"]' },
        { text: "features LLM dictionary learning", arxiv: "abs:x", categories: [] },
        { text: "superposition toy models", arxiv: null, categories: "null" },
      ]),
      categories: '["cs.LG","cs.CL"]',
      mustTerms: "Sparse, Features",
      excludeTerms: "",
    });
    const out = normalizeExpansion(raw, { name: "sparse autoencoders", count: 5 });
    expect(out.queries.map((q) => q.text)).toEqual(["dictionary learning LLM features", "superposition toy models"]);
    expect(out.queries[0].categories).toEqual(["cs.LG"]);
    expect(out.queries[0].arxiv).toBe(buildArxivQuery({ text: "dictionary learning LLM features" }));
    expect(out.queries.every((q) => isSaneArxivQuery(q.arxiv))).toBe(true);
    expect(out.categories).toEqual(["cs.LG", "cs.CL"]);
    expect(out.mustTerms).toEqual(["sparse", "features"]);
    expect(out.excludeTerms).toEqual([]);
  });

  it("caps to count", () => {
    const raw = expandInputSchema.parse({ queries: [1, 2, 3].map((i) => ({ text: `query ${i}`, arxiv: `abs:q${i}`, categories: [] })) });
    expect(normalizeExpansion(raw, { name: "x", count: 2 }).queries).toHaveLength(2);
  });
});

describe("expandQueries", () => {
  it("calls Haiku with the forced tool and normalizes", async () => {
    callTool.mockImplementation(async (opts) => ({
      data: opts.schema.parse({ queries: [{ text: "rlhf reward models", arxiv: "abs:rlhf", categories: ["cs.LG"] }] }),
    }));
    const recorder = { record: vi.fn() };
    const out = await expandQueries({ name: "RLHF", count: 4, windowYears: 4 }, { recorder });
    expect(out.queries).toEqual([{ text: "rlhf reward models", arxiv: "abs:rlhf", categories: ["cs.LG"] }]);
    const opts = callTool.mock.calls[0][0];
    expect(opts.purpose).toBe("expand");
    expect(opts.tool.name).toBe("record_queries");
    expect(opts.recorder).toBe(recorder);
    expect(opts.messages[0].content).toContain("last 4 years");
  });

  it("fallback is just the topic name", () => {
    expect(fallbackQueries("RLHF").queries).toEqual([{ text: "RLHF", arxiv: buildArxivQuery({ text: "RLHF" }), categories: [] }]);
  });
});
