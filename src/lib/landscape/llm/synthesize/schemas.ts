import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { keywords, nullableText, prose, toNumber, toObject, toObjectArray } from "@/lib/llm/coerce";
import { CLUSTER_CHANGES } from "@/lib/landscape/types";

/*
 * Synthesis document schemas, in two forms:
 *
 *  - LLM-facing (`*Input` / `*_TOOL`): what the model sends through a forced tool
 *    call. Papers are referenced by dossier refs ("P12"). Lenient: coerces the
 *    model's usual deviations (stringified arrays, "p12", "[P12]", "null").
 *  - Stored (`*Document`): what lands in `search_documents.data` and the snapshot.
 *    Refs have been resolved to `paperId`s (unknown refs dropped) and every string
 *    has gone through cleanText/cleanMultiline. Strict: re-validated on read.
 *
 * The tool JSON schemas are hand-written and kept in lockstep with the zod input
 * schemas, same as `summarize.ts`. Count limits live in the prompt / description
 * and are sliced after parsing -- one extra tension is not a reason to fail a call.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Canonicalize a dossier ref: "p12", "[P12]", "P 12", "ref P12" -> "P12". Returns
 *  the trimmed input unchanged when it doesn't look like a ref so the resolver can
 *  count it as invalid. */
export function normalizeRef(value: string): string {
  const m = value.match(/\bP\s*[-#]?\s*(\d+)\b/i);
  return m ? `P${Number(m[1])}` : value.trim();
}

export const REF_RE = /^P\d+$/;

const ref = z.string().transform(normalizeRef);
const refList = z.preprocess(keywords, z.array(z.string().transform(normalizeRef)));
const text = z.string().min(1);
const optionalText = z.string().nullish().transform((v) => nullableText(v));
const textList = z.preprocess(prose, z.array(z.string().min(1)));
const objects = <T extends z.ZodType>(item: T) => z.preprocess(toObjectArray, z.array(item));
const year = z.preprocess(toNumber, z.number().int().min(1900).max(2100));

export const READING_PHASES = ["foundations", "core", "frontier"] as const;
export type ReadingPhase = (typeof READING_PHASES)[number];

const phase = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const p = v.trim().toLowerCase().replace(/[\s_-]*methods?$/, "");
    return p === "foundation" || p === "foundational" ? "foundations" : p;
  },
  z.enum(READING_PHASES),
);

/**
 * frontier is an object, but Sonnet 5 usually sends it as plain prose with the refs
 * inline ("... P12's iSAE, P5's Ordered SAEs ..."). Keep the prose as the summary and
 * lift the inline refs, in order of first mention.
 */
export function toFrontier(value: unknown): unknown {
  const v = toObject(value);
  if (typeof v !== "string") return v;
  const summary = v.trim();
  if (!summary) return v;
  const refs = Array.from(new Set(Array.from(summary.matchAll(/\bP\s*(\d+)\b/g), (m) => `P${Number(m[1])}`)));
  return { summary, refs };
}

const paperId = z.string().min(1);
const paperIds = z.array(paperId);

// ---------------------------------------------------------------------------
// S1: clusters
// ---------------------------------------------------------------------------

export const clustersInputSchema = z.object({
  topicSummary: text,
  clusters: objects(
    z.object({
      /** Echoes the cluster idx given in the dossier. */
      idx: z.preprocess(toNumber, z.number().int().min(0)),
      name: text,
      summary: text,
      keyIdeas: textList,
      representativeRefs: refList,
    }),
  ),
});
export type ClustersInput = z.output<typeof clustersInputSchema>;

export const clustersDocumentSchema = z.object({
  topicSummary: z.string(),
  clusters: z.array(
    z.object({
      idx: z.number().int().min(0),
      name: z.string(),
      summary: z.string(),
      keyIdeas: z.array(z.string()),
      representativePaperIds: paperIds,
    }),
  ),
});
export type ClustersDocument = z.infer<typeof clustersDocumentSchema>;

// ---------------------------------------------------------------------------
// S2: tensions
// ---------------------------------------------------------------------------

