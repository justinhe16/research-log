import { db } from "@/lib/db";
import { parseExportFile, type ParsedExportFile } from "@/lib/backup-format";
import { importBackup, type ImportResult } from "@/lib/backup-io";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024 * 1024;

function bad(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

class TooLarge extends Error {
  constructor() {
    super("Backup file is too large");
  }
}

/** Read the raw body, aborting as soon as it passes MAX_BYTES (counted in
 *  bytes, not UTF-16 string length) instead of buffering an unbounded upload. */
async function readCapped(req: Request): Promise<Uint8Array<ArrayBuffer>> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Accept either a raw JSON body or a multipart upload with a `file` field. */
async function readPayload(req: Request): Promise<unknown> {
  // Cheap early reject when the client declares the size. Multipart framing
  // adds a little overhead, which the streaming cap below doesn't care about.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new TooLarge();

  const contentType = req.headers.get("content-type") ?? "";
  const bytes = await readCapped(req);

  if (contentType.includes("multipart/form-data")) {
    // Re-wrap the capped bytes so formData() never sees more than MAX_BYTES.
    const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new Error("Expected a `file` field in the multipart upload");
    }
    if (file.size > MAX_BYTES) throw new TooLarge();
    return JSON.parse(await file.text());
  }

  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) throw new Error("Request body is empty");
  return JSON.parse(text);
}

/** POST /api/import -- restore an export produced by GET /api/export (v1 or v2).
 *  `?mode=replace` wipes existing rows first (Landscape tables only when the
 *  file carries a `landscape` section); otherwise existing ids are left alone
 *  (never clobber notes the user has written since the backup). Runs in one
 *  transaction; see `importBackup` for the merge rules. */
export async function POST(req: Request) {
  const replace = new URL(req.url).searchParams.get("mode") === "replace";

  let raw: unknown;
  try {
    raw = await readPayload(req);
  } catch (err) {
    if (err instanceof TooLarge) return Response.json({ error: err.message }, { status: 413 });
    return bad(err instanceof SyntaxError ? "File is not valid JSON" : String((err as Error).message));
  }

  let parsed: ParsedExportFile;
  try {
    parsed = parseExportFile(raw);
  } catch (err) {
    return bad((err as Error).message);
  }

  let result: ImportResult;
  try {
    result = importBackup(db, parsed, { replace });
  } catch (err) {
    return Response.json(
      { error: `Import failed, no changes written: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  return Response.json(result);
}
