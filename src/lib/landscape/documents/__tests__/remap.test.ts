import { describe, expect, it } from "vitest";
import { remapDocumentPaperIds } from "@/lib/landscape/documents/remap";
import { DOCUMENT_SCHEMAS } from "@/lib/landscape/llm/synthesize/schemas";

const map = (id: string) => ({ a: "A", b: "A", c: "C" })[id] ?? null;

describe("remapDocumentPaperIds", () => {
  it("clusters: representativePaperIds", () => {
    const out = remapDocumentPaperIds("clusters", {
      topicSummary: "t",
      clusters: [{ idx: 0, name: "n", summary: "s", keyIdeas: [], representativePaperIds: ["a", "b", "zz", "c"] }],
    }, map);
    expect(DOCUMENT_SCHEMAS.clusters.parse(out).clusters[0].representativePaperIds).toEqual(["A", "C"]);
  });

  it("tensions: positions[].paperIds", () => {
    const out = remapDocumentPaperIds("tensions", {
      tensions: [{ title: "x", summary: "y", positions: [{ stance: "s", paperIds: ["c", "zz"] }], clusterIdxs: [] }],
    }, map) as { tensions: { positions: { paperIds: string[] }[] }[] };
    expect(out.tensions[0].positions[0].paperIds).toEqual(["C"]);
  });

  it("gaps: evidencePaperIds", () => {
    const out = remapDocumentPaperIds("gaps", { gaps: [{ evidencePaperIds: ["b", "a"] }] }, map) as {
      gaps: { evidencePaperIds: string[] }[];
    };
    expect(out.gaps[0].evidencePaperIds).toEqual(["A"]);
  });

  it("narrative: eras, gameChangers, frontier", () => {
    const out = remapDocumentPaperIds("narrative", {
      eras: [{ label: "e", startYear: 2020, endYear: null, summary: "s", keyPaperIds: ["a", "zz"] }],
      gameChangers: [
        { paperId: "a", why: "1", evidence: "1" },
        { paperId: "b", why: "2", evidence: "2" },
        { paperId: "zz", why: "3", evidence: "3" },
      ],
      frontier: { summary: "f", paperIds: ["c", "c"] },
      outlook: "o",
      whatChanged: null,
    }, map);
    const doc = DOCUMENT_SCHEMAS.narrative.parse(out);
    expect(doc.eras[0].keyPaperIds).toEqual(["A"]);
    expect(doc.gameChangers).toEqual([{ paperId: "A", why: "1", evidence: "1" }]);
    expect(doc.frontier.paperIds).toEqual(["C"]);
  });

  it("reading_path: steps[].paperId", () => {
    const out = remapDocumentPaperIds("reading_path", {
      steps: [{ phase: "core", paperId: "zz", reason: "r" }, { phase: "core", paperId: "c", reason: "r" }],
    }, map);
    expect(DOCUMENT_SCHEMAS.reading_path.parse(out).steps.map((s) => s.paperId)).toEqual(["C"]);
  });

  it("diff: newPaperIds, droppedPaperIds, rising", () => {
    const out = remapDocumentPaperIds("diff", {
      baseSearchId: "s0",
      since: null,
      newPaperIds: ["a"],
      droppedPaperIds: ["zz", "c"],
      rising: [{ paperId: "b", citationsBefore: 1, citationsAfter: 3, delta: 2 }],
      clusterChanges: [],
    }, map);
    const doc = DOCUMENT_SCHEMAS.diff.parse(out);
    expect([doc.newPaperIds, doc.droppedPaperIds, doc.rising[0].paperId]).toEqual([["A"], ["C"], "A"]);
    expect(doc.baseSearchId).toBe("s0");
  });

  it("leaves non-object data and unknown kinds alone", () => {
    expect(remapDocumentPaperIds("clusters", null, map)).toBeNull();
    const data = { anything: ["a"] };
    expect(remapDocumentPaperIds("mystery", data, map)).toBe(data);
  });
});