const tensionInput = z.object({
  title: text,
  description: text,
  positions: objects(z.object({ stance: text, refs: refList })),
  clusterIdxs: z.preprocess(keywords, z.array(z.preprocess(toNumber, z.number().int().min(0)))).default([]),
});

export const tensionsInputSchema = z.object({ tensions: objects(tensionInput) });
export type TensionsInput = z.output<typeof tensionsInputSchema>;

const tensionDocument = z.object({
  title: z.string(),
  description: z.string(),
  positions: z.array(z.object({ stance: z.string(), paperIds })),
  clusterIdxs: z.array(z.number().int()),
});

export const tensionsDocumentSchema = z.object({ tensions: z.array(tensionDocument) });
export type TensionsDocument = z.infer<typeof tensionsDocumentSchema>;
export type Tension = z.infer<typeof tensionDocument>;

// ---------------------------------------------------------------------------
// S3: gaps
// ---------------------------------------------------------------------------

const gapInput = z.object({
  title: text,
  description: text,
  /** Why we believe it's a gap, grounded in the dossier. */
  evidence: text,
  evidenceRefs: refList,
  directions: textList,
});

export const gapsInputSchema = z.object({ gaps: objects(gapInput) });
export type GapsInput = z.output<typeof gapsInputSchema>;

const gapDocument = z.object({
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  evidencePaperIds: paperIds,
  directions: z.array(z.string()),
});

export const gapsDocumentSchema = z.object({ gaps: z.array(gapDocument) });
export type GapsDocument = z.infer<typeof gapsDocumentSchema>;
export type Gap = z.infer<typeof gapDocument>;

/** Quick depth: S2 + S3 in one call. Stored as two separate documents. */
export const tensionsGapsInputSchema = z.object({
  tensions: objects(tensionInput),
  gaps: objects(gapInput),
});
export type TensionsGapsInput = z.output<typeof tensionsGapsInputSchema>;

// ---------------------------------------------------------------------------
// S4: narrative
// ---------------------------------------------------------------------------

const narrativeFields = {
  eras: objects(
    z.object({
      label: text,
      startYear: year,
      /** null = ongoing. */
      endYear: z.preprocess(toNumber, z.number().int().min(1900).max(2100).nullable()).default(null),
      summary: text,
      /** The papers this era was built on. */
      keyRefs: refList,
    }),
  ),
  gameChangers: objects(
    z.object({
      ref,
      why: text,
      /** Must cite the dossier metrics (citations, velocity, pagerank...). */
      evidence: text,
    }),
  ),
  frontier: z.preprocess(toFrontier, z.object({ summary: text, refs: refList })),
  outlook: text,
  /** Refresh only: what changed since the base search. */
  whatChanged: optionalText,
};

export const narrativeInputSchema = z.object(narrativeFields);
export type NarrativeInput = z.output<typeof narrativeInputSchema>;

export const narrativeDocumentSchema = z.object({
  eras: z.array(
    z.object({
      label: z.string(),
      startYear: z.number().int(),
      endYear: z.number().int().nullable(),
      summary: z.string(),
      keyPaperIds: paperIds,
    }),
  ),
  gameChangers: z.array(z.object({ paperId, why: z.string(), evidence: z.string() })),
  frontier: z.object({ summary: z.string(), paperIds }),
  outlook: z.string(),
  whatChanged: z.string().nullable(),
});
export type NarrativeDocument = z.infer<typeof narrativeDocumentSchema>;

// ---------------------------------------------------------------------------
// S5: reading path
// ---------------------------------------------------------------------------

const readingStepInput = z.object({ phase, ref, reason: text });

export const readingPathInputSchema = z.object({ steps: objects(readingStepInput) });
export type ReadingPathInput = z.output<typeof readingPathInputSchema>;

export const readingPathDocumentSchema = z.object({
  steps: z.array(z.object({ phase: z.enum(READING_PHASES), paperId, reason: z.string() })),
});
export type ReadingPathDocument = z.infer<typeof readingPathDocumentSchema>;

