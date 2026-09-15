import { db } from "@/lib/db";
import { exportChunks } from "@/lib/backup-io";

export const runtime = "nodejs";

/** GET /api/export -- full JSON dump (backup format v2), downloaded as a file.
 *  Includes notes, rawText, base64'd embeddings and every Landscape table except
 *  the HTTP cache: this is the user's backup, and a dump without vectors would
 *  cost a full re-embed to restore.
 *
 *  `?fulltext=0` leaves out `paper_fulltext`, usually the bulk of the file.
 *  The body is streamed a page of rows at a time rather than built in memory. */
export function GET(req: Request) {
  const flag = new URL(req.url).searchParams.get("fulltext");
  const fulltext = !(flag === "0" || flag === "false");

  const chunks = exportChunks(db, { fulltext });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Batch small chunks so we don't enqueue one tiny buffer per row.
      let buf = "";
      while (buf.length < 64 * 1024) {
        const next = chunks.next();
        if (next.done) {
          if (buf) controller.enqueue(encoder.encode(buf));
          controller.close();
          return;
        }
        buf += next.value;
      }
      controller.enqueue(encoder.encode(buf));
    },
    cancel() {
      chunks.return(undefined);
    },
  });

  const date = new Date().toISOString().slice(0, 10);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="research-log-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
