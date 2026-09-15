// Contract types: PaperDetail from "@/lib/landscape/types".
// Stub (Phase A): implemented in Phase C.

export const runtime = "nodejs";

type Ctx = { params: Promise<{ paperId: string }> };

function notImplemented() {
  return Response.json({ error: "not implemented" }, { status: 501 });
}

/**
 * GET /api/landscape/papers/[paperId]
 * Paper detail. `?searchId=` adds search-scoped rank, cluster and relations.
 * Responds: 200 { paper: PaperDetail } | 404
 */
export async function GET(_request: Request, { params }: Ctx) {
  await params;
  return notImplemented();
}
