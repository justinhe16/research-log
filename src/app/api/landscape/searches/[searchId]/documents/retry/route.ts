import { z } from "zod";
import { db } from "@/lib/db";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { retryDocuments } from "@/lib/landscape/pipeline/runner";
import { DOCUMENT_KINDS } from "@/lib/landscape/types";
import { actionFailure, fail, parseBody } from "../../../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

const retrySchema = z.object({
  kinds: z.array(z.enum(DOCUMENT_KINDS)).optional(),
});

/**
 * POST /api/landscape/searches/[searchId]/documents/retry
 * Re-run synthesis for failed documents (all failed kinds when `kinds` is omitted).
 * Body: RetryDocumentsInput (may be empty)
 * Responds: 200 { search: SearchProgress } | 400 | 404 | 409
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { searchId } = await params;
    const parsed = await parseBody(request, retrySchema, { allowEmpty: true });
    if (!parsed.ok) return parsed.response;
    const kinds = parsed.data.kinds?.length ? [...new Set(parsed.data.kinds)] : undefined;

    const result = await retryDocuments(searchId, { db, kinds });
    if (!result.ok) return actionFailure(result, "retry synthesis for");
    const search = toSearchProgress(db, searchId);
    if (!search) return fail("Search not found.", 404);
    return Response.json({ search });
  } catch (err) {
    console.error("[POST /api/landscape/searches/:id/documents/retry]", err);
    return fail("Could not retry synthesis.", 500);
  }
}
