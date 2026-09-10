import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),

    // --- user input ---
    url: text("url").notNull(),
    category: text("category").notNull().default("Other"),
    notes: text("notes").notNull().default(""),
    whySaved: text("why_saved").notNull().default(""),
    status: text("status").notNull().default("to-read"),
    rating: integer("rating"), // 1-5, null = unrated

    // --- LLM extracted ---
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),
    keyClaims: text("key_claims", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    authors: text("authors", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    org: text("org"),
    venue: text("venue"),
    publishedAt: text("published_at"), // ISO date string, best effort
    contentType: text("content_type").notNull().default("other"),

    // --- system ---
    embedding: blob("embedding", { mode: "buffer" }), // Float32Array bytes, EMBEDDING_DIM long
    rawText: text("raw_text"),
    ingestStatus: text("ingest_status").notNull().default("pending"),
    ingestError: text("ingest_error"),

    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => [
    index("entries_created_at_idx").on(t.createdAt),
    index("entries_category_idx").on(t.category),
    index("entries_status_idx").on(t.ingestStatus),
  ],
);

export type EntryRow = typeof entries.$inferSelect;
export type NewEntryRow = typeof entries.$inferInsert;
