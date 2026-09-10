import { db, schema } from "@/lib/db";
import { BACKUP_VERSION, encodeEntry, type ExportFile } from "@/lib/backup-format";

export const runtime = "nodejs";

/** GET /api/export -- full JSON dump, downloaded as a file.
 *  Includes notes, rawText and the base64'd embedding: this is the user's
 *  backup, and a dump without vectors would cost a full re-embed to restore. */
export function GET() {
  const rows = db.select().from(schema.entries).all();

  const payload: ExportFile = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    count: rows.length,
    entries: rows.map(encodeEntry),
  };

  const date = new Date().toISOString().slice(0, 10);

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="research-log-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
