// Contract types: TopicCard, TopicDetail, UpdateTopicInput from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

type Ctx = { params: Promise<{ topicId: string }> };

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * GET /api/landscape/topics/[topicId]
 * Topic header + full search history.
 * Responds: 200 { topic: TopicDetail } | 404
 */
export async function GET(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}

/**
 * PATCH /api/landscape/topics/[topicId]
 * Rename / edit description / change default depth.
 * Body: UpdateTopicInput
 * Responds: 200 { topic: TopicCard } | 400 | 404
 */
export async function PATCH(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}

/**
 * DELETE /api/landscape/topics/[topicId]
 * Delete a topic and all its searches (papers are global and kept). Cancels an active search first.
 * Responds: 200 { ok: true } | 404
 */
export async function DELETE(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}
