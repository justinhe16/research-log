import type { EntryRow } from "./db/schema";
import type { Entry } from "./types";

/** Row -> wire shape. Drops `embedding` and `rawText`: both are large and the
 *  client has no use for them. */
export function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    url: row.url,
    category: row.category,
    notes: row.notes,
    whySaved: row.whySaved,
    status: row.status,
    rating: row.rating,
    title: row.title,
    summary: row.summary,
    keyClaims: row.keyClaims ?? [],
    tags: row.tags ?? [],
    authors: row.authors ?? [],
    org: row.org,
    venue: row.venue,
    publishedAt: row.publishedAt,
    contentType: row.contentType,
    ingestStatus: row.ingestStatus,
    ingestError: row.ingestError,
    hasEmbedding: row.embedding != null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
