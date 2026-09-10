import { z } from "zod";
import type { EntryRow, NewEntryRow } from "@/lib/db/schema";

/** Bumped only if the on-disk export shape changes incompatibly. */
export const BACKUP_VERSION = 1;

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

export const exportFileSchema = z.object({
  version: z.number().int().positive(),
  exportedAt: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  entries: z.array(exportEntrySchema),
});

export type ExportFile = {
  version: number;
  exportedAt: string;
  count: number;
  entries: EncodedEntry[];
};

export type EncodedEntry = Omit<EntryRow, "embedding"> & { embedding: string | null };

/** DB row -> JSON-safe export record. The embedding blob is base64'd so it
 *  survives the round trip; losing it would mean re-embedding everything. */
export function encodeEntry(row: EntryRow): EncodedEntry {
  const { embedding, ...rest } = row;
  return {
    ...rest,
    keyClaims: rest.keyClaims ?? [],
    tags: rest.tags ?? [],
    authors: rest.authors ?? [],
    embedding: embedding ? Buffer.from(embedding).toString("base64") : null,
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

    embedding: input.embedding ? Buffer.from(input.embedding, "base64") : null,
    rawText: input.rawText ?? null,
    ingestStatus: input.ingestStatus,
    ingestError: input.ingestError ?? null,

    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

/** Parse an unknown blob of JSON as an export file, or throw a readable error. */
export function parseExportFile(data: unknown): z.infer<typeof exportFileSchema> {
  const result = exportFileSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at \`${issue.path.join(".")}\`` : "";
    throw new Error(`Malformed backup file${where}: ${issue?.message ?? "unknown error"}`);
  }
  if (result.data.version > BACKUP_VERSION) {
    throw new Error(
      `Backup version ${result.data.version} is newer than this app supports (${BACKUP_VERSION})`,
    );
  }
  return result.data;
}
