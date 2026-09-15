import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EXTRACT_BATCH_SIZE,
  EXTRACT_CONCURRENCY,
  EXTRACTION_MODEL,
  FULLTEXT_PROMPT_MAX_CHARS,
} from "@/lib/landscape/constants";
import type { LlmRecorder, PaperExtractionDTO } from "@/lib/landscape/types";
import { callTool, LlmOutputError } from "@/lib/llm/call-tool";
import { keywords, nullableText, toObjectArray } from "@/lib/llm/coerce";
import { cleanMultiline, cleanText } from "@/lib/sanitize";
import { normalizeRef } from "./synthesize/schemas";

/*
 * Stage 12 (extract): Haiku reads abstracts in batches of 5 (or one full-text
 * excerpt) and records problem / method / results / contribution per paper.
 * Pure: the caller owns the paper_extractions cache (keyed by `sourceHash`).
 */

export type ExtractPaperInput = {
  paperId: string;
  /** Optional ref for the prompt; reassigned P1..Pn when absent or duplicated. */
  ref?: string;
  title: string;
  year: number | null;
  venue: string | null;
  abstract: string | null;
};

/** The model-authored columns of `paper_extractions`. */
export type ExtractionFields = Pick<
  PaperExtractionDTO,
  "problem" | "method" | "results" | "contribution" | "limitations" | "datasets" | "benchmarks"
>;

export type ExtractionFailure = { paperId: string; error: string };

export type ExtractCallOptions = { recorder?: LlmRecorder; signal?: AbortSignal };

const TOOL_NAME = "record_extractions";
const MAX_LIST = 10;
const FIELD_MAX = 600;

/** sha256 hex of the exact input text: the cache key's `source_hash`. */
export function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Schema & tool
// ---------------------------------------------------------------------------

const loose = z.preprocess((v) => (typeof v === "string" ? v : v == null ? "" : String(v)), z.string()).default("");

const itemSchema = z.object({
  ref: z.preprocess((v) => (v == null ? "" : String(v)), z.string()).transform(normalizeRef),
  problem: loose,
  method: loose,
  results: loose,
  contribution: loose,
  limitations: z.preprocess((v) => (v == null ? null : String(v)), z.string().nullable()).default(null),
  datasets: z.preprocess(keywords, z.array(z.string())).default([]),
  benchmarks: z.preprocess(keywords, z.array(z.string())).default([]),
});

export const extractionsInputSchema = z.object({
  extractions: z.preprocess(toObjectArray, z.array(itemSchema)),
});
export type ExtractionsInput = z.output<typeof extractionsInputSchema>;

const S = (description: string) => ({ type: "string", description });

const EXTRACT_TOOL = {
  name: TOOL_NAME,
  description: "Record one structured extraction per paper.",
  input_schema: {
    type: "object" as const,
    properties: {
      extractions: {
        type: "array",
        description: "Exactly one entry per <paper>, in any order.",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", pattern: "^P\\d+$", description: 'The ref attribute of the <paper>, e.g. "P1".' },
            problem: S("One sentence: the problem or question addressed."),
            method: S("1-2 sentences: the approach, naming the key technique."),
            results: S("1-2 sentences: main results, with the numbers and baselines given. 'Not reported' if none."),
            contribution: S("One sentence: what is new relative to prior work."),
            limitations: { type: ["string", "null"], description: "One sentence if stated or evident; else null." },
            datasets: { type: "array", items: { type: "string" }, description: "Named datasets used. Empty if none named." },
            benchmarks: { type: "array", items: { type: "string" }, description: "Named benchmarks/evals. Empty if none named." },
          },
          required: ["ref", "problem", "method", "results", "contribution", "limitations", "datasets", "benchmarks"],
        },
      },
    },
    required: ["extractions"],
  },
};

const SYSTEM = `You are the reading engine for a machine-learning research landscape tool.
You read papers and record compact, factual extractions that will later be compared across dozens of papers.

Rules:
- Dense and specific: name the technique, model, dataset, metric and number. The reader is an ML researcher.
- Only record what the text states. Never invent results, numbers, datasets or baselines; write "Not reported" for results the text does not give.
- No filler ("This paper proposes..."): start with the substance.
- Each field is plain text. No markdown, no bullets, no tags.
- Datasets and benchmarks are proper names only (e.g. "ImageNet", "MMLU"), never descriptions.
Always answer by calling the ${TOOL_NAME} tool.`;

