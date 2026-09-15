// Contract types: CreateTopicInput, CreateTopicResponse, SimilarTopicsConflict, TopicCard from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * GET /api/landscape/topics
 * List topics, newest activity first. Also lazily sweeps stale running searches.
 * Responds: 200 { topics: TopicCard[] }
 */
export async function GET() {
  return notImplemented();
}

/**
 * POST /api/landscape/topics
 * Create a topic and queue its initial search.
 * Body: CreateTopicInput
 * Responds: 201 CreateTopicResponse | 409 SimilarTopicsConflict (unless force) | 400 { error }
 */
export async function POST() {
  return notImplemented();
}
