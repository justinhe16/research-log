import type { DocumentKind, LlmRecorder } from "@/lib/landscape/types";
import { synthesizeClusters } from "./clusters";
import { synthesizeGaps } from "./gaps";
import { synthesizeNarrative } from "./narrative";
import { synthesizeNarrativeAndPath, synthesizeTensionsAndGaps } from "./quick";
import { synthesizeReadingPath } from "./reading-path";
import type {
  ClustersDocument,
  DiffDocument,
  GapsDocument,
  NarrativeDocument,
  ReadingPathDocument,
  TensionsDocument,
} from "./schemas";
import type { SynthesisDossier } from "./shared";
import { synthesizeTensions } from "./tensions";

export { synthesizeClusters } from "./clusters";
export { synthesizeGaps } from "./gaps";
export { synthesizeNarrative } from "./narrative";
export { synthesizeNarrativeAndPath, synthesizeTensionsAndGaps } from "./quick";
export { synthesizeReadingPath } from "./reading-path";
export { synthesizeTensions } from "./tensions";
export type { SynthesisDossier } from "./shared";

/** LLM-authored document kinds (diff is computed, never synthesized). */
export const SYNTHESIZED_KINDS = ["clusters", "tensions", "gaps", "narrative", "reading_path"] as const satisfies readonly DocumentKind[];
export type SynthesizedKind = (typeof SYNTHESIZED_KINDS)[number];

export type SynthesizedDocuments = {
  clusters: ClustersDocument;
  tensions: TensionsDocument;
  gaps: GapsDocument;
  narrative: NarrativeDocument;
  reading_path: ReadingPathDocument;
};

export type RunSynthesisInput = {
  dossier: SynthesisDossier;
  /** DepthConfig.synthesisCalls: 3 = Quick merged mode. */
  depthSynthCalls: 3 | 5;
  /** Refresh only: fills the narrative's whatChanged. */
  diff?: DiffDocument | null;
  recorder?: LlmRecorder;
  signal?: AbortSignal;
  /** Restrict to these kinds (e.g. "Retry synthesis" for failed ones). Default: all. */
  kinds?: readonly SynthesizedKind[];
};

export type RunSynthesisResult = {
  documents: Partial<SynthesizedDocuments>;
  /** Error message per failed kind. */
  errors: Partial<Record<SynthesizedKind, string>>;
  /** From S1; null when clusters weren't (successfully) synthesized. */
  topicSummary: string | null;
  /** Cluster idx -> synthesized name, from S1. */
  clusterLabels: Record<number, string>;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the synthesis calls. S1 (clusters) goes first so its request writes the
 * dossier prompt cache; the rest then run in parallel and read it. Each kind
 * succeeds or fails on its own. Never throws, except when aborted.
 */
export async function runSynthesis(input: RunSynthesisInput): Promise<RunSynthesisResult> {
  const kinds = new Set<SynthesizedKind>(input.kinds ?? SYNTHESIZED_KINDS);
  const base = { dossier: input.dossier, recorder: input.recorder, signal: input.signal };
  const result: RunSynthesisResult = { documents: {}, errors: {}, topicSummary: null, clusterLabels: {} };
  const abortIfNeeded = () => {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
  };

  const settle = async <T>(targets: SynthesizedKind[], run: () => Promise<T>, assign: (value: T) => void) => {
    try {
      assign(await run());
    } catch (err) {
      abortIfNeeded();
      for (const k of targets) result.errors[k] = message(err);
    }
  };

  if (kinds.has("clusters")) {
    await settle(["clusters"], () => synthesizeClusters(base), (doc) => {
      result.documents.clusters = doc;
      result.topicSummary = doc.topicSummary;
      for (const c of doc.clusters) result.clusterLabels[c.idx] = c.name;
    });
    abortIfNeeded();
  }

  // Deferred so the first call can run alone when S1 isn't part of this run.
  const tasks: (() => Promise<void>)[] = [];
  if (input.depthSynthCalls === 3) {
    const tg = (["tensions", "gaps"] as const).filter((k) => kinds.has(k));
    if (tg.length) {
      tasks.push(() =>
        settle([...tg], () => synthesizeTensionsAndGaps(base), (out) => {
          if (kinds.has("tensions")) result.documents.tensions = out.tensions;
          if (kinds.has("gaps")) result.documents.gaps = out.gaps;
        }),
      );
    }
    const np = (["narrative", "reading_path"] as const).filter((k) => kinds.has(k));
    if (np.length) {
      tasks.push(() =>
        settle([...np], () => synthesizeNarrativeAndPath({ ...base, diff: input.diff }), (out) => {
          if (kinds.has("narrative")) result.documents.narrative = out.narrative;
          if (kinds.has("reading_path")) result.documents.reading_path = out.readingPath;
        }),
      );
    }
  } else {
    if (kinds.has("tensions")) tasks.push(() => settle(["tensions"], () => synthesizeTensions(base), (d) => void (result.documents.tensions = d)));
    if (kinds.has("gaps")) tasks.push(() => settle(["gaps"], () => synthesizeGaps(base), (d) => void (result.documents.gaps = d)));
    if (kinds.has("narrative")) {
      tasks.push(() => settle(["narrative"], () => synthesizeNarrative({ ...base, diff: input.diff }), (d) => void (result.documents.narrative = d)));
    }
    if (kinds.has("reading_path")) {
      tasks.push(() => settle(["reading_path"], () => synthesizeReadingPath(base), (d) => void (result.documents.reading_path = d)));
    }
  }

  // Without S1 (e.g. a retry of failed kinds), the first remaining call writes the cache.
  let rest = tasks;
  if (!kinds.has("clusters") && tasks.length >= 2) {
    await tasks[0]();
    abortIfNeeded();
    rest = tasks.slice(1);
  }

  const settled = await Promise.allSettled(rest.map((t) => t()));
  abortIfNeeded();
  // `settle` swallows everything but aborts; surface anything unexpected.
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  return result;
}
