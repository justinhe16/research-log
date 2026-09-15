import type { RefResolver } from "../refs";
import { TENSIONS_TOOL, tensionsInputSchema, type TensionsDocument, type TensionsInput } from "./schemas";
import { clean, knownClusterIdxs, runSynthesisCall, type SynthesisCallOptions, type SynthesisDossier } from "./shared";

const MAX_TENSIONS = 6;
const MAX_POSITIONS = 3;

export const TENSIONS_GUIDE = `Tensions (3-6): genuine, live disagreements or trade-offs the papers embody, not generic ML dilemmas.
- Good: two method families making incompatible bets (e.g. "learned sparse dictionaries vs. supervised probes for feature discovery"), conflicting empirical findings, an efficiency-vs-fidelity trade-off that papers resolve differently.
- Bad: "accuracy vs. cost" in the abstract, or a tension no card evidences.
- Each tension has 2-3 positions; each position is one sentence stating the stance and cites the papers that hold or evidence it. A paper should not appear on opposing sides.
- clusterIdxs: the clusters involved.`;

export const TENSIONS_INSTRUCTION = `Task: identify the tensions in this landscape.

${TENSIONS_GUIDE}

Record them with the record_tensions tool.`;

export function mapTensionList(
  items: TensionsInput["tensions"],
  refs: RefResolver,
  dossier: Pick<SynthesisDossier, "clusterIdxs">,
): TensionsDocument["tensions"] {
  return items
    .map((t) => ({
      title: clean(t.title),
      description: clean(t.description, true),
      positions: t.positions
        .map((p) => ({ stance: clean(p.stance), paperIds: refs.many(p.refs) }))
        .filter((p) => p.stance)
        .slice(0, MAX_POSITIONS),
      clusterIdxs: knownClusterIdxs(t.clusterIdxs, dossier.clusterIdxs),
    }))
    .filter((t) => t.title && t.positions.length > 0)
    .slice(0, MAX_TENSIONS);
}

export function mapTensions(data: TensionsInput, refs: RefResolver, dossier: Pick<SynthesisDossier, "clusterIdxs">): TensionsDocument {
  return { tensions: mapTensionList(data.tensions, refs, dossier) };
}

/** S2. */
export function synthesizeTensions(opts: SynthesisCallOptions): Promise<TensionsDocument> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_tensions",
    tool: TENSIONS_TOOL,
    schema: tensionsInputSchema,
    instruction: TENSIONS_INSTRUCTION,
    maxTokens: 4096,
    map: (data, refs) => mapTensions(data, refs, opts.dossier),
  });
}