/** Quick depth: S4 + S5 in one call. Stored as two separate documents. */
export const narrativePathInputSchema = z.object({
  ...narrativeFields,
  readingPath: objects(readingStepInput),
});
export type NarrativePathInput = z.output<typeof narrativePathInputSchema>;

// ---------------------------------------------------------------------------
// Diff (computed, not LLM-authored)
// ---------------------------------------------------------------------------

export const diffDocumentSchema = z.object({
  baseSearchId: z.string(),
  /** Base search's start; papers published after it count as "new since". */
  since: z.string().nullable(),
  newPaperIds: paperIds,
  droppedPaperIds: paperIds,
  rising: z.array(
    z.object({
      paperId,
      citationsBefore: z.number().int(),
      citationsAfter: z.number().int(),
      delta: z.number().int(),
    }),
  ),
  clusterChanges: z.array(
    z.object({
      /** Cluster idx in this search; null for "gone". */
      idx: z.number().int().nullable(),
      /** Matched idx(s) in the base search; empty for "new". Several for "merged". */
      baseIdxs: z.array(z.number().int()),
      change: z.enum(CLUSTER_CHANGES),
      label: z.string(),
      sizeBefore: z.number().int(),
      sizeAfter: z.number().int(),
    }),
  ),
});
export type DiffDocument = z.infer<typeof diffDocumentSchema>;

/** Stored-document validator per kind, for reads from `search_documents`. */
export const DOCUMENT_SCHEMAS = {
  clusters: clustersDocumentSchema,
  tensions: tensionsDocumentSchema,
  gaps: gapsDocumentSchema,
  narrative: narrativeDocumentSchema,
  reading_path: readingPathDocumentSchema,
  diff: diffDocumentSchema,
} as const;

// ---------------------------------------------------------------------------
// Anthropic tool definitions
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const S = (description: string): JsonSchema => ({ type: "string", description });
const refsSchema = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string", pattern: "^P\\d+$" },
  description: `${description} Dossier refs exactly as given, e.g. "P12". Only refs that appear in the dossier.`,
});
const stringsSchema = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  description: `${description} Each element plain text, no bullets or markup.`,
});

const tensionItemSchema: JsonSchema = {
  type: "object",
  properties: {
    title: S("Short name of the disagreement, e.g. 'Scale vs. data quality'."),
    description: S("1-3 sentences: what is contested and why it matters."),
    positions: {
      type: "array",
      description: "2-3 opposing positions.",
      items: {
        type: "object",
        properties: {
          stance: S("One sentence stating the position."),
          refs: refsSchema("Papers that hold or evidence this position."),
        },
        required: ["stance", "refs"],
      },
    },
    clusterIdxs: { type: "array", items: { type: "integer" }, description: "Cluster idxs involved." },
  },
  required: ["title", "description", "positions"],
};

const gapItemSchema: JsonSchema = {
  type: "object",
  properties: {
    title: S("Short name of the open problem."),
    description: S("1-3 sentences describing what is missing."),
    evidence: S("Why this is a gap, grounded in the dossier (e.g. no paper evaluates X; all Y results are on Z)."),
    evidenceRefs: refsSchema("Papers that make the gap visible."),
    directions: stringsSchema("1-3 concrete research directions."),
  },
  required: ["title", "description", "evidence", "evidenceRefs", "directions"],
};

