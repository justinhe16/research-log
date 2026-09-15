import { LlmOutputError } from "@/lib/llm/call-tool";
import type { RefResolver } from "../refs";
import { CLUSTERS_TOOL, clustersInputSchema, type ClustersDocument, type ClustersInput } from "./schemas";
import { clean, cleanList, runSynthesisCall, type SynthesisCallOptions, type SynthesisDossier } from "./shared";

const MAX_KEY_IDEAS = 5;
const MAX_REPRESENTATIVES = 4;

export const CLUSTERS_INSTRUCTION = `Task: name and characterize every cluster in the dossier, and summarize the whole landscape.

- topicSummary: 3-5 sentences a researcher new to the field could orient by: what the field is trying to do, the main families of approach (by cluster), and where the energy is now.
- One entry per cluster, echoing its idx. The heuristic label and key terms are hints, not names: choose a 2-5 word name that says what unites the papers (method family or problem), specific enough to tell clusters apart.
- summary: 2-3 sentences on the shared idea and how the cluster's papers differ from the neighbouring clusters.
- keyIdeas: 3-5 concrete ideas, techniques or findings, each a short phrase grounded in the member cards.
- representativeRefs: 2-4 members that best exemplify the cluster, favouring a mix of an influential anchor and a recent representative. Only refs listed as members of that cluster.

Record it with the record_clusters tool.`;

/** Pure: parsed tool input -> stored document. */
export function mapClusters(data: ClustersInput, refs: RefResolver, dossier: Pick<SynthesisDossier, "clusterIdxs">): ClustersDocument {
  const known = dossier.clusterIdxs ? new Set(dossier.clusterIdxs) : null;
  const seen = new Set<number>();
  const clusters: ClustersDocument["clusters"] = [];
  for (const c of data.clusters) {
    if (seen.has(c.idx) || (known && !known.has(c.idx))) continue;
    seen.add(c.idx);
    const name = clean(c.name);
    if (!name) continue;
    clusters.push({
      idx: c.idx,
      name,
      summary: clean(c.summary, true),
      keyIdeas: cleanList(c.keyIdeas, MAX_KEY_IDEAS),
      representativePaperIds: refs.many(c.representativeRefs).slice(0, MAX_REPRESENTATIVES),
    });
  }
  clusters.sort((a, b) => a.idx - b.idx);
  const topicSummary = clean(data.topicSummary, true);
  if (!topicSummary || (clusters.length === 0 && data.clusters.length > 0)) {
    throw new LlmOutputError("record_clusters returned no usable clusters or topic summary.");
  }
  return { topicSummary, clusters };
}

/** S1. Runs first: its request writes the dossier cache the other calls read. */
export function synthesizeClusters(opts: SynthesisCallOptions): Promise<ClustersDocument> {
  return runSynthesisCall({
    ...opts,
    purpose: "synth_clusters",
    tool: CLUSTERS_TOOL,
    schema: clustersInputSchema,
    instruction: CLUSTERS_INSTRUCTION,
    maxTokens: 4096,
    map: (data, refs) => mapClusters(data, refs, opts.dossier),
  });
}
