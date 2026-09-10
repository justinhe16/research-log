import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CATEGORIES } from "@/lib/constants";
import { db } from "@/lib/db";
import { entries } from "@/lib/db/schema";
import { runIngest } from "@/lib/ingest";
import { toEntry } from "@/lib/serialize";

export const runtime = "nodejs";

const createSchema = z.object({
  url: z.string().trim().min(1, "A URL is required."),
  category: z.enum(CATEGORIES).optional(),
  notes: z.string().optional(),
  whySaved: z.string().optional(),
});

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function GET() {
  try {
    const rows = db.select().from(entries).orderBy(desc(entries.createdAt)).all();
    return Response.json({ entries: rows.map(toEntry) });
  } catch (err) {
    console.error("[GET /api/entries]", err);
    return fail("Could not load entries.", 500);
  }
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail("Request body must be valid JSON.", 400);
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail(
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        400,
      );
    }

    const input = parsed.data;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    db.insert(entries)
      .values({
        id,
        url: input.url,
        category: input.category ?? "Other",
        notes: input.notes ?? "",
        whySaved: input.whySaved ?? "",
        ingestStatus: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = db.select().from(entries).where(eq(entries.id, id)).get();

    if (!row) return fail("The entry was saved but could not be read back.", 500);

    // Detached on purpose: the row shows up in the UI immediately and fills in
    // as ingest progresses. runIngest never throws, but belt-and-braces.
    void runIngest(id).catch((err) => console.error("[ingest] unhandled", err));

    return Response.json({ entry: toEntry(row) }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/entries]", err);
    return fail("Could not save the entry.", 500);
  }
}
