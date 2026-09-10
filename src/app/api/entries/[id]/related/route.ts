import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entries } from "@/lib/db/schema";
import { cosine, fromBuffer } from "@/lib/embedding";
import type { RelatedEntry } from "@/lib/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const TOP_N = 5;

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const row = db.select().from(entries).where(eq(entries.id, id)).get();
    if (!row) return Response.json({ error: "Entry not found." }, { status: 404 });

    // Not an error: the entry may simply still be ingesting.
    if (!row.embedding) return Response.json({ related: [] });

    const target = fromBuffer(row.embedding);
    const related: RelatedEntry[] = [];

    for (const other of db.select().from(entries).all()) {
      if (other.id === row.id || !other.embedding) continue;
      let score: number;
      try {
        score = cosine(target, fromBuffer(other.embedding));
      } catch {
        continue; // A malformed blob shouldn't sink the whole comparison.
      }
      related.push({
        id: other.id,
        title: other.title,
        url: other.url,
        category: other.category,
        tags: other.tags ?? [],
        score: Math.round(score * 1000) / 1000,
      });
    }

    related.sort((a, b) => b.score - a.score);
    return Response.json({ related: related.slice(0, TOP_N) });
  } catch (err) {
    console.error("[GET /api/entries/:id/related]", err);
    return Response.json({ error: "Could not compute related entries." }, { status: 500 });
  }
}
