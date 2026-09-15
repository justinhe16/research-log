// Contract types: LandscapeSnapshot from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

type Ctx = { params: Promise<{ searchId: string }> };

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * GET /api/landscape/searches/[searchId]/snapshot
 * Everything the topic page renders for this search.
 * Responds: 200 { snapshot: LandscapeSnapshot } | 404
 */
export async function GET(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}
