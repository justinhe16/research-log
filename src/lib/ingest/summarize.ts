import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CATEGORIES, CONTENT_TYPES, SUMMARY_MODEL } from "@/lib/constants";
import type { ExtractedContent } from "./extract";

export type Extraction = {
  title: string;
  summary: string;
  keyClaims: string[];
  tags: string[];
  authors: string[];
  org: string | null;
  venue: string | null;
  publishedAt: string | null;
  contentType: string;
  category: string;
};

const MAX_PROMPT_CHARS = 30_000;
const TOOL_NAME = "record_analysis";
const MAX_KEY_CLAIMS = 8;
const MAX_TAGS = 15;

/** The model is told to return arrays, and usually does -- but it intermittently
 *  serializes them as a JSON string ('["a","b"]') or a delimited string instead.
 *  Rejecting that outright fails an otherwise perfectly good analysis, so coerce.
 *
 *  `commaSplit` is off for prose: claim sentences legitimately contain commas, so
 *  those only ever split on line/bullet boundaries. */
export function toStringArray(value: unknown, commaSplit: boolean): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;

  const raw = value.trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON after all -- fall through to delimiter splitting.
    }
  }

  const lines = raw.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  const parts = lines.length > 1 || !commaSplit ? lines : raw.split(/[,;]+/);

  return parts
    .map((part) => part.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

const prose = (v: unknown) => toStringArray(v, false);
const keywords = (v: unknown) => toStringArray(v, true);

/** The model sometimes fills an optional field with the *string* "null" (or
 *  "none"/"n/a") instead of omitting it. Persisting that means every consumer
 *  has to defend against it, so normalize to a real null at the boundary. */
const NOT_A_VALUE = new Set(["null", "undefined", "none", "n/a", "na", "unknown", "-", ""]);

function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return NOT_A_VALUE.has(trimmed.toLowerCase()) ? null : trimmed;
}

const extractionSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  // Counts are intentionally unbounded here and sliced after parsing: an extra
  // claim or tag is not a reason to throw away the whole analysis.
  keyClaims: z.preprocess(prose, z.array(z.string().min(1)).min(1)),
  tags: z.preprocess(keywords, z.array(z.string().min(1)).min(1)),
  authors: z.preprocess(keywords, z.array(z.string().min(1))).default([]),
  org: z.string().nullish().transform(nullableText),
  venue: z.string().nullish().transform(nullableText),
  publishedAt: z.string().nullish().transform(nullableText),
  contentType: z.enum(CONTENT_TYPES),
  category: z.enum(CATEGORIES),
});

/** JSON Schema handed to the model. Kept in lockstep with `extractionSchema`. */
const inputSchema = {
  type: "object" as const,
  properties: {
    title: { type: "string", description: "The canonical title of the piece. No site name, no boilerplate." },
    summary: {
      type: "string",
      description:
        "Either 2 short paragraphs OR 4-6 tight bullets (one per line, prefixed '- '). Information-dense. Start with the substance; never open with filler like 'This paper discusses' or 'The article explores'.",
    },
    keyClaims: {
      type: "array",
      items: { type: "string" },
      description:
        "3-5 atomic factual claims the piece actually makes. Each a single self-contained sentence, specific enough to be argued with (include numbers/results where given).",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description:
        "5-10 lowercase normalized topic keywords, hyphenated where multi-word (e.g. 'sparse-autoencoders', 'rlhf', 'scaling-laws'). No punctuation, no duplicates.",
    },
    authors: { type: "array", items: { type: "string" }, description: "Author names, best effort. Empty array if unknown." },
    org: { type: "string", description: "Publishing organization or lab, or null if unknown." },
    venue: { type: "string", description: "Conference/journal/publication venue, or null if unknown." },
    publishedAt: { type: "string", description: "ISO 8601 date (YYYY-MM-DD) if determinable, else null." },
    contentType: { type: "string", enum: [...CONTENT_TYPES], description: "What kind of artifact this is." },
    category: { type: "string", enum: [...CATEGORIES], description: "Best-fit research area. Use 'Other' only if none fit." },
  },
  required: ["title", "summary", "keyClaims", "tags", "authors", "contentType", "category"],
};

const SYSTEM = `You are the indexing engine for a personal AI-research reading log.
You read a fetched web page or paper and record a compact, high-signal analysis of it.

Rules:
- Be succinct and information-dense. The reader is technical and already knows the field.
- No preamble, no hedging, no meta-commentary about the document.
- Prefer concrete specifics (methods, numbers, results, names) over generic description.
- If the text is truncated mid-document, summarize what is present; do not speculate about the rest.
- Never invent authors, venues, dates, or results that are not supported by the text.
Always answer by calling the ${TOOL_NAME} tool.`;

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add a real key to .env.local (get one at https://console.anthropic.com/settings/keys) and restart the dev server.",
    );
  }
  if (key === "sk-ant-..." || /^sk-ant-\.{3,}$/.test(key) || /^(your|placeholder|changeme)/i.test(key)) {
    throw new Error(
      "ANTHROPIC_API_KEY is still the placeholder value. Replace it in .env.local with a real key from https://console.anthropic.com/settings/keys and restart the dev server.",
    );
  }
  return key;
}

function buildUserMessage(content: ExtractedContent): string {
  const known = [
    `URL: ${content.url}`,
    content.title && `Extracted title: ${content.title}`,
    content.authors.length && `Extracted authors: ${content.authors.join(", ")}`,
    content.publishedAt && `Extracted publish date: ${content.publishedAt}`,
    content.venue && `Extracted venue: ${content.venue}`,
    content.org && `Extracted org/site: ${content.org}`,
    `Detected content type (a guess -- override it if the text says otherwise): ${content.contentType}`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = content.text.slice(0, MAX_PROMPT_CHARS);
  const truncated = content.text.length > MAX_PROMPT_CHARS ? "\n\n[text truncated]" : "";

  return `Metadata already extracted from the source (trust it over your own guess where it is present):
${known}

<document>
${text}${truncated}
</document>

Record your analysis with the ${TOOL_NAME} tool.`;
}

/** Ask Claude for a structured analysis of extracted content. */
export async function summarize(content: ExtractedContent): Promise<Extraction> {
  const client = new Anthropic({ apiKey: apiKey() });

  const res = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    tools: [
      {
        name: TOOL_NAME,
        description: "Record the structured analysis of the document.",
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildUserMessage(content) }],
  });

  const block = res.content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
  if (!block || block.type !== "tool_use") {
    throw new Error(
      `The model did not call ${TOOL_NAME} (stop_reason: ${res.stop_reason}). Nothing to record.`,
    );
  }

  const parsed = extractionSchema.safeParse(block.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`The model returned an analysis that failed validation -- ${issues}`);
  }

  const data = parsed.data;
  return {
    ...data,
    // Prefer metadata we scraped directly over anything the model inferred.
    authors: content.authors.length ? content.authors : data.authors,
    publishedAt: content.publishedAt ?? data.publishedAt,
    venue: content.venue ?? data.venue,
    org: content.org ?? data.org,
    keyClaims: data.keyClaims.slice(0, MAX_KEY_CLAIMS),
    tags: Array.from(new Set(data.tags.map((t) => t.toLowerCase().trim())))
      .filter(Boolean)
      .slice(0, MAX_TAGS),
  };
}
