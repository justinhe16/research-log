import { z } from "zod";
import type * as S from "@/lib/db/schema";
import type { EntryRow, NewEntryRow } from "@/lib/db/schema";
import {
  CLUSTER_CHANGES,
  DEPTHS,
  DOCUMENT_KINDS,
  EDGE_KINDS,
  PAPER_ORIGINS,
  SEARCH_KINDS,
  SEARCH_STATUSES,
  STAGE_STATUSES,
  STAGES,
  type DepthConfig,
  type ExpandedQuery,
  type PaperAuthor,
  type SearchCounters,
} from "@/lib/landscape/types";

/**
 * Bumped only if the on-disk export shape changes incompatibly.
 *  - v1: `entries` only.
 *  - v2: adds the optional `landscape` section: every Landscape table except
 *    `api_cache` (a disposable HTTP cache). v1 files still parse.
 */
export const BACKUP_VERSION = 2;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64 with a shape check -- `Buffer.from` silently discards junk, which
 *  would turn a corrupted file into a silently-wrong vector. */
const base64Blob = z
  .string()
  .refine((s) => s.length % 4 === 0 && BASE64.test(s), "not valid base64");

const strArray = z.array(z.string()).nullish();

/** One entry as it appears in an export file: every column, embedding base64'd. */
export const exportEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().default(""),
  category: z.string().default("Other"),
  notes: z.string().default(""),
  whySaved: z.string().default(""),
  status: z.string().default("to-read"),
  rating: z.number().int().nullish(),

  title: z.string().default(""),
  summary: z.string().default(""),
  keyClaims: strArray,
  tags: strArray,
  authors: strArray,
  org: z.string().nullish(),
  venue: z.string().nullish(),
  publishedAt: z.string().nullish(),
  contentType: z.string().default("other"),

  /** base64 of the raw Float32Array bytes, or null if never embedded. */
  embedding: base64Blob.nullish(),
  rawText: z.string().nullish(),
  ingestStatus: z.string().default("pending"),
  ingestError: z.string().nullish(),

  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ExportEntry = z.infer<typeof exportEntrySchema>;

// ---------------------------------------------------------------------------
// Landscape (v2)
// ---------------------------------------------------------------------------
//
// Each table is exported as its drizzle row (camelCase keys), with BLOB columns
// base64'd and JSON columns inlined as JSON. Schemas are structural: required
// columns must be present and well-typed, unknown extra keys are ignored
// (stripped), and columns with a DB default may be omitted.

const id = z.string().min(1);
const nstr = z.string().nullish();
const nint = z.number().int().nullish();
const nnum = z.number().nullish();
const ts = z.string().optional();
const intDefault0 = z.number().int().default(0);

export const exportTopicSchema = z.object({
  id,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  embedding: base64Blob.nullish(),
  defaultDepth: z.enum(DEPTHS).default("standard"),
  summary: nstr,
  lastSearchId: nstr,
  lastSearchAt: nstr,
  paperCount: intDefault0,
  createdAt: ts,
  updatedAt: ts,
});

const authorSchema = z.looseObject({ name: z.string() });

export const exportPaperSchema = z.object({
  id,
  arxivId: nstr,
  doi: nstr,
  s2Id: nstr,
  openalexId: nstr,
  normTitle: z.string().default(""),
  title: z.string(),
  abstract: nstr,
  authors: z.array(authorSchema).default([]),
  year: nint,
  publishedAt: nstr,
  venue: nstr,
  arxivUrl: nstr,
  pdfUrl: nstr,
  citationCount: nint,
  influentialCitationCount: nint,
  maxAuthorHIndex: nint,
  metricsUpdatedAt: nstr,
  embedding: base64Blob.nullish(),
  createdAt: ts,
  updatedAt: ts,
});

export const exportPaperFulltextSchema = z.object({
  paperId: id,
  text: z.string(),
  source: z.string(),
  sourceUrl: nstr,
  hash: z.string(),
  truncated: z.boolean().default(false),
  fetchedAt: ts,
});

export const exportPaperCitationSchema = z.object({
  citingId: id,
  citedId: id,
  isInfluential: z.boolean().default(false),
  intents: z.array(z.string()).default([]),
  createdAt: ts,
});

