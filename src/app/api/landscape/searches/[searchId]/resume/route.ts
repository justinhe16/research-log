// Contract types: SearchProgress from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * POST /api/landscape/searches/[searchId]/resume
 * Resume an error / cancelled / interrupted search from its last completed stage.
 * Responds: 200 { search: SearchProgress } | 404 | 409 (not resumable, or topic has another active search)
 */
export async function POST(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}
