import { beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
vi.mock("@/lib/llm/call-tool", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/call-tool")>()), callTool }));

const { LlmOutputError } = await import("@/lib/llm/call-tool");
const { runSynthesis } = await import("../synthesize");
const { mapReadingPath } = await import("../synthesize/reading-path");
const { mapNarrative } = await import("../synthesize/narrative");
const { readingPathInputSchema, narrativeInputSchema } = await import("../synthesize/schemas");
const { createRefResolver } = await import("../refs");

const dossier = { text: "DOSSIER", refMap: { P1: "a", P2: "b", P3: "c", P4: "d" }, clusterIdxs: [0, 1] };

const INPUTS: Record<string, unknown> = {
  record_clusters: {
    topicSummary: "<p>Summary</p>",
    clusters: [
      { idx: 0, name: "Probes", summary: "s", keyIdeas: '["x","y"]', representativeRefs: "P1, P2" },
      { idx: 7, name: "Invented", summary: "s", keyIdeas: [], representativeRefs: [] },
      { idx: "1", name: "SAEs", summary: "s", keyIdeas: "- a\n- b", representativeRefs: ["[P3]"] },
    ],
  },
  record_tensions: { tensions: [{ title: "T", description: "d", positions: [{ stance: "s", refs: ["P1"] }], clusterIdxs: "0, 9" }] },
  record_gaps: { gaps: [{ title: "G", description: "d", evidence: "e", evidenceRefs: ["P2"], directions: "do x" }] },
  record_narrative: {
    eras: [
      { label: "Now", startYear: "2024", endYear: "null", summary: "A, B now", keyRefs: ["P3"] },
      { label: "Then", startYear: 2020, endYear: 2023, summary: "X, Y, Z were the basis", keyRefs: ["P1"] },
    ],
    gameChangers: [{ ref: "P1", why: "w", evidence: "1000 cites" }, { ref: "p1", why: "dup", evidence: "e" }],
    frontier: '{"summary":"f","refs":["P4"]}',
    outlook: "o",
    whatChanged: "null",
  },
  record_reading_path: {
    steps: [
      { phase: "frontier", ref: "P4", reason: "r" },
      { phase: "Foundational", ref: "P1", reason: "r" },
      { phase: "core methods", ref: "P2", reason: "r" },
      { phase: "core", ref: "P1", reason: "dup" },
    ],
  },
};
INPUTS.record_tensions_and_gaps = { ...(INPUTS.record_tensions as object), ...(INPUTS.record_gaps as object) };
INPUTS.record_narrative_and_reading_path = { ...(INPUTS.record_narrative as object), readingPath: (INPUTS.record_reading_path as { steps: unknown }).steps };

type Opts = { tool: { name: string }; schema: { parse: (v: unknown) => unknown }; system: unknown; messages: unknown; purpose: string };

function respond(overrides: Record<string, (o: Opts) => unknown> = {}) {
  return async (o: Opts) => {
    const custom = overrides[o.tool.name];
    if (custom) return custom(o);
    return { data: o.schema.parse(INPUTS[o.tool.name]) };
  };
}

beforeEach(() => {
  callTool.mockReset();
});

describe("runSynthesis (5 calls)", () => {
  it("runs clusters first, then the rest; maps refs and sanitizes", async () => {
    const order: string[] = [];
    let clustersDone = false;
    callTool.mockImplementation(async (o: Opts) => {
      order.push(o.tool.name);
      if (o.tool.name !== "record_clusters") expect(clustersDone).toBe(true);
      const out = await respond()(o);
      if (o.tool.name === "record_clusters") clustersDone = true;
      return out;
    });
    const recorder = { record: vi.fn() };
    const res = await runSynthesis({ dossier, depthSynthCalls: 5, recorder });

    expect(order[0]).toBe("record_clusters");
    expect(order.slice(1).sort()).toEqual(["record_gaps", "record_narrative", "record_reading_path", "record_tensions"]);
    expect(res.errors).toEqual({});
    expect(res.topicSummary).toBe("Summary");
    expect(res.clusterLabels).toEqual({ 0: "Probes", 1: "SAEs" });
    expect(res.documents.clusters!.clusters[0]).toMatchObject({ keyIdeas: ["x", "y"], representativePaperIds: ["a", "b"] });
    expect(res.documents.tensions!.tensions[0].clusterIdxs).toEqual([0]);
    expect(res.documents.gaps!.gaps[0]).toMatchObject({ evidencePaperIds: ["b"], directions: ["do x"] });
    const n = res.documents.narrative!;
    expect(n.eras.map((e) => e.label)).toEqual(["Then", "Now"]);
    expect(n.eras[1].endYear).toBeNull();
    expect(n.gameChangers).toEqual([{ paperId: "a", why: "w", evidence: "1000 cites" }]);
    expect(n.frontier.paperIds).toEqual(["d"]);
    expect(n.whatChanged).toBeNull();
    expect(res.documents.reading_path!.steps.map((s) => [s.phase, s.paperId])).toEqual([
      ["foundations", "a"],
      ["core", "b"],
      ["frontier", "d"],
    ]);

    // Prompt shape: dossier cached in system; model/recorder passed through.
    const first = callTool.mock.calls[0][0];
    expect(first.model).toBe("claude-sonnet-5");
    expect(first.recorder).toBe(recorder);
    expect(first.system[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(first.system[1].text).toContain("DOSSIER");
  });

  it("isolates failures per kind (allSettled)", async () => {
    callTool.mockImplementation(
      respond({
        record_gaps: () => {
          throw new Error("overloaded");
        },
      }),
    );
    const res = await runSynthesis({ dossier, depthSynthCalls: 5 });
    expect(res.errors).toEqual({ gaps: "overloaded" });
    expect(Object.keys(res.documents).sort()).toEqual(["clusters", "narrative", "reading_path", "tensions"]);
  });

  it("continues when S1 fails", async () => {
    callTool.mockImplementation(respond({ record_clusters: () => Promise.reject(new Error("boom")) }));
    const res = await runSynthesis({ dossier, depthSynthCalls: 5 });
    expect(res.errors.clusters).toBe("boom");
    expect(res.topicSummary).toBeNull();
    expect(res.documents.tensions).toBeDefined();
  });

  it("retries a call once when most refs are invalid", async () => {
    let tensionCalls = 0;
    callTool.mockImplementation(
      respond({
        record_tensions: (o) => {
          tensionCalls++;
          const refs = tensionCalls === 1 ? ["P97", "P98", "P1"] : ["P1"];
          return { data: o.schema.parse({ tensions: [{ title: "T", description: "d", positions: [{ stance: "s", refs }] }] }) };
        },
      }),
    );
    const res = await runSynthesis({ dossier, depthSynthCalls: 5, kinds: ["tensions"] });
    expect(tensionCalls).toBe(2);
    expect(res.documents.tensions!.tensions[0].positions[0].paperIds).toEqual(["a"]);
    expect(callTool).toHaveBeenCalledTimes(2); // kinds filter: no other calls
  });

  it("gives up after the retries and reports the ref error", async () => {
    callTool.mockImplementation(
      respond({
        record_gaps: (o) => ({ data: o.schema.parse({ gaps: [{ title: "G", description: "d", evidence: "e", evidenceRefs: ["P50", "P51"], directions: [] }] }) }),
      }),
    );
    const res = await runSynthesis({ dossier, depthSynthCalls: 5, kinds: ["gaps"] });
    expect(res.errors.gaps).toMatch(/2\/2 refs/);
    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it("without clusters, runs the first target alone before the rest in parallel", async () => {
    const events: string[] = [];
    callTool.mockImplementation(async (o: Opts) => {
      events.push(`start:${o.tool.name}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end:${o.tool.name}`);
      return respond()(o);
    });
    const res = await runSynthesis({ dossier, depthSynthCalls: 5, kinds: ["gaps", "narrative", "reading_path"] });
    expect(events.slice(0, 2)).toEqual(["start:record_gaps", "end:record_gaps"]);
    // The remaining two start before either finishes.
    expect(events.slice(2, 4).every((e) => e.startsWith("start:"))).toBe(true);
    expect(Object.keys(res.documents).sort()).toEqual(["gaps", "narrative", "reading_path"]);
  });

  it("passes the diff into the narrative prompt", async () => {
    callTool.mockImplementation(respond());
    await runSynthesis({
      dossier,
      depthSynthCalls: 5,
      kinds: ["narrative"],
      diff: { baseSearchId: "s0", since: "2026-01-01T00:00:00Z", newPaperIds: ["d", "zz"], droppedPaperIds: [], rising: [], clusterChanges: [] },
    });
    const text = callTool.mock.calls[0][0].messages[0].content[0].text;
    expect(text).toContain("New papers (2): P4 (+1 not in the current selection)");
  });
});

describe("prompt caching layout", () => {
  it("sends an identical tool list on every call (full and Quick) and caches the system dossier", async () => {
    callTool.mockImplementation(respond());
    await runSynthesis({ dossier, depthSynthCalls: 5 });
    await runSynthesis({ dossier, depthSynthCalls: 3 });
    const calls = callTool.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(8);
    const names = (c: { tools: { name: string }[] }) => c.tools.map((t) => t.name);
    expect(names(calls[0])).toEqual([
      "record_clusters",
      "record_tensions",
      "record_gaps",
      "record_tensions_and_gaps",
      "record_narrative",
      "record_reading_path",
      "record_narrative_and_reading_path",
    ]);
    for (const c of calls) {
      expect(JSON.stringify(c.tools)).toBe(JSON.stringify(calls[0].tools));
      expect(c.tools.map((t: { name: string }) => t.name)).toContain(c.tool.name);
      expect(c.system).toEqual(calls[0].system);
      expect(c.system.at(-1)).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
      expect(c.system.at(-1).text).toContain("DOSSIER");
    }
  });
});

describe("runSynthesis (Quick, 3 calls)", () => {
  it("uses merged tools and stores all five kinds", async () => {
    callTool.mockImplementation(respond());
    const res = await runSynthesis({ dossier, depthSynthCalls: 3 });
    expect(callTool.mock.calls.map((c) => c[0].tool.name)).toEqual([
      "record_clusters",
      "record_tensions_and_gaps",
      "record_narrative_and_reading_path",
    ]);
    expect(callTool.mock.calls.map((c) => c[0].purpose)).toEqual(["synth_clusters", "synth_tensions_gaps", "synth_narrative_path"]);
    expect(Object.keys(res.documents).sort()).toEqual(["clusters", "gaps", "narrative", "reading_path", "tensions"]);
    expect(res.errors).toEqual({});
  });

  it("retries a merged call when one document's refs are mostly invalid, even if the whole is fine", async () => {
    let n = 0;
    callTool.mockImplementation(
      respond({
        record_tensions_and_gaps: (o) => {
          n++;
          const gapRefs = n === 1 ? ["P90", "P91"] : ["P2"];
          const tensions = [1, 2, 3].map((i) => ({ title: `T${i}`, description: "d", positions: [{ stance: "s", refs: ["P1", "P2", "P3"] }] }));
          return { data: o.schema.parse({ tensions, gaps: [{ title: "G", description: "d", evidence: "e", evidenceRefs: gapRefs, directions: [] }] }) };
        },
      }),
    );
    // 9 valid tension refs + 2 invalid gap refs = 18% overall, but gaps alone are 100% invalid.
    const res = await runSynthesis({ dossier, depthSynthCalls: 3, kinds: ["tensions", "gaps"] });
    expect(n).toBe(2);
    expect(res.errors).toEqual({});
    expect(res.documents.gaps!.gaps[0].evidencePaperIds).toEqual(["b"]);
  });

  it("a failed merged call fails both of its kinds", async () => {
    callTool.mockImplementation(respond({ record_narrative_and_reading_path: () => Promise.reject(new LlmOutputError("truncated")) }));
    const res = await runSynthesis({ dossier, depthSynthCalls: 3 });
    expect(res.errors).toEqual({ narrative: "truncated", reading_path: "truncated" });
    expect(res.documents.tensions).toBeDefined();
  });
});

describe("pure mappers", () => {
  it("reading path throws when no step resolves", () => {
    const data = readingPathInputSchema.parse({ steps: [{ phase: "core", ref: "P99", reason: "r" }] });
    expect(() => mapReadingPath(data.steps, createRefResolver(dossier.refMap))).toThrow(LlmOutputError);
  });

  it("narrative keeps whatChanged only with a diff", () => {
    const data = narrativeInputSchema.parse({ ...(INPUTS.record_narrative as object), whatChanged: "<i>More SAEs</i>" });
    expect(mapNarrative(data, createRefResolver(dossier.refMap), true).whatChanged).toBe("More SAEs");
    expect(mapNarrative(data, createRefResolver(dossier.refMap), false).whatChanged).toBeNull();
  });
});