export const exportPaperExtractionSchema = z.object({
  id,
  paperId: id,
  version: z.number().int(),
  source: z.enum(["abstract", "fulltext"]),
  sourceHash: z.string(),
  model: z.string(),
  problem: z.string().default(""),
  method: z.string().default(""),
  results: z.string().default(""),
  contribution: z.string().default(""),
  limitations: nstr,
  datasets: z.array(z.string()).default([]),
  benchmarks: z.array(z.string()).default([]),
  createdAt: ts,
});

export const exportSearchSchema = z.object({
  id,
  topicId: id,
  kind: z.enum(SEARCH_KINDS).default("initial"),
  baseSearchId: nstr,
  depth: z.enum(DEPTHS),
  config: z.record(z.string(), z.unknown()),
  queries: z.array(z.unknown()).default([]),
  since: nstr,
  status: z.enum(SEARCH_STATUSES).default("queued"),
  stage: z.enum(STAGES).nullish(),
  progress: z.number().default(0),
  counters: z.record(z.string(), z.unknown()).default({}),
  error: nstr,
  cancelRequested: z.boolean().default(false),
  inputTokens: intDefault0,
  outputTokens: intDefault0,
  cacheReadTokens: intDefault0,
  cacheWriteTokens: intDefault0,
  costUsd: z.number().default(0),
  createdAt: ts,
  startedAt: nstr,
  finishedAt: nstr,
  heartbeatAt: nstr,
});

export const exportSearchStageSchema = z.object({
  searchId: id,
  stage: z.enum(STAGES),
  status: z.enum(STAGE_STATUSES).default("pending"),
  checkpoint: z.record(z.string(), z.unknown()).nullish(),
  error: nstr,
  startedAt: nstr,
  finishedAt: nstr,
});

export const exportSearchPaperSchema = z.object({
  searchId: id,
  paperId: id,
  origin: z.enum(PAPER_ORIGINS),
  sourceRank: nint,
  queryHits: z.array(z.number()).default([]),
  bm25: nnum,
  cosine: nnum,
  rrf: nnum,
  rerank: nnum,
  finalRank: nint,
  selected: z.boolean().default(false),
  foundational: z.boolean().default(false),
  citationCount: nint,
  influentialCitationCount: nint,
  velocity: nnum,
  pagerank: nnum,
  maxAuthorHIndex: nint,
  influence: nnum,
  clusterIdx: nint,
  extractionId: nstr,
  gameChanger: z.boolean().default(false),
});

export const exportSearchClusterSchema = z.object({
  searchId: id,
  idx: z.number().int(),
  label: z.string(),
  summary: nstr,
  keyTerms: z.array(z.string()).default([]),
  centroid: base64Blob.nullish(),
  size: z.number().int(),
  yearMin: nint,
  yearMax: nint,
  baseClusterIdx: nint,
  change: z.enum(CLUSTER_CHANGES).nullish(),
});

export const exportSearchEdgeSchema = z.object({
  searchId: id,
  sourceId: id,
  targetId: id,
  kind: z.enum(EDGE_KINDS),
  weight: z.number().default(1),
});

export const exportSearchDocumentSchema = z.object({
  searchId: id,
  kind: z.enum(DOCUMENT_KINDS),
  status: z.enum(["done", "error"]).default("done"),
  data: z.unknown().optional(),
  error: nstr,
  model: nstr,
  createdAt: ts,
  updatedAt: ts,
});

export const exportLlmCallSchema = z.object({
  id,
  searchId: nstr,
  stage: z.enum(STAGES).nullish(),
  purpose: z.string(),
  model: z.string(),
  inputTokens: intDefault0,
  outputTokens: intDefault0,
  cacheReadTokens: intDefault0,
  cacheWriteTokens: intDefault0,
  costUsd: z.number().default(0),
  durationMs: intDefault0,
  ok: z.boolean().default(true),
  error: nstr,
  createdAt: ts,
});

const list = <T extends z.ZodType>(schema: T) => z.array(schema).default([]);

