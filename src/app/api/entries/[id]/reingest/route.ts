import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entries } from "@/lib/db/schema";
import { runIngest } from "@/lib/ingest";
import { toEntry } from "@/lib/serialize";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const existing = db.select().from(entries).where(eq(entries.id, id)).get();
    if (!existing) return Response.json({ error: "Entry not found." }, { status: 404 });

    db.update(entries)
      .set({ ingestStatus: "pending", ingestError: null, updatedAt: new Date().toISOString() })
      .where(eq(entries.id, id))
      .run();

    const row = db.select().from(entries).where(eq(entries.id, id)).get();

    // Detached, same as the initial ingest -- the client polls for the result.
    void runIngest(id).catch((err) => console.error("[reingest] unhandled", err));

    return Response.json({ entry: toEntry(row ?? existing) });
  } catch (err) {
    console.error("[POST /api/entries/:id/reingest]", err);
    return Response.json({ error: "Could not restart ingest for this entry." }, { status: 500 });
  }
}
