import { describe, expect, it } from "vitest";
import {
  clustersInputSchema,
  DOCUMENT_SCHEMAS,
  narrativePathInputSchema,
  normalizeRef,
  tensionsGapsInputSchema,
} from "@/lib/landscape/llm/synthesize/schemas";
import { landscapeSnapshotFixture } from "@/components/landscape/__fixtures__/snapshot";

describe("normalizeRef", () => {
  it.each([
    ["P12", "P12"],
    ["p12", "P12"],
    ["[P12]", "P12"],
    ["P 12", "P12"],
    ["ref P#3", "P3"],
    ["P007", "P7"],
    ["Smith 2021", "Smith 2021"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRef(input)).toBe(expected);
  });
});

describe("LLM input schemas coerce common model deviations", () => {
  it("accepts stringified arrays, lowercase refs and string idx", () => {
    const parsed = clustersInputSchema.parse({
      topicSummary: "Summary.",
      clusters: JSON.stringify([
        { idx: "0", name: "A", summary: "S", keyIdeas: "- one\n- two", representativeRefs: "p1, [P2]" },
      ]),
    });
    expect(parsed.clusters[0]).toEqual({
      idx: 0,
      name: "A",
      summary: "S",
      keyIdeas: ["one", "two"],
      representativeRefs: ["P1", "P2"],
    });
  });

  it("parses the Quick merged forms", () => {
    const tg = tensionsGapsInputSchema.parse({
      tensions: [{ title: "T", description: "D", positions: [{ stance: "x", refs: ["P1"] }] }],
      gaps: [{ title: "G", description: "D", evidence: "E", evidenceRefs: ["P2"], directions: ["do"] }],
    });
    expect(tg.tensions[0].clusterIdxs).toEqual([]);

    const np = narrativePathInputSchema.parse({
      eras: [{ label: "E", startYear: "2019", endYear: "null", summary: "S", keyRefs: ["P1"] }],
      gameChangers: [{ ref: "p3", why: "w", evidence: "e" }],
      frontier: JSON.stringify({ summary: "f", refs: ["P4"] }),
      outlook: "o",
      whatChanged: "null",
      readingPath: [{ phase: "Core methods", ref: "P1", reason: "r" }],
    });
    expect(np.eras[0]).toMatchObject({ startYear: 2019, endYear: null });
    expect(np.gameChangers[0].ref).toBe("P3");
    expect(np.whatChanged).toBeNull();
    expect(np.readingPath[0].phase).toBe("core");
  });
});

describe("snapshot fixture", () => {
  it("validates against the stored document schemas", () => {
    const { documents } = landscapeSnapshotFixture;
    expect(() => DOCUMENT_SCHEMAS.clusters.parse(documents.clusters)).not.toThrow();
    expect(() => DOCUMENT_SCHEMAS.tensions.parse(documents.tensions)).not.toThrow();
    expect(() => DOCUMENT_SCHEMAS.gaps.parse(documents.gaps)).not.toThrow();
    expect(() => DOCUMENT_SCHEMAS.narrative.parse(documents.narrative)).not.toThrow();
    expect(() => DOCUMENT_SCHEMAS.reading_path.parse(documents.readingPath)).not.toThrow();
    expect(() => DOCUMENT_SCHEMAS.diff.parse(documents.diff)).not.toThrow();
  });

  it("only references papers that are in the snapshot", () => {
    const ids = new Set(landscapeSnapshotFixture.papers.map((p) => p.id));
    const json = JSON.stringify(landscapeSnapshotFixture.documents);
    const referenced = [...json.matchAll(/"(paper-\d+)"/g)].map((m) => m[1]);
    const { diff } = landscapeSnapshotFixture.documents;
    const dropped = new Set(diff?.droppedPaperIds ?? []);
    for (const id of referenced) if (!dropped.has(id)) expect(ids.has(id)).toBe(true);
    for (const e of landscapeSnapshotFixture.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    }
    for (const c of landscapeSnapshotFixture.clusters) {
      expect(c.size).toBe(c.paperIds.length);
    }
  });
});

describe("real Sonnet 5 malformations (smoke run regressions)", () => {
  const narrative = {
    eras: [{ label: "SAE proof of concept", startYear: 2023, endYear: null, summary: "s", keyRefs: ["P10"] }],
    gameChangers: [{ ref: "P10", why: "w", evidence: "1560 citations" }],
    outlook: "o",
    whatChanged: null,
    readingPath: [{ ref: "P10", phase: "foundations", reason: "r" }],
  };

  it("accepts frontier sent as prose and lifts its inline refs", () => {
    const parsed = narrativePathInputSchema.parse({
      ...narrative,
      frontier: "Fixes for non-identifiability (P12's iSAE, P5's Ordered SAEs) and matching pursuit (P4, P12).",
    });
    expect(parsed.frontier.refs).toEqual(["P12", "P5", "P4"]);
    expect(parsed.frontier.summary).toMatch(/^Fixes for/);
  });

  it("still accepts frontier as an object or a JSON string", () => {
    expect(narrativePathInputSchema.parse({ ...narrative, frontier: { summary: "x", refs: ["P1"] } }).frontier.refs).toEqual(["P1"]);
    expect(narrativePathInputSchema.parse({ ...narrative, frontier: '{"summary":"x","refs":["P2"]}' }).frontier.refs).toEqual(["P2"]);
  });

  it("salvages the whole input JSON-encoded into the first property", async () => {
    const { parseToolInput } = await import("@/lib/llm/call-tool");
    const whole = { topicSummary: "t", clusters: [{ idx: 0, name: "n", summary: "s", keyIdeas: ["k"], representativeRefs: ["P1"] }] };
    const raw = { clusters: JSON.stringify(whole) };
    expect(clustersInputSchema.safeParse(raw).success).toBe(false);
    const res = parseToolInput(clustersInputSchema, raw);
    expect(res.success).toBe(true);
    expect(res.data?.clusters[0].name).toBe("n");
    // A genuinely broken input still fails with the original issues.
    expect(parseToolInput(clustersInputSchema, { topicSummary: "t</topicSummary>\n<clusters>..." }).success).toBe(false);
  });
});