export const exportLandscapeSchema = z.object({
  topics: list(exportTopicSchema),
  searches: list(exportSearchSchema),
  searchStages: list(exportSearchStageSchema),
  papers: list(exportPaperSchema),
  /** Absent when exported with `?fulltext=0`. */
  paperFulltext: z.array(exportPaperFulltextSchema).optional(),
  paperCitations: list(exportPaperCitationSchema),
  paperExtractions: list(exportPaperExtractionSchema),
  searchPapers: list(exportSearchPaperSchema),
  searchClusters: list(exportSearchClusterSchema),
  searchEdges: list(exportSearchEdgeSchema),
  searchDocuments: list(exportSearchDocumentSchema),
  llmCalls: list(exportLlmCallSchema),
});

export type ExportLandscape = z.infer<typeof exportLandscapeSchema>;

export const exportFileSchema = z.object({
  version: z.number().int().positive(),
  exportedAt: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  entries: z.array(exportEntrySchema),
  landscape: exportLandscapeSchema.optional(),
});

export type ParsedExportFile = z.infer<typeof exportFileSchema>;

export type EncodedEntry = Omit<EntryRow, "embedding"> & { embedding: string | null };

type Encoded<T, K extends keyof T> = Omit<T, K> & { [P in K]: string | null };

export type EncodedLandscape = {
  topics: Encoded<S.TopicRow, "embedding">[];
  searches: S.SearchRow[];
  searchStages: S.SearchStageRow[];
  papers: Encoded<S.PaperRow, "embedding">[];
  paperFulltext?: S.PaperFulltextRow[];
  paperCitations: S.PaperCitationRow[];
  paperExtractions: S.PaperExtractionRow[];
  searchPapers: S.SearchPaperRow[];
  searchClusters: Encoded<S.SearchClusterRow, "centroid">[];
  searchEdges: S.SearchEdgeRow[];
  searchDocuments: S.SearchDocumentRow[];
  llmCalls: S.LlmCallRow[];
};

export type ExportFile = {
  version: number;
  exportedAt: string;
  count: number;
  entries: EncodedEntry[];
  landscape?: EncodedLandscape;
};

function encodeBlob(b: Buffer | Uint8Array | null | undefined): string | null {
  return b ? Buffer.from(b).toString("base64") : null;
}

function decodeBlob(s: string | null | undefined): Buffer | null {
  return s ? Buffer.from(s, "base64") : null;
}

/** DB row -> JSON-safe export record. The embedding blob is base64'd so it
 *  survives the round trip; losing it would mean re-embedding everything. */
export function encodeEntry(row: EntryRow): EncodedEntry {
  const { embedding, ...rest } = row;
  return {
    ...rest,
    keyClaims: rest.keyClaims ?? [],
    tags: rest.tags ?? [],
    authors: rest.authors ?? [],
    embedding: encodeBlob(embedding),
  };
}

