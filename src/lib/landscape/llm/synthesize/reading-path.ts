import { LlmOutputError } from "@/lib/llm/call-tool";
import type { RefResolver } from "../refs";
import {
  READING_PATH_TOOL,
  READING_PHASES,
  readingPathInputSchema,
  type ReadingPathDocument,
  type ReadingPathInput,
} from "./schemas";
import { clean, runSynthesisCall, type SynthesisCallOptions } from "./shared";

const MAX_STEPS = 15;

export const READING_PATH_GUIDE = `Reading path (8-15 steps) for a strong ML researcher new to this field:
- Order: foundations (what everything else assumes), then core methods (the main approaches, one or two per cluster), then frontier (recent work worth knowing now). Within a phase, order so each paper's prerequisites come before it: use the builds-on edges (a paper should come after the papers it builds on) and dates.
- Each paper at most once. Prefer papers with extractions and high influence, but include a recent low-citation paper at the frontier when its velocity marks it as important.
- reason: one sentence on why to read it and what to take away, specific to the paper (not "a seminal work").`;

export const READING_PATH_INSTRUCTION = `Task: build the reading path.

${READING_PATH_GUIDE}

Record it with the record_reading_path tool.`;

const PHASE_ORDER = new Map(READING_PHASES.map((p, i) => [p, i]));

/**
 * Pure: steps -> stored document. Drops unknown refs and repeats (first
 * occurrence wins) and stable-sorts into phase order, keeping the model's order
 * within a phase.
 */
export function mapReadingPath(steps: ReadingPathInput["steps"], refs: RefResolver): ReadingPathDocument {
  const seen = new Set<string>();
  const mapped: (ReadingPathDocument["steps"][number] & { i: number })[] = [];
  steps.forEach((s, i) => {
    const paperId = refs.one(s.ref);
    if (!paperId || seen.has(paperId)) return;
    seen.add(paperId);
    mapped.push({ phase: s.phase, paperId, reason: clean(s.reason, true), i });
  });
  mapped.sort((a, b) => PHASE_ORDER.get(a.phase)! - PHASE_ORDER.get(b.phase)! || a.i - b.i);
  if (mapped.length === 0) throw new LlmOutputError("reading path has no steps with known refs.");
  return { steps: mapped.slice(0, MAX_STEPS).map((m) => ({ phase: m.phase, paperId: m.paperId, reason: m.reason })) };
}

/** S5. */
export function synthesizeReadingPath(opts: SynthesisCallOptions): Promise<ReadingPathDocument> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_reading_path",
    tool: READING_PATH_TOOL,
    schema: readingPathInputSchema,
    instruction: READING_PATH_INSTRUCTION,
    maxTokens: 3000,
    map: (data, refs) => mapReadingPath(data.steps, refs),
  });
}
