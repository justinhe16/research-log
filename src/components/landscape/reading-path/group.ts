import type { ReadingPathDocument, ReadingPhase } from "@/lib/landscape/llm/synthesize/schemas";
import type { PaperLite } from "@/lib/landscape/types";

/*
 * Pure grouping for the Reading path tab. Kept free of runtime imports from the
 * schemas module so the client bundle does not pull in zod.
 */

/** Must equal READING_PHASES in llm/synthesize/schemas.ts (checked in a test). */
export const READING_PHASE_ORDER: readonly ReadingPhase[] = ["foundations", "core", "frontier"];

export type ReadingStep = { n: number; phase: ReadingPhase; paper: PaperLite; reason: string };
export type ReadingGroup = { phase: ReadingPhase; steps: ReadingStep[] };

/**
 * Resolve steps to papers and group them by phase:
 *  - steps whose paper is not in the snapshot are dropped;
 *  - a paper listed twice keeps its first step;
 *  - groups follow READING_PHASE_ORDER, steps keep the model's order within a phase;
 *  - numbering runs 1..n across all groups in display order;
 *  - empty phases are omitted.
 */
export function groupReadingPath(doc: ReadingPathDocument | null, papers: PaperLite[]): ReadingGroup[] {
  if (!doc) return [];
  const byId = new Map(papers.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const resolved: { phase: ReadingPhase; paper: PaperLite; reason: string }[] = [];
  for (const step of doc.steps) {
    const paper = byId.get(step.paperId);
    if (!paper || seen.has(step.paperId)) continue;
    seen.add(step.paperId);
    resolved.push({ phase: step.phase, paper, reason: step.reason });
  }
  let n = 0;
  return READING_PHASE_ORDER.map((phase) => ({
    phase,
    steps: resolved.filter((s) => s.phase === phase).map((s) => ({ ...s, n: ++n })),
  })).filter((g) => g.steps.length > 0);
}
