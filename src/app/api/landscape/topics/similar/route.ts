// Contract types: SimilarTopic, SimilarTopicsInput from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * POST /api/landscape/topics/similar
 * Topics whose name + description embedding is >= TOPIC_SIMILARITY_THRESHOLD.
 * Body: SimilarTopicsInput
 * Responds: 200 { similar: SimilarTopic[] }
 */
export async function POST() {
  return notImplemented();
}
