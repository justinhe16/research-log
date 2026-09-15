import { MAX_GAME_CHANGERS } from "@/lib/landscape/constants";
import type { RefResolver } from "../refs";
import {
  NARRATIVE_TOOL,
  narrativeInputSchema,
  type DiffDocument,
  type NarrativeDocument,
  type NarrativeInput,
} from "./schemas";
import { clean, describeDiff, runSynthesisCall, type SynthesisCallOptions, type SynthesisDossier } from "./shared";

const MAX_ERAS = 5;

export const NARRATIVE_GUIDE = `Narrative:
- eras (2-5, oldest first): how the field's foundations shifted over time. Each era's summary names what the work then was built on and what displaced it, in the style "Sparse coding, toy superposition models and linear probes were the basis in 2022; by 2024 the field moved to SAEs trained on production LLMs." Use the card dates for startYear/endYear (endYear null for the current era). keyRefs: the papers the era rested on.
- gameChangers (up to ${MAX_GAME_CHANGERS}): papers that shifted the field. Start from the listed candidates; include a non-candidate only if its builds-on in-degree or velocity clearly justifies it. why: what it changed. evidence: cite its actual metrics from the card (citations, influential citations, velocity, pagerank, built-on-by) and what builds on it. Do not pick a paper just because it is old.
- frontier: an object with summary (2-4 sentences on the most recent, fastest-moving work; judge recent papers by velocity, not raw citations) and refs (the refs defining it).
- outlook: 2-3 sentences on where the evidence suggests the field is heading next. Hedge only as much as the evidence requires.`;

export function whatChangedGuide(diff: DiffDocument | null | undefined, refMap: SynthesisDossier["refMap"]): string {
  return diff
    ? `- whatChanged: 2-4 sentences on what changed since the previous search, using the diff below (new papers, rising papers, cluster changes). Name the changes that matter, not a list of counts.

${describeDiff(diff, refMap)}`
    : "- whatChanged: null (this is not a refresh).";
}

export function narrativeInstruction(diff: DiffDocument | null | undefined, refMap: SynthesisDossier["refMap"]): string {
  return `Task: write the field's narrative.

${NARRATIVE_GUIDE}
${whatChangedGuide(diff, refMap)}

Record it with the record_narrative tool.`;
}

/** Pure: parsed narrative fields -> stored document. */
export function mapNarrative(data: NarrativeInput, refs: RefResolver, hasDiff: boolean): NarrativeDocument {
  const eras = data.eras
    .map((e) => ({
      label: clean(e.label),
      startYear: e.startYear,
      endYear: e.endYear != null && e.endYear < e.startYear ? null : e.endYear,
      summary: clean(e.summary, true),
      keyPaperIds: refs.many(e.keyRefs),
    }))
    .filter((e) => e.label && e.summary)
    .sort((a, b) => a.startYear - b.startYear)
    .slice(0, MAX_ERAS);

  const seen = new Set<string>();
  const gameChangers: NarrativeDocument["gameChangers"] = [];
  for (const g of data.gameChangers) {
    const paperId = refs.one(g.ref);
    if (!paperId || seen.has(paperId)) continue;
    seen.add(paperId);
    gameChangers.push({ paperId, why: clean(g.why, true), evidence: clean(g.evidence, true) });
  }

  return {
    eras,
    gameChangers: gameChangers.slice(0, MAX_GAME_CHANGERS),
    frontier: { summary: clean(data.frontier.summary, true), paperIds: refs.many(data.frontier.refs) },
    outlook: clean(data.outlook, true),
    whatChanged: hasDiff && data.whatChanged ? clean(data.whatChanged, true) || null : null,
  };
}

export type NarrativeCallOptions = SynthesisCallOptions & { diff?: DiffDocument | null };

/** S4. */
export function synthesizeNarrative(opts: NarrativeCallOptions): Promise<NarrativeDocument> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_narrative",
    tool: NARRATIVE_TOOL,
    schema: narrativeInputSchema,
    instruction: narrativeInstruction(opts.diff, opts.dossier.refMap),
    maxTokens: 4096,
    map: (data, refs) => mapNarrative(data, refs, !!opts.diff),
  });
}
