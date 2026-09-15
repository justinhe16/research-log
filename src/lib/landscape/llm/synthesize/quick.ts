import { narrativePathInputSchema, NARRATIVE_PATH_TOOL, tensionsGapsInputSchema, TENSIONS_GAPS_TOOL } from "./schemas";
import type { GapsDocument, NarrativeDocument, ReadingPathDocument, TensionsDocument } from "./schemas";
import { GAPS_GUIDE, mapGapList } from "./gaps";
import { mapNarrative, NARRATIVE_GUIDE, whatChangedGuide, type NarrativeCallOptions } from "./narrative";
import { mapReadingPath, READING_PATH_GUIDE } from "./reading-path";
import { runSynthesisCall, type SynthesisCallOptions } from "./shared";
import { mapTensionList, TENSIONS_GUIDE } from "./tensions";

/*
 * Quick depth merges calls: S2+S3 in one, S4+S5 in one. The stored documents are
 * the same kinds as in 5-call mode.
 */

export const TENSIONS_GAPS_INSTRUCTION = `Task: identify the tensions and the open gaps in this landscape.

${TENSIONS_GUIDE}

${GAPS_GUIDE}

Record both with the record_tensions_and_gaps tool.`;

/** Merged S2+S3. */
export function synthesizeTensionsAndGaps(
  opts: SynthesisCallOptions,
): Promise<{ tensions: TensionsDocument; gaps: GapsDocument }> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_tensions_gaps",
    tool: TENSIONS_GAPS_TOOL,
    schema: tensionsGapsInputSchema,
    instruction: TENSIONS_GAPS_INSTRUCTION,
    maxTokens: 6000,
    map: (data, _refs, scoped) => ({
      tensions: { tensions: mapTensionList(data.tensions, scoped("tensions"), opts.dossier) },
      gaps: { gaps: mapGapList(data.gaps, scoped("gaps")) },
    }),
  });
}

export function narrativePathInstruction(opts: NarrativeCallOptions): string {
  return `Task: write the field's narrative and a reading path.

${NARRATIVE_GUIDE}
${whatChangedGuide(opts.diff, opts.dossier.refMap)}

${READING_PATH_GUIDE}

Record both with the record_narrative_and_reading_path tool (the path goes in readingPath).`;
}

/** Merged S4+S5. */
export function synthesizeNarrativeAndPath(
  opts: NarrativeCallOptions,
): Promise<{ narrative: NarrativeDocument; readingPath: ReadingPathDocument }> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_narrative_path",
    tool: NARRATIVE_PATH_TOOL,
    schema: narrativePathInputSchema,
    instruction: narrativePathInstruction(opts),
    maxTokens: 7000,
    map: (data, _refs, scoped) => ({
      narrative: mapNarrative(data, scoped("narrative"), !!opts.diff),
      readingPath: mapReadingPath(data.readingPath, scoped("readingPath")),
    }),
  });
}
