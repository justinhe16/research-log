import { z } from "zod";
import { EXPANSION_MODEL } from "@/lib/landscape/constants";
import type { ExpandedQuery, LlmRecorder } from "@/lib/landscape/types";
import { callTool } from "@/lib/llm/call-tool";
import { keywords, toObjectArray } from "@/lib/llm/coerce";
import { buildArxivQuery, isSaneArxivQuery } from "@/lib/landscape/sources/arxiv";
import { cleanText } from "@/lib/sanitize";

/*
 * Stage 2 (expand): one Haiku call turns a topic into search queries for arXiv,
 * Semantic Scholar and OpenAlex. The topic name itself is always query 0 and is
 * added by the caller, so duplicates of it are dropped here.
 */

export type ExpandInput = {
  name: string;
  description?: string | null;
  /** Number of queries wanted (DepthConfig.expandedQueries). */
  count: number;
  /** Publication window in years; null = no limit. */
  windowYears: number | null;
};

export type ExpansionResult = {
  queries: ExpandedQuery[];
  /** Union of arXiv categories relevant to the whole topic. */
  categories: string[];
  /** Terms a relevant paper almost always mentions (for BM25 boosting / filtering). */
  mustTerms: string[];
  /** Terms that signal an off-topic homonym (e.g. "sparse autoencoder" in genomics). */
  excludeTerms: string[];
};

const TOOL_NAME = "record_queries";
const MAX_TERMS = 12;
const MAX_CATEGORIES = 6;

const str = z.preprocess((v) => (typeof v === "string" ? v : v == null ? "" : String(v)), z.string());

const querySchema = z.object({
  text: z.string().min(1),
  arxiv: str.default(""),
  categories: z.preprocess(keywords, z.array(z.string())).default([]),
});

export const expandInputSchema = z.object({
  queries: z.preprocess(toObjectArray, z.array(querySchema).min(1)),
  categories: z.preprocess(keywords, z.array(z.string())).default([]),
  mustTerms: z.preprocess(keywords, z.array(z.string())).default([]),
  excludeTerms: z.preprocess(keywords, z.array(z.string())).default([]),
});

const EXPAND_TOOL = {
  name: TOOL_NAME,
  description: "Record the expanded literature-search queries for the topic.",
  input_schema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        description: "Distinct search queries, most important first.",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "Plain keyword query (3-8 words) as a researcher would type into Semantic Scholar. No boolean operators, no quotes.",
            },
            arxiv: {
              type: "string",
              description:
                'arXiv API search_query. Fields ti:, abs:, all:, cat:. Quote phrases with double quotes; combine with AND / OR / ANDNOT (uppercase); group with parentheses. E.g. (abs:"sparse autoencoder" OR abs:"dictionary learning") AND abs:interpretability',
            },
            categories: {
              type: "array",
              items: { type: "string" },
              description: 'arXiv categories to restrict this query to, e.g. ["cs.LG","cs.CL"]. Empty if none.',
            },
          },
          required: ["text", "arxiv", "categories"],
        },
      },
      categories: { type: "array", items: { type: "string" }, description: "1-4 arXiv categories for the topic overall." },
      mustTerms: {
        type: "array",
        items: { type: "string" },
        description: "Up to 8 lowercase terms or short phrases nearly every on-topic paper uses.",
      },
      excludeTerms: {
        type: "array",
        items: { type: "string" },
        description: "Up to 8 lowercase terms that mark off-topic papers sharing the vocabulary. Empty if none.",
      },
    },
    required: ["queries", "categories", "mustTerms", "excludeTerms"],
  },
};

const SYSTEM = `You design literature searches for a machine-learning research landscape tool.
Given a research topic, you write search queries that together retrieve the core, adjacent and foundational papers of the field.

Rules:
- Cover distinct facets: core method names, key synonyms and older terminology, major sub-problems, evaluation/benchmarks, and application angles that are genuinely part of the field.
- Every query must be on-topic. No generic queries ("deep learning", "neural networks") that would flood results.
- Use the vocabulary papers actually use in titles and abstracts, including acronyms (e.g. "RLHF", "SAE").
- Queries must differ in substance, not just word order.
- arXiv categories must be real arXiv identifiers (cs.LG, cs.CL, cs.CV, cs.AI, stat.ML, cs.RO, cs.CR, ...).
- All values are plain text: no markdown, no tags.
Always answer by calling the ${TOOL_NAME} tool.`;

