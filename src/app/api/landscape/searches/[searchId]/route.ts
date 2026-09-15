import { db } from "@/lib/db";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { fail } from "../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

/**
 * GET /api/landscape/searches/[searchId]
 * Polled progress of one search.
 * Responds: 200 { search: SearchProgress } | 404
 */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { searchId } = await params;
    const search = toSearchProgress(db, searchId);
    if (!search) return fail("Search not found.", 404);
    return Response.json({ search });
  } catch (err) {
    console.error("[GET /api/landscape/searches/:id]", err);
    return fail("Could not load the search.", 500);
  }
}
