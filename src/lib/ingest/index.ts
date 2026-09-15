import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entries } from "@/lib/db/schema";
import { embed, toBuffer } from "@/lib/embedding";
import { contentFromSeed, extractContent, type ExtractedContent, type SeedMetadata } from "./extract";
import { summarize } from "./summarize";

const MAX_RAW_TEXT_CHARS = 40_000;

function nowIso(): string {
  return new Date().toISOString();
}

function setStatus(id: string, ingestStatus: string): void {
  db.update(entries)
    .set({ ingestStatus, updatedAt: nowIso() })
    .where(eq(entries.id, id))
    .run();
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export type IngestOptions = {
  /**
   * Metadata the caller already has (Landscape's "Log this paper"). When fetching
   * the URL fails and the seed has an abstract, the entry is summarized from the
   * seeded title + abstract instead of failing; seeded authors/venue/date win
   * over the model's guesses.
   */
  seed?: SeedMetadata | null;
};

/**
 * Fetch -> summarize -> embed a saved entry, writing progress to the row as it
 * goes so the UI can show a live status. Runs detached from the request that
 * created the entry, so it never throws: failures land in `ingestError`.
 */
export async function runIngest(entryId: string, { seed }: IngestOptions = {}): Promise<void> {
  try {
    const row = db.select().from(entries).where(eq(entries.id, entryId)).get();
    if (!row) throw new Error(`Entry ${entryId} no longer exists.`);

    // --- fetch -------------------------------------------------------------
    setStatus(entryId, "fetching");
    let content: ExtractedContent;
    try {
      content = await extractContent(row.url);
    } catch (err) {
      const seeded = contentFromSeed(row.url, seed);
      if (!seeded) throw err;
      console.warn(`[ingest] entry ${entryId}: fetch failed, summarizing from seeded abstract: ${messageOf(err)}`);
      content = seeded;
    }

    // --- summarize ---------------------------------------------------------
    setStatus(entryId, "summarizing");
    const analysis = await summarize(content);
    const seedAuthors = (seed?.authors ?? []).map((a) => a.trim()).filter(Boolean);

    // The user's own choices win over the model's guesses.
    const userPickedCategory = row.category && row.category !== "Other";
    const category = userPickedCategory ? row.category : analysis.category;
    const title = row.title?.trim() ? row.title : analysis.title;

    // --- embed -------------------------------------------------------------
    setStatus(entryId, "embedding");
    const vector = await embed(
      [title, analysis.summary, analysis.tags.join(", ")].filter(Boolean).join("\n"),
    );

    db.update(entries)
      .set({
        title,
        summary: analysis.summary,
        keyClaims: analysis.keyClaims,
        tags: analysis.tags,
        authors: seedAuthors.length ? seedAuthors : analysis.authors,
        org: analysis.org,
        venue: seed?.venue?.trim() || analysis.venue,
        publishedAt: seed?.publishedAt?.trim() || analysis.publishedAt,
        // Seeds only come from Landscape's "Log this paper", so a seeded entry is always a
        // paper. If other callers start seeding, add seed.contentType instead of this override.
        contentType: seed ? "paper" : analysis.contentType,
        category,
        embedding: toBuffer(vector),
        rawText: content.text.slice(0, MAX_RAW_TEXT_CHARS),
        ingestStatus: "done",
        ingestError: null,
        updatedAt: nowIso(),
      })
      .where(eq(entries.id, entryId))
      .run();
  } catch (err) {
    const message = messageOf(err);
    console.error(`[ingest] entry ${entryId} failed:`, err);
    try {
      db.update(entries)
        .set({ ingestStatus: "error", ingestError: message, updatedAt: nowIso() })
        .where(eq(entries.id, entryId))
        .run();
    } catch (writeErr) {
      console.error(`[ingest] could not record failure for ${entryId}:`, writeErr);
    }
  }
}
