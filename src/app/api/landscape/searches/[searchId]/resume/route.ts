import { db } from "@/lib/db";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { resumeSearch } from "@/lib/landscape/pipeline/runner";
import { actionFailure, fail } from "../../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

/**
 * POST /api/landscape/searches/[searchId]/resume
 * Resume an error / cancelled / interrupted search from its last completed stage.
 * Responds: 200 { search: SearchProgress } | 404 | 409 (not resumable, or topic has another active search)
 */
export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { searchId } = await params;
    const result = await resumeSearch(searchId, { db });
    if (!result.ok) return actionFailure(result, "resume");
    const search = toSearchProgress(db, searchId);
    if (!search) return fail("Search not found.", 404);
    return Response.json({ search });
  } catch (err) {
    console.error("[POST /api/landscape/searches/:id/resume]", err);
    return fail("Could not resume the search.", 500);
  }
}