function userMessage(input: ExpandInput): string {
  const window = input.windowYears
    ? `Papers of interest are mostly from the last ${input.windowYears} years, but include the terminology of the foundational work too.`
    : "There is no publication window: include historical terminology as well as current.";
  return `Topic: ${cleanText(input.name)}
${input.description ? `Description: ${cleanText(input.description)}\n` : ""}${window}

Write ${input.count} queries (the topic name itself is already searched, so do not repeat it verbatim).
Record them with the ${TOOL_NAME} tool.`;
}

// ---------------------------------------------------------------------------
// arXiv query syntax
// ---------------------------------------------------------------------------

const CATEGORY_RE = /^[a-z][a-z-]*(\.[A-Za-z][A-Za-z-]*)?$/;

/** Canonical category or null ("CS.lg" -> "cs.LG"). */
export function normalizeCategory(value: string): string | null {
  const raw = cleanText(value).replace(/^cat:/i, "").trim();
  const m = raw.match(/^([a-zA-Z][a-zA-Z-]*)(?:\.([A-Za-z][A-Za-z-]*))?$/);
  if (!m) return null;
  const archive = m[1].toLowerCase();
  // Subject class casing: cs.LG / stat.ML are uppercase; longer physics ones (comp-ph) keep theirs.
  const sub = m[2] ? (m[2].length <= 3 ? m[2].toUpperCase() : m[2]) : undefined;
  // Dotless ids are only real for hyphenated physics archives (hep-th, quant-ph, gr-qc).
  if (!sub && !archive.includes("-")) return null;
  const out = sub ? `${archive}.${sub}` : archive;
  return CATEGORY_RE.test(out) ? out : null;
}

function uniq(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

/**
 * The model's arXiv query if it is well-formed (per `isSaneArxivQuery`, the single
 * source of truth in sources/arxiv.ts) after light cleanup -- markup stripped,
 * smart quotes straightened, lowercase boolean operators uppercased -- else a
 * query built from the plain text. Categories and date windows are left to the
 * collect stage (`planArxivQuery` adds them from `ExpandedQuery.categories`).
 */
export function arxivQueryFor(provided: string, text: string): string {
  const cleaned = cleanText(provided)
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/("[^"]*")|\b(andnot|and|or)\b/gi, (m, quoted: string | undefined, op: string | undefined) =>
      quoted ?? (op ?? "").toUpperCase(),
    )
    .replace(/\s+/g, " ")
    .trim();
  return isSaneArxivQuery(cleaned) ? cleaned : buildArxivQuery({ text });
}

/** Key for deduping queries: lowercase words, punctuation stripped, order-insensitive. */
export function queryKey(text: string): string {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function cleanTerms(values: readonly string[]): string[] {
  return uniq(values.map((t) => cleanText(t).toLowerCase().replace(/^["']|["']$/g, "").trim()).filter(Boolean)).slice(0, MAX_TERMS);
}

/** Pure post-processing of the tool input; exported for tests. */
export function normalizeExpansion(
  raw: z.output<typeof expandInputSchema>,
  input: Pick<ExpandInput, "name" | "count">,
): ExpansionResult {
  const categories = uniq(raw.categories.map(normalizeCategory).filter((c): c is string => !!c)).slice(0, MAX_CATEGORIES);
  const seen = new Set<string>([queryKey(input.name)]);
  const queries: ExpandedQuery[] = [];
  for (const q of raw.queries) {
    const text = cleanText(q.text).replace(/["]/g, "").replace(/\s+/g, " ").trim();
    const key = queryKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    const cats = uniq(q.categories.map(normalizeCategory).filter((c): c is string => !!c)).slice(0, MAX_CATEGORIES);
    const arxiv = arxivQueryFor(q.arxiv, text);
    queries.push({ text, arxiv, categories: cats });
    if (queries.length >= input.count) break;
  }
  return {
    queries,
    categories,
    mustTerms: cleanTerms(raw.mustTerms),
    excludeTerms: cleanTerms(raw.excludeTerms),
  };
}

/** Used when expansion fails: just the topic name. */
export function fallbackQueries(name: string): ExpansionResult {
  const text = cleanText(name);
  return { queries: [{ text, arxiv: buildArxivQuery({ text }), categories: [] }], categories: [], mustTerms: [], excludeTerms: [] };
}

/** One Haiku call. Throws on API/output failure; callers fall back to `fallbackQueries`. */
export async function expandQueries(
  input: ExpandInput,
  opts: { recorder?: LlmRecorder; signal?: AbortSignal } = {},
): Promise<ExpansionResult> {
  const res = await callTool({
    purpose: "expand",
    model: EXPANSION_MODEL,
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage(input) }],
    tool: EXPAND_TOOL,
    schema: expandInputSchema,
    maxTokens: 2048,
    recorder: opts.recorder,
    signal: opts.signal,
  });
  return normalizeExpansion(res.data, input);
}
