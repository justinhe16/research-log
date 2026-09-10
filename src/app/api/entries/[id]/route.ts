import { eq } from "drizzle-orm";
import { z } from "zod";
import { CATEGORIES, STATUSES } from "@/lib/constants";
import { db } from "@/lib/db";
import { entries } from "@/lib/db/schema";
import { toEntry } from "@/lib/serialize";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z
  .object({
    category: z.enum(CATEGORIES),
    notes: z.string(),
    whySaved: z.string(),
    status: z.enum(STATUSES),
    rating: z.number().int().min(1).max(5).nullable(),
    title: z.string(),
  })
  .partial();

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function getRow(id: string) {
  return db.select().from(entries).where(eq(entries.id, id)).get();
}

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const row = getRow(id);
    if (!row) return fail("Entry not found.", 404);
    return Response.json({ entry: toEntry(row) });
  } catch (err) {
    console.error("[GET /api/entries/:id]", err);
    return fail("Could not load the entry.", 500);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!getRow(id)) return fail("Entry not found.", 404);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail("Request body must be valid JSON.", 400);
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return fail(
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        400,
      );
    }

    // Only write keys the caller actually sent -- `undefined` values would
    // otherwise be indistinguishable from "clear this field".
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(patch).length === 0) return fail("No updatable fields were provided.", 400);

    db.update(entries)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(entries.id, id))
      .run();

    const row = getRow(id);
    if (!row) return fail("Entry not found.", 404);
    return Response.json({ entry: toEntry(row) });
  } catch (err) {
    console.error("[PATCH /api/entries/:id]", err);
    return fail("Could not update the entry.", 500);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    if (!getRow(id)) return fail("Entry not found.", 404);
    db.delete(entries).where(eq(entries.id, id)).run();
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/entries/:id]", err);
    return fail("Could not delete the entry.", 500);
  }
}
