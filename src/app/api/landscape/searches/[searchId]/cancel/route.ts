import { db } from "@/lib/db";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { cancelSearch } from "@/lib/landscape/pipeline/runner";
import { actionFailure, fail } from "../../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

/**
 * POST /api/landscape/searches/[searchId]/cancel
 * Request cancellation; the runner stops at the next checkpoint.
 * Responds: 200 { search: SearchProgress } | 404 | 409 (not active)
 */
export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { searchId } = await params;
    const result = await cancelSearch(searchId, { db });
    if (!result.ok) return actionFailure(result, "cancel");
    const search = toSearchProgress(db, searchId);
    if (!search) return fail("Search not found.", 404);
    return Response.json({ search });
  } catch (err) {
    console.error("[POST /api/landscape/searches/:id/cancel]", err);
    return fail("Could not cancel the search.", 500);
  }
}
