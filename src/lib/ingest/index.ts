import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entries } from "@/lib/db/schema";
import { embed, toBuffer } from "@/lib/embedding";
import { extractContent } from "./extract";
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

/**
 * Fetch -> summarize -> embed a saved entry, writing progress to the row as it
 * goes so the UI can show a live status. Runs detached from the request that
 * created the entry, so it never throws: failures land in `ingestError`.
 */
export async function runIngest(entryId: string): Promise<void> {
  try {
    const row = db.select().from(entries).where(eq(entries.id, entryId)).get();
    if (!row) throw new Error(`Entry ${entryId} no longer exists.`);

    // --- fetch -------------------------------------------------------------
    setStatus(entryId, "fetching");
    const content = await extractContent(row.url);

    // --- summarize ---------------------------------------------------------
    setStatus(entryId, "summarizing");
    const analysis = await summarize(content);

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
        authors: analysis.authors,
        org: analysis.org,
        venue: analysis.venue,
        publishedAt: analysis.publishedAt,
        contentType: analysis.contentType,
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