const CONTAINER_NOTE =
  "The <paper> tags above are only containers for the source text. Do not imitate that markup: every value you record must be plain text, with no tags wrapping it.";

function paperBlock(ref: string, p: ExtractPaperInput, body: string, bodyTag: "abstract" | "fulltext"): string {
  const meta = [
    `Title: ${cleanText(p.title)}`,
    p.year != null ? `Year: ${p.year}` : null,
    p.venue ? `Venue: ${cleanText(p.venue)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `<paper ref="${ref}">
${meta}
<${bodyTag}>
${body}
</${bodyTag}>
</paper>`;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function cap(text: string, max = FIELD_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > max * 0.6 ? sp : max).trimEnd()}…`;
}

function cleanList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const c = cleanText(v).replace(/^["']|["']$/g, "").trim();
    if (!c || nullableText(c) === null) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cap(c, 80));
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** Sanitize one extraction; null when it's empty enough to count as a failure. */
export function cleanExtraction(item: z.output<typeof itemSchema>): ExtractionFields | null {
  const field = (v: string) => {
    const c = cleanMultiline(v).replace(/\n+/g, " ");
    return nullableText(c) === null ? "" : cap(c);
  };
  const out: ExtractionFields = {
    problem: field(item.problem),
    method: field(item.method),
    results: field(item.results),
    contribution: field(item.contribution),
    limitations: item.limitations == null ? null : nullableText(field(item.limitations)),
    datasets: cleanList(item.datasets),
    benchmarks: cleanList(item.benchmarks),
  };
  if (!out.method && !out.contribution) return null;
  return out;
}

function assignRefs(papers: readonly ExtractPaperInput[]): string[] {
  const refs = papers.map((p) => (p.ref ? normalizeRef(p.ref) : ""));
  const valid = refs.every((r) => /^P\d+$/.test(r)) && new Set(refs).size === refs.length;
  return valid ? refs : papers.map((_, i) => `P${i + 1}`);
}

/** Map a parsed tool answer back to paperIds; exported for tests. */
export function mapExtractions(
  data: ExtractionsInput,
  papers: readonly ExtractPaperInput[],
  refs: readonly string[] = assignRefs(papers),
): { results: Map<string, ExtractionFields>; failures: ExtractionFailure[] } {
  const byRef = new Map(refs.map((r, i) => [r, papers[i]]));
  const results = new Map<string, ExtractionFields>();
  for (const item of data.extractions) {
    const paper = byRef.get(item.ref);
    if (!paper || results.has(paper.paperId)) continue;
    const clean = cleanExtraction(item);
    if (clean) results.set(paper.paperId, clean);
  }
  const failures = papers
    .filter((p) => !results.has(p.paperId))
    .map((p) => ({ paperId: p.paperId, error: "missing or empty extraction in batch response" }));
  return { results, failures };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * One Haiku call over up to 5 abstracts. Papers the model skipped (or answered
 * with an empty/unknown ref) come back in `failures` so the caller retries them
 * singly. Throws on API errors or wholly unusable output.
 */
export async function extractBatch(
  papers: readonly ExtractPaperInput[],
  opts: ExtractCallOptions = {},
): Promise<{ results: Map<string, ExtractionFields>; failures: ExtractionFailure[] }> {
  if (papers.length === 0) return { results: new Map(), failures: [] };
  if (papers.length > EXTRACT_BATCH_SIZE) {
    throw new Error(`extractBatch takes at most ${EXTRACT_BATCH_SIZE} papers, got ${papers.length}.`);
  }
  const refs = assignRefs(papers);
  const blocks = papers
    .map((p, i) => paperBlock(refs[i], p, p.abstract?.trim() ? cleanMultiline(p.abstract) : "(no abstract available: extract only what the title supports, write \"Not reported\" otherwise)", "abstract"))
    .join("\n\n");
  const content = `${blocks}

${CONTAINER_NOTE}

Record exactly one extraction for each of the ${papers.length} papers (refs ${refs.join(", ")}) with the ${TOOL_NAME} tool.`;

  const res = await callTool({
    purpose: "extract_abstracts",
    model: EXTRACTION_MODEL,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    tool: EXTRACT_TOOL,
    schema: extractionsInputSchema,
    maxTokens: 700 * papers.length + 400,
    recorder: opts.recorder,
    signal: opts.signal,
  });
  return mapExtractions(res.data, papers, refs);
}

/** One Haiku call over a full-text excerpt (capped at FULLTEXT_PROMPT_MAX_CHARS). */
export async function extractFulltext(
  paper: ExtractPaperInput,
  excerpt: string,
  opts: ExtractCallOptions = {},
): Promise<ExtractionFields> {
  const text = excerpt.slice(0, FULLTEXT_PROMPT_MAX_CHARS);
  const truncated = excerpt.length > FULLTEXT_PROMPT_MAX_CHARS ? "\n[text truncated]" : "";
  const content = `${paperBlock("P1", paper, `${text}${truncated}`, "fulltext")}

${CONTAINER_NOTE}
The full text is available, so prefer concrete numbers from the results and any limitations the authors discuss.

Record the extraction for P1 with the ${TOOL_NAME} tool.`;

  const res = await callTool({
    purpose: "extract_fulltext",
    model: EXTRACTION_MODEL,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    tool: EXTRACT_TOOL,
    schema: extractionsInputSchema,
    maxTokens: 1500,
    recorder: opts.recorder,
    signal: opts.signal,
  });
  // A single paper: accept the answer whatever ref it echoed.
  const item = res.data.extractions[0];
  const clean = item ? cleanExtraction(item) : null;
  if (!clean) throw new LlmOutputError(`${TOOL_NAME} returned no usable full-text extraction.`);
  return clean;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ExtractionProgress = { done: number; failed: number; total: number };

export type RunExtractionsOptions = ExtractCallOptions & {
  concurrency?: number;
  batchSize?: number;
  onProgress?: (p: ExtractionProgress) => void;
  /** Called as each paper succeeds, so the caller can persist incrementally. */
  onResult?: (paperId: string, fields: ExtractionFields) => void | Promise<void>;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract many papers: batches of `batchSize` at `concurrency`. A failed batch
 * is retried once; papers still missing after that are extracted one by one.
 * Never throws for model/API failures (they land in `failures`); rethrows aborts.
 */
export async function runExtractions(
  papers: readonly ExtractPaperInput[],
  opts: RunExtractionsOptions = {},
): Promise<{ results: Map<string, ExtractionFields>; failures: ExtractionFailure[] }> {
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? EXTRACT_BATCH_SIZE, EXTRACT_BATCH_SIZE));
  const concurrency = Math.max(1, opts.concurrency ?? EXTRACT_CONCURRENCY);
  const results = new Map<string, ExtractionFields>();
  const failures: ExtractionFailure[] = [];
  const total = papers.length;

  const batches: ExtractPaperInput[][] = [];
  for (let i = 0; i < papers.length; i += batchSize) batches.push(papers.slice(i, i + batchSize));

  const checkAbort = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
  };
  const progress = () => opts.onProgress?.({ done: results.size, failed: failures.length, total });
  const succeed = async (paperId: string, fields: ExtractionFields) => {
    results.set(paperId, fields);
    await opts.onResult?.(paperId, fields);
  };

  const runBatch = async (batch: ExtractPaperInput[]) => {
    let pending = batch;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      checkAbort();
      try {
        const out = await extractBatch(pending, opts);
        for (const [id, f] of out.results) await succeed(id, f);
        const missing = new Set(out.failures.map((f) => f.paperId));
        pending = pending.filter((p) => missing.has(p.paperId));
        lastError = null;
        break; // Partial answers go straight to per-paper; no second batch attempt.
      } catch (err) {
        checkAbort();
        lastError = err;
      }
    }
    // A lone paper already had its two tries.
    if (lastError && batch.length === 1) {
      failures.push({ paperId: batch[0].paperId, error: errorMessage(lastError) });
      pending = [];
    }
    // Per-paper fallback for whatever the batch calls didn't produce.
    for (const p of pending) {
      checkAbort();
      try {
        const out = await extractBatch([{ ...p, ref: "P1" }], opts);
        const f = out.results.get(p.paperId);
        if (f) await succeed(p.paperId, f);
        else failures.push({ paperId: p.paperId, error: out.failures[0]?.error ?? "no extraction" });
      } catch (err) {
        checkAbort();
        failures.push({ paperId: p.paperId, error: errorMessage(err) });
      }
    }
    progress();
  };

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      await runBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return { results, failures };
}