/** Export record -> DB row. Missing embeddings stay null (see scripts/reembed.ts). */
export function decodeEntry(input: ExportEntry): NewEntryRow {
  const now = new Date().toISOString();
  return {
    id: input.id,
    url: input.url,
    category: input.category,
    notes: input.notes,
    whySaved: input.whySaved,
    status: input.status,
    rating: input.rating ?? null,

    title: input.title,
    summary: input.summary,
    keyClaims: input.keyClaims ?? [],
    tags: input.tags ?? [],
    authors: input.authors ?? [],
    org: input.org ?? null,
    venue: input.venue ?? null,
    publishedAt: input.publishedAt ?? null,
    contentType: input.contentType,

    embedding: decodeBlob(input.embedding),
    rawText: input.rawText ?? null,
    ingestStatus: input.ingestStatus,
    ingestError: input.ingestError ?? null,

    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

// --- Landscape encoders (DB row -> export record) ---------------------------

export function encodeTopic(row: S.TopicRow): EncodedLandscape["topics"][number] {
  return { ...row, embedding: encodeBlob(row.embedding) };
}

export function encodePaper(row: S.PaperRow): EncodedLandscape["papers"][number] {
  return { ...row, embedding: encodeBlob(row.embedding) };
}

export function encodeSearchCluster(row: S.SearchClusterRow): EncodedLandscape["searchClusters"][number] {
  return { ...row, centroid: encodeBlob(row.centroid) };
}

// --- Landscape decoders (validated export record -> insertable row) ---------
// Every timestamp the file omits is filled with one explicit ISO string rather
// than SQLite's CURRENT_TIMESTAMP, which uses a different format.

type Parsed<T extends z.ZodType> = z.infer<T>;

export function decodeTopic(t: Parsed<typeof exportTopicSchema>, now: string): S.NewTopicRow {
  return { ...t, embedding: decodeBlob(t.embedding), createdAt: t.createdAt ?? now, updatedAt: t.updatedAt ?? now };
}

export function decodePaper(p: Parsed<typeof exportPaperSchema>, now: string): S.NewPaperRow {
  return {
    ...p,
    authors: p.authors as PaperAuthor[],
    embedding: decodeBlob(p.embedding),
    createdAt: p.createdAt ?? now,
    updatedAt: p.updatedAt ?? now,
  };
}

export function decodePaperFulltext(
  f: Parsed<typeof exportPaperFulltextSchema>,
  now: string,
): typeof S.paperFulltext.$inferInsert {
  return { ...f, fetchedAt: f.fetchedAt ?? now };
}

export function decodePaperCitation(
  c: Parsed<typeof exportPaperCitationSchema>,
  now: string,
): typeof S.paperCitations.$inferInsert {
  return { ...c, createdAt: c.createdAt ?? now };
}

export function decodePaperExtraction(
  e: Parsed<typeof exportPaperExtractionSchema>,
  now: string,
): S.NewPaperExtractionRow {
  return { ...e, createdAt: e.createdAt ?? now };
}

export function decodeSearch(s: Parsed<typeof exportSearchSchema>, now: string): S.NewSearchRow {
  return {
    ...s,
    config: s.config as DepthConfig,
    queries: s.queries as ExpandedQuery[],
    counters: s.counters as SearchCounters,
    createdAt: s.createdAt ?? now,
  };
}

export function decodeSearchStage(s: Parsed<typeof exportSearchStageSchema>): typeof S.searchStages.$inferInsert {
  return { ...s };
}

export function decodeSearchPaper(p: Parsed<typeof exportSearchPaperSchema>): S.NewSearchPaperRow {
  return { ...p };
}

export function decodeSearchCluster(
  c: Parsed<typeof exportSearchClusterSchema>,
): typeof S.searchClusters.$inferInsert {
  return { ...c, centroid: decodeBlob(c.centroid) };
}

export function decodeSearchEdge(e: Parsed<typeof exportSearchEdgeSchema>): typeof S.searchEdges.$inferInsert {
  return { ...e };
}

export function decodeSearchDocument(
  d: Parsed<typeof exportSearchDocumentSchema>,
  now: string,
): typeof S.searchDocuments.$inferInsert {
  return { ...d, data: d.data ?? null, createdAt: d.createdAt ?? now, updatedAt: d.updatedAt ?? now };
}

export function decodeLlmCall(c: Parsed<typeof exportLlmCallSchema>, now: string): S.NewLlmCallRow {
  return { ...c, createdAt: c.createdAt ?? now };
}

/** Parse an unknown blob of JSON as an export file, or throw a readable error.
 *  Accepts v1 (entries only) and v2 (optional `landscape`); rejects newer. */
export function parseExportFile(data: unknown): ParsedExportFile {
  // Check the version before the shape, so a future file gets the helpful error
  // rather than a complaint about some field it renamed.
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version === "number" && Number.isInteger(version) && version > BACKUP_VERSION) {
    throw new Error(`Backup version ${version} is newer than this app supports (${BACKUP_VERSION})`);
  }
  // v1 predates Landscape: a stray `landscape` key is an unknown extra field.
  const input =
    typeof version === "number" && version < 2 && data && typeof data === "object"
      ? { ...(data as Record<string, unknown>), landscape: undefined }
      : data;
  const result = exportFileSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at \`${issue.path.join(".")}\`` : "";
    throw new Error(`Malformed backup file${where}: ${issue?.message ?? "unknown error"}`);
  }
  return result.data;
}
