import type { RefResolver } from "../refs";
import { GAPS_TOOL, gapsInputSchema, type GapsDocument, type GapsInput } from "./schemas";
import { clean, cleanList, runSynthesisCall, type SynthesisCallOptions } from "./shared";

const MAX_GAPS = 6;
const MAX_DIRECTIONS = 3;

export const GAPS_GUIDE = `Gaps (3-6): open problems that the dossier makes visible, not wishes.
- Ground each gap in what the cards show or conspicuously lack: e.g. every results field reports the same benchmark; no paper evaluates at scale X; limitations fields repeat the same caveat; a cluster has no recent papers.
- evidence: 1-2 sentences stating that pattern concretely; evidenceRefs: the papers that make it visible.
- directions: 1-3 concrete, testable research directions (what to build or measure), not "more research is needed".
- Do not claim something has never been done in the wider literature; say what this set of papers does not do.`;

export const GAPS_INSTRUCTION = `Task: identify the open gaps in this landscape.

${GAPS_GUIDE}

Record them with the record_gaps tool.`;

export function mapGapList(items: GapsInput["gaps"], refs: RefResolver): GapsDocument["gaps"] {
  return items
    .map((g) => ({
      title: clean(g.title),
      description: clean(g.description, true),
      evidence: clean(g.evidence, true),
      evidencePaperIds: refs.many(g.evidenceRefs),
      directions: cleanList(g.directions, MAX_DIRECTIONS),
    }))
    .filter((g) => g.title && g.description)
    .slice(0, MAX_GAPS);
}

export function mapGaps(data: GapsInput, refs: RefResolver): GapsDocument {
  return { gaps: mapGapList(data.gaps, refs) };
}

/** S3. */
export function synthesizeGaps(opts: SynthesisCallOptions): Promise<GapsDocument> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_gaps",
    tool: GAPS_TOOL,
    schema: gapsInputSchema,
    instruction: GAPS_INSTRUCTION,
    maxTokens: 4096,
    map: (data, refs) => mapGaps(data, refs),
  });
}
