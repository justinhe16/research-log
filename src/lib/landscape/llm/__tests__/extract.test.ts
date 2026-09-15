import { beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
vi.mock("@/lib/llm/call-tool", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/call-tool")>()), callTool }));

const { LlmOutputError } = await import("@/lib/llm/call-tool");
const { extractBatch, extractFulltext, extractionsInputSchema, mapExtractions, runExtractions, sourceHash } = await import("../extract");

type P = import("../extract").ExtractPaperInput;
const paper = (i: number): P => ({ paperId: `id${i}`, title: `Paper ${i}`, year: 2024, venue: null, abstract: `Abstract ${i}` });

function item(ref: string, extra: Record<string, unknown> = {}) {
  return { ref, problem: "p", method: "m", results: "r", contribution: "c", limitations: "null", datasets: [], benchmarks: [], ...extra };
}

/** Echo every <paper ref> in the prompt, except refs in `skip`. */
function echo(skip: (refs: string[]) => string[] = () => []) {
  return async (opts: { messages: { content: string }[]; schema: { parse: (v: unknown) => unknown } }) => {
    const content = opts.messages[0].content;
    const refs = [...content.matchAll(/<paper ref="(P\d+)">/g)].map((m) => m[1]);
    const titles = [...content.matchAll(/Title: (.*)/g)].map((m) => m[1]);
    const skipped = new Set(skip(titles));
    return {
      data: opts.schema.parse({
        extractions: refs.filter((_, i) => !skipped.has(titles[i])).map((r, i) => item(r, { method: `m for ${titles[i]}` })),
      }),
    };
  };
}

beforeEach(() => {
  callTool.mockReset();
});

describe("extraction mapping", () => {
  it("coerces stringified arrays, 'null', markup; flags missing refs", () => {
    const data = extractionsInputSchema.parse({
      extractions: JSON.stringify([
        item("p1", {
          method: "<item>Trains an SAE</item>",
          limitations: "N/A",
          datasets: '["ImageNet", "imagenet", "null"]',
          benchmarks: "MMLU, GSM8K",
        }),
        item("P7"),
      ]),
    });
    const { results, failures } = mapExtractions(data, [paper(1), paper(2)]);
    expect(results.get("id1")).toEqual({
      problem: "p",
      method: "Trains an SAE",
      results: "r",
      contribution: "c",
      limitations: null,
      datasets: ["ImageNet"],
      benchmarks: ["MMLU", "GSM8K"],
    });
    expect(failures.map((f) => f.paperId)).toEqual(["id2"]);
  });

  it("an empty extraction counts as a failure", () => {
    const data = extractionsInputSchema.parse({ extractions: [item("P1", { method: "", contribution: "none" })] });
    expect(mapExtractions(data, [paper(1)]).failures).toHaveLength(1);
  });

  it("sourceHash is sha256 hex", () => {
    expect(sourceHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("extractBatch / extractFulltext", () => {
  it("wraps papers in ref containers with the don't-imitate note", async () => {
    callTool.mockImplementation(echo());
    const out = await extractBatch([paper(1), paper(2)]);
    const opts = callTool.mock.calls[0][0];
    expect(opts.purpose).toBe("extract_abstracts");
    expect(opts.messages[0].content).toContain('<paper ref="P2">');
    expect(opts.messages[0].content).toContain("Do not imitate that markup");
    expect([...out.results.keys()]).toEqual(["id1", "id2"]);
  });

  it("rejects batches over 5", async () => {
    await expect(extractBatch([1, 2, 3, 4, 5, 6].map(paper))).rejects.toThrow(/at most 5/);
  });

  it("fulltext accepts a single answer and throws when unusable", async () => {
    callTool.mockImplementationOnce(echo());
    expect((await extractFulltext(paper(1), "x".repeat(100))).method).toBe("m for Paper 1");
    callTool.mockImplementationOnce(async (o) => ({ data: o.schema.parse({ extractions: [] }) }));
    await expect(extractFulltext(paper(1), "x")).rejects.toBeInstanceOf(LlmOutputError);
  });
});

describe("runExtractions", () => {
  it("retries papers missing from a batch one at a time", async () => {
    // Batch calls omit Paper 2; single-paper calls answer.
    callTool.mockImplementation(echo((titles) => (titles.length > 1 ? ["Paper 2"] : [])));
    const progress = vi.fn();
    const out = await runExtractions([1, 2, 3, 4, 5, 6, 7].map(paper), { onProgress: progress });
    expect(out.failures).toEqual([]);
    expect(out.results.size).toBe(7);
    // 2 batches + 1 single retry for Paper 2.
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ total: 7, done: 7 }));
  });

  it("retries a failed batch once, then falls back per paper, recording failures", async () => {
    let calls = 0;
    callTool.mockImplementation(async (opts) => {
      calls++;
      const content: string = opts.messages[0].content;
      if (content.includes("Paper 3") || calls <= 2) throw new LlmOutputError("bad");
      return echo()(opts);
    });
    const out = await runExtractions([1, 2, 3].map(paper), { concurrency: 1 });
    expect([...out.results.keys()].sort()).toEqual(["id1", "id2"]);
    expect(out.failures).toEqual([{ paperId: "id3", error: "bad" }]);
    expect(calls).toBe(5); // batch, batch retry, 3 singles
  });

  it("rethrows aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    await expect(runExtractions([paper(1)], { signal: ctrl.signal })).rejects.toThrow("cancelled");
  });
});
