// Contract types: SearchProgress, StartSearchInput from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

type Ctx = { params: Promise<{ topicId: string }> };

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * POST /api/landscape/topics/[topicId]/searches
 * Start a refresh (incremental from the latest done search) or a full re-run.
 * Body: StartSearchInput
 * Responds: 201 { search: SearchProgress } | 409 { error } (a search is already active) | 404
 */
export async function POST(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}
