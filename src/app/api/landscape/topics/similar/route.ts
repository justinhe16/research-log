import { z } from "zod";
import { db } from "@/lib/db";
import { TOPIC_DESCRIPTION_MAX, TOPIC_NAME_MAX } from "@/lib/landscape/constants";
import { findSimilarTopicsFor } from "@/lib/landscape/topic-dedupe";
import { fail, parseBody } from "../../_lib/http";

export const runtime = "nodejs";

const similarSchema = z.object({
  name: z.string().trim().min(1, "A topic name is required.").max(TOPIC_NAME_MAX),
  description: z.string().trim().max(TOPIC_DESCRIPTION_MAX).optional(),
});

/**
 * POST /api/landscape/topics/similar
 * Topics whose name + description embedding is >= TOPIC_SIMILARITY_THRESHOLD.
 * Body: SimilarTopicsInput
 * Responds: 200 { similar: SimilarTopic[] }
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, similarSchema);
    if (!parsed.ok) return parsed.response;
    const { similar } = await findSimilarTopicsFor(db, parsed.data);
    return Response.json({ similar });
  } catch (err) {
    console.error("[POST /api/landscape/topics/similar]", err);
    return fail("Could not check for similar topics.", 500);
  }
}
