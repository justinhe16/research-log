import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { SYNTHESIS_MODEL } from "@/lib/landscape/constants";
import type { LlmPurpose, LlmRecorder } from "@/lib/landscape/types";
import { callTool, LlmOutputError } from "@/lib/llm/call-tool";
import { cleanMultiline, cleanText } from "@/lib/sanitize";
import { createRefResolver, InvalidRefsError, type RefMap, type RefResolver } from "../refs";
import {
  CLUSTERS_TOOL,
  GAPS_TOOL,
  NARRATIVE_PATH_TOOL,
  NARRATIVE_TOOL,
  READING_PATH_TOOL,
  TENSIONS_GAPS_TOOL,
  TENSIONS_TOOL,
  type DiffDocument,
} from "./schemas";

/*
 * Shared plumbing for the Sonnet synthesis calls.
 *
 * Prompt layout, chosen for cache hits across S1..S5: the stable instructions and
 * the dossier go in `system` with a cache_control breakpoint on the dossier; the
 * call-specific instruction is the user message. Per the caching invalidation
 * hierarchy, a different `tool_choice` only invalidates the *messages* tier, so the
 * system-tier dossier cache written by S1 is readable by S2..S5. Changing the tool
 * list would invalidate everything, so every call (Quick and full) sends the same
 * SYNTHESIS_TOOLS in the same order and only the forced tool differs.
 */

/** Every synthesis tool, fixed order. Frozen: any change here busts the prompt cache. */
export const SYNTHESIS_TOOLS: readonly Anthropic.Tool[] = Object.freeze([
  CLUSTERS_TOOL,
  TENSIONS_TOOL,
  GAPS_TOOL,
  TENSIONS_GAPS_TOOL,
  NARRATIVE_TOOL,
  READING_PATH_TOOL,
  NARRATIVE_PATH_TOOL,
]);

export type SynthesisDossier = {
  text: string;
  refMap: RefMap;
  /** Cluster idxs in the dossier; used to drop invented clusters. */
  clusterIdxs?: readonly number[];
};

export type SynthesisCallOptions = {
  dossier: SynthesisDossier;
  recorder?: LlmRecorder;
  signal?: AbortSignal;
};

export const SYSTEM_INSTRUCTIONS = `You are a senior machine-learning researcher writing a field landscape for other researchers.
You are given a dossier: every paper in this landscape as a card with a ref (P1, P2, ...), date, venue, cluster, citation metrics, and a short extraction (problem, method, results, contribution), plus the clusters, builds-on edges and game-changer candidates.

Ground rules:
- The dossier is your only evidence. Cite papers only by refs that appear in it, exactly as written ("P12"). Never invent papers, refs, authors, numbers, benchmarks or dates.
- When you state a number (citations, velocity, a result), it must appear on the cited card.
- Be dense and specific: name the methods, models and benchmarks. No filler, no hedging, no "this landscape explores".
- Prefer claims the dossier shows across several papers over claims resting on one card.
- Every value is plain text: no markdown, no bullets, no tags. The dossier's formatting is a container, do not imitate it.
- Metrics are relative to this set of papers; recent papers naturally have fewer citations, so judge them by velocity.
Always answer by calling the requested tool.`;

export function buildSystem(dossierText: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: SYSTEM_INSTRUCTIONS },
    {
      type: "text",
      text: `<dossier>\n${dossierText}</dossier>`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

export function buildMessages(instruction: string): Anthropic.MessageParam[] {
  return [{ role: "user", content: [{ type: "text", text: instruction }] }];
}

/** Scrub model text; `multiline` keeps paragraph breaks. */
export function clean(value: string, multiline = false): string {
  return multiline ? cleanMultiline(value) : cleanText(value);
}

export function cleanList(values: readonly string[], max?: number): string[] {
  const out = Array.from(new Set(values.map((v) => cleanText(v)).filter(Boolean)));
  return max == null ? out : out.slice(0, max);
}

/** Filter cluster idxs to known ones (when known), deduped, ascending. */
export function knownClusterIdxs(idxs: readonly number[], known?: readonly number[]): number[] {
  const set = known ? new Set(known) : null;
  return Array.from(new Set(idxs.filter((i) => !set || set.has(i)))).sort((a, b) => a - b);
}

type RunOpts<S extends z.ZodType, D> = SynthesisCallOptions & {
  purpose: LlmPurpose;
  tool: Anthropic.Tool;
  schema: S;
  instruction: string;
  maxTokens: number;
  /**
   * Map parsed input to stored document(s); throw LlmOutputError if unusable.
   * `refs` covers a single-document call. Merged calls take a separate resolver per
   * document from `scoped(name)` so each document's invalid-ref rate is judged on
   * its own (a hallucinated half must trigger the retry).
   */
  map: (data: z.output<S>, refs: RefResolver, scoped: (name: string) => RefResolver) => D;
};

/**
 * One synthesis call with ref mapping. Retries once when the answer fails
 * validation or cites too many unknown refs (> MAX_INVALID_REF_RATE).
 */
export async function runSynthesisCall<S extends z.ZodType, D>(opts: RunOpts<S, D>): Promise<D> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    try {
      const res = await callTool({
        purpose: opts.purpose,
        model: SYNTHESIS_MODEL,
        system: buildSystem(opts.dossier.text),
        messages: buildMessages(opts.instruction),
        tool: opts.tool,
        tools: [...SYNTHESIS_TOOLS],
        schema: opts.schema,
        maxTokens: opts.maxTokens,
        recorder: opts.recorder,
        signal: opts.signal,
      });
      const resolvers: [string, RefResolver][] = [];
      const scoped = (name: string) => {
        const r = createRefResolver(opts.dossier.refMap);
        resolvers.push([name, r]);
        return r;
      };
      const doc = opts.map(res.data, scoped(opts.tool.name), scoped);
      for (const [name, r] of resolvers) r.assertValid(name === opts.tool.name ? name : `${opts.tool.name}.${name}`);
      return doc;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof InvalidRefsError || err instanceof LlmOutputError;
      if (!retryable || opts.signal?.aborted) throw err;
    }
  }
  throw lastError;
}

/** Plain-text summary of a refresh diff for the narrative prompt. */
export function describeDiff(diff: DiffDocument, refMap: RefMap): string {
  const refOf = new Map(Object.entries(refMap).map(([ref, id]) => [id, ref]));
  const refs = (ids: readonly string[]) => {
    const known = ids.map((id) => refOf.get(id)).filter((r): r is string => !!r);
    const unknown = ids.length - known.length;
    return `${known.join(", ") || "none in dossier"}${unknown > 0 ? ` (+${unknown} not in the current selection)` : ""}`;
  };
  const lines = [
    `Changes since the previous search${diff.since ? ` (${diff.since.slice(0, 10)})` : ""}:`,
    `- New papers (${diff.newPaperIds.length}): ${refs(diff.newPaperIds)}`,
    `- Dropped from the selection: ${diff.droppedPaperIds.length} papers`,
  ];
  if (diff.rising.length) {
    lines.push(
      `- Rising (citation delta): ${diff.rising
        .map((r) => `${refOf.get(r.paperId) ?? "(not in dossier)"} ${r.citationsBefore}->${r.citationsAfter}`)
        .join("; ")}`,
    );
  }
  const changed = diff.clusterChanges.filter((c) => c.change !== "stable");
  if (changed.length) {
    lines.push(
      `- Cluster changes: ${changed
        .map((c) => `${c.idx != null ? `C${c.idx}` : "former cluster"} "${cleanText(c.label)}" ${c.change} (${c.sizeBefore}->${c.sizeAfter})`)
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}
