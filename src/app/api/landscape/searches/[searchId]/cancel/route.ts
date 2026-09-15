// Contract types: SearchProgress from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * POST /api/landscape/searches/[searchId]/cancel
 * Request cancellation; the runner stops at the next checkpoint.
 * Responds: 200 { search: SearchProgress } | 404 | 409 (not active)
 */
export async function POST(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}
