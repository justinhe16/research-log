import { db } from "@/lib/db";
import { getLandscapeSnapshot } from "@/lib/landscape/queries/snapshot";
import { fail } from "../../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

/**
 * GET /api/landscape/searches/[searchId]/snapshot
 * Everything the topic page renders for this search (partial while it runs).
 * Responds: 200 { snapshot: LandscapeSnapshot } | 404
 */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { searchId } = await params;
    const snapshot = getLandscapeSnapshot(db, searchId);
    if (!snapshot) return fail("Search not found.", 404);
    return Response.json({ snapshot });
  } catch (err) {
    console.error("[GET /api/landscape/searches/:id/snapshot]", err);
    return fail("Could not load the landscape.", 500);
  }
}
