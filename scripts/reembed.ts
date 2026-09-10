/**
 * Backfill embeddings for entries that have none -- typically after restoring a
 * backup written before the vectors existed, or an import of foreign data.
 *
 *   npm run db:reembed
 *
 * Runs out-of-band on purpose: embedding a few hundred entries takes minutes and
 * would block an HTTP request.
 */
import { eq, isNull } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { embed, toBuffer } from "../src/lib/embedding";

/** Same text the ingest pipeline embeds: title + summary is what similarity
 *  should key off, with raw text as a fallback for un-summarized entries. */
function embedText(row: {
  title: string;
  summary: string;
  keyClaims: string[] | null;
  rawText: string | null;
}): string {
  const parts = [row.title, row.summary, ...(row.keyClaims ?? [])].filter(Boolean);
  const text = parts.join("\n").trim();
  return text || (row.rawText ?? "").trim();
}

async function main() {
  const rows = db
    .select()
    .from(schema.entries)
    .where(isNull(schema.entries.embedding))
    .all();

  if (rows.length === 0) {
    console.log("Every entry already has an embedding. Nothing to do.");
    return;
  }

  console.log(`${rows.length} entr${rows.length === 1 ? "y" : "ies"} missing an embedding.`);

  let done = 0;
  let failed = 0;

  for (const [i, row] of rows.entries()) {
    const label = row.title || row.url;
    const text = embedText(row);

    if (!text) {
      console.warn(`[${i + 1}/${rows.length}] skip (no text): ${label}`);
      failed++;
      continue;
    }

    try {
      const vector = await embed(text);
      db.update(schema.entries)
        .set({ embedding: toBuffer(vector), updatedAt: new Date().toISOString() })
        .where(eq(schema.entries.id, row.id))
        .run();
      done++;
      console.log(`[${i + 1}/${rows.length}] ok: ${label}`);
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${rows.length}] failed: ${label} -- ${(err as Error).message}`);
    }
  }

  console.log(`\nEmbedded ${done}, failed ${failed}.`);
}

main().catch((err) => {
  console.error("Re-embed failed:", err);
  process.exit(1);
});
