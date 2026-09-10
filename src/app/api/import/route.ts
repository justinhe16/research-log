import { inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { decodeEntry, parseExportFile } from "@/lib/backup-format";
import type { NewEntryRow } from "@/lib/db/schema";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024 * 1024;

function bad(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

/** Accept either a raw JSON body or a multipart upload with a `file` field. */
async function readPayload(req: Request): Promise<unknown> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new Error('Expected a `file` field in the multipart upload');
    }
    if (file.size > MAX_BYTES) throw new Error("Backup file is too large");
    return JSON.parse(await file.text());
  }

  const text = await req.text();
  if (!text.trim()) throw new Error("Request body is empty");
  return JSON.parse(text);
}

/** POST /api/import -- restore an export produced by GET /api/export.
 *  `?mode=replace` wipes existing rows first; otherwise existing ids are left
 *  alone (never clobber notes the user has written since the backup). */
export async function POST(req: Request) {
  const replace = new URL(req.url).searchParams.get("mode") === "replace";

  let raw: unknown;
  try {
    raw = await readPayload(req);
  } catch (err) {
    return bad(err instanceof SyntaxError ? "File is not valid JSON" : String((err as Error).message));
  }

  let rows: NewEntryRow[];
  let duplicates = 0;
  try {
    const parsed = parseExportFile(raw);
    // Decode fully before touching the DB: a bad blob halfway through the file
    // must not leave a half-written database behind.
    const seen = new Set<string>();
    rows = [];
    for (const entry of parsed.entries) {
      if (seen.has(entry.id)) {
        duplicates++; // last-wins would be arbitrary; keep the first
        continue;
      }
      seen.add(entry.id);
      rows.push(decodeEntry(entry));
    }
  } catch (err) {
    return bad((err as Error).message);
  }

  let imported = 0;
  let skipped = 0;
  let missingEmbeddings = 0;

  try {
    db.transaction((tx) => {
      let toInsert = rows;

      if (replace) {
        tx.delete(schema.entries).run();
      } else if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        const existing = new Set<string>();
        // SQLite caps bound parameters, so probe in chunks.
        for (let i = 0; i < ids.length; i += 500) {
          for (const row of tx
            .select({ id: schema.entries.id })
            .from(schema.entries)
            .where(inArray(schema.entries.id, ids.slice(i, i + 500)))
            .all()) {
            existing.add(row.id);
          }
        }
        toInsert = rows.filter((r) => !existing.has(r.id));
      }

      skipped = duplicates + (rows.length - toInsert.length);

      for (let i = 0; i < toInsert.length; i += 200) {
        tx.insert(schema.entries).values(toInsert.slice(i, i + 200)).run();
      }

      imported = toInsert.length;
      missingEmbeddings = toInsert.filter((r) => r.embedding == null).length;
    });
  } catch (err) {
    return Response.json(
      { error: `Import failed, no changes written: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  return Response.json({ imported, skipped, replaced: replace, missingEmbeddings });
}
