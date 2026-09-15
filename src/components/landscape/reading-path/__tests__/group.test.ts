import { describe, expect, it } from "vitest";

import { landscapeSnapshotFixture as snap } from "@/components/landscape/__fixtures__/snapshot";
import { READING_PHASES, type ReadingPathDocument } from "@/lib/landscape/llm/synthesize/schemas";
import { groupReadingPath, READING_PHASE_ORDER } from "../group";

const step = (phase: ReadingPathDocument["steps"][number]["phase"], paperId: string, reason = `why ${paperId}`) => ({
  phase,
  paperId,
  reason,
});

describe("groupReadingPath", () => {
  it("keeps the local phase order in lockstep with the schema", () => {
    expect([...READING_PHASE_ORDER]).toEqual([...READING_PHASES]);
  });

  it("returns nothing for a missing document", () => {
    expect(groupReadingPath(null, snap.papers)).toEqual([]);
  });

  it("orders groups by phase, keeps the model's order within a phase and numbers across groups", () => {
    const doc = {
      steps: [step("frontier", "paper-19"), step("core", "paper-10"), step("foundations", "paper-01"), step("core", "paper-08")],
    };
    const groups = groupReadingPath(doc, snap.papers);
    expect(groups.map((g) => g.phase)).toEqual(["foundations", "core", "frontier"]);
    expect(groups.flatMap((g) => g.steps.map((s) => [s.n, s.paper.id]))).toEqual([
      [1, "paper-01"],
      [2, "paper-10"],
      [3, "paper-08"],
      [4, "paper-19"],
    ]);
  });

  it("drops unknown papers and duplicates, and omits empty phases", () => {
    const doc = {
      steps: [
        step("foundations", "paper-01", "first"),
        step("foundations", "paper-missing"),
        step("frontier", "paper-01", "duplicate"),
        step("frontier", "paper-21"),
      ],
    };
    const groups = groupReadingPath(doc, snap.papers);
    expect(groups.map((g) => g.phase)).toEqual(["foundations", "frontier"]);
    expect(groups[0].steps).toHaveLength(1);
    expect(groups[0].steps[0].reason).toBe("first");
    expect(groups[1].steps.map((s) => [s.n, s.paper.id])).toEqual([[2, "paper-21"]]);
  });

  it("numbers the fixture path 1..n", () => {
    const steps = groupReadingPath(snap.documents.readingPath, snap.papers).flatMap((g) => g.steps);
    expect(steps.map((s) => s.n)).toEqual(steps.map((_, i) => i + 1));
    expect(steps).toHaveLength(snap.documents.readingPath!.steps.length);
  });
});