const narrativeProperties: JsonSchema = {
  eras: {
    type: "array",
    description: "2-5 chronological eras, oldest first. Phrase each as what the field was built on then.",
    items: {
      type: "object",
      properties: {
        label: S("Short era name, e.g. 'Dictionary learning on toy models'."),
        startYear: { type: "integer" },
        endYear: { type: ["integer", "null"], description: "null if the era is ongoing." },
        summary: S("2-3 sentences: the ideas this era rested on and what displaced them."),
        keyRefs: refsSchema("The papers the era was built on."),
      },
      required: ["label", "startYear", "endYear", "summary", "keyRefs"],
    },
  },
  gameChangers: {
    type: "array",
    description: "Up to 5 papers that shifted the field. Prefer the listed game-changer candidates.",
    items: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^P\\d+$", description: "Dossier ref." },
        why: S("One or two sentences on what it changed."),
        evidence: S("Grounding in the dossier metrics shown on the card: citations, velocity, influential citations, pagerank (only if shown), builds_on in-degree."),
      },
      required: ["ref", "why", "evidence"],
    },
  },
  frontier: {
    type: "object",
    properties: {
      summary: S("2-4 sentences on where the active frontier is now."),
      refs: refsSchema("The papers defining the frontier."),
    },
    required: ["summary", "refs"],
  },
  outlook: S("2-3 sentences on where the field is likely heading."),
  whatChanged: {
    type: ["string", "null"],
    description: "Only when a diff is provided: 2-4 sentences on what changed since the previous search. Otherwise null.",
  },
};

const readingStepSchema: JsonSchema = {
  type: "object",
  properties: {
    phase: { type: "string", enum: [...READING_PHASES] },
    ref: { type: "string", pattern: "^P\\d+$", description: "Dossier ref." },
    reason: S("One sentence: why read this, and what to get out of it."),
  },
  required: ["phase", "ref", "reason"],
};

const readingPathProperty: JsonSchema = {
  type: "array",
  description: "8-15 ordered steps: foundations first, then core methods, then frontier. Each paper at most once.",
  items: readingStepSchema,
};

function tool(name: string, description: string, properties: JsonSchema, required: string[]): Anthropic.Tool {
  return { name, description, input_schema: { type: "object", properties, required } };
}

export const CLUSTERS_TOOL = tool(
  "record_clusters",
  "Record the topic summary and a name, summary, key ideas and representative papers for every cluster.",
  {
    topicSummary: S("3-5 sentence overview of the whole landscape. Plain text."),
    clusters: {
      type: "array",
      description: "Exactly one entry per cluster in the dossier.",
      items: {
        type: "object",
        properties: {
          idx: { type: "integer", description: "The cluster idx from the dossier." },
          name: S("2-5 word cluster name."),
          summary: S("2-3 sentences on what unites this cluster."),
          keyIdeas: stringsSchema("3-5 key ideas."),
          representativeRefs: refsSchema("2-4 most representative papers in this cluster."),
        },
        required: ["idx", "name", "summary", "keyIdeas", "representativeRefs"],
      },
    },
  },
  ["topicSummary", "clusters"],
);

export const TENSIONS_TOOL = tool(
  "record_tensions",
  "Record 3-6 genuine tensions or disagreements in the landscape.",
  { tensions: { type: "array", items: tensionItemSchema, description: "3-6 tensions." } },
  ["tensions"],
);

export const GAPS_TOOL = tool(
  "record_gaps",
  "Record 3-6 open gaps with evidence and research directions.",
  { gaps: { type: "array", items: gapItemSchema, description: "3-6 gaps." } },
  ["gaps"],
);

export const TENSIONS_GAPS_TOOL = tool(
  "record_tensions_and_gaps",
  "Record 3-6 tensions and 3-6 open gaps in the landscape.",
  {
    tensions: { type: "array", items: tensionItemSchema, description: "3-6 tensions." },
    gaps: { type: "array", items: gapItemSchema, description: "3-6 gaps." },
  },
  ["tensions", "gaps"],
);

export const NARRATIVE_TOOL = tool(
  "record_narrative",
  "Record the field's eras, game-changing papers, current frontier and outlook.",
  narrativeProperties,
  ["eras", "gameChangers", "frontier", "outlook", "whatChanged"],
);

export const READING_PATH_TOOL = tool(
  "record_reading_path",
  "Record an ordered reading path through the landscape.",
  { steps: readingPathProperty },
  ["steps"],
);

export const NARRATIVE_PATH_TOOL = tool(
  "record_narrative_and_reading_path",
  "Record the field's eras, game-changers, frontier, outlook, and an ordered reading path.",
  { ...narrativeProperties, readingPath: readingPathProperty },
  ["eras", "gameChangers", "frontier", "outlook", "whatChanged", "readingPath"],
);
