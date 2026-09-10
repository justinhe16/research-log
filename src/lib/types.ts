import type { Category, ContentType, IngestStatus, Status } from "./constants";

/** Wire shape returned by the API and consumed by the UI. Never includes the raw
 *  embedding buffer or full page text -- both are large and useless to the client. */
export type Entry = {
  id: string;
  url: string;
  category: Category | string;
  notes: string;
  whySaved: string;
  status: Status | string;
  rating: number | null;

  title: string;
  summary: string;
  keyClaims: string[];
  tags: string[];
  authors: string[];
  org: string | null;
  venue: string | null;
  publishedAt: string | null;
  contentType: ContentType | string;

  ingestStatus: IngestStatus | string;
  ingestError: string | null;
  hasEmbedding: boolean;

  createdAt: string;
  updatedAt: string;
};

/** An entry plus its cosine similarity to some reference entry. */
export type RelatedEntry = Pick<Entry, "id" | "title" | "url" | "category" | "tags"> & {
  score: number;
};

export type CreateEntryInput = {
  url: string;
  category?: string;
  notes?: string;
  whySaved?: string;
};

export type UpdateEntryInput = Partial<
  Pick<Entry, "category" | "notes" | "whySaved" | "status" | "rating" | "title">
>;
