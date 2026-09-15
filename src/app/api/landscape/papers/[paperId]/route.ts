import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getPaperDetail } from "@/lib/landscape/queries/paper-detail";
import { fail } from "../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ paperId: string }> };

/**
 * GET /api/landscape/papers/[paperId]
 * Paper detail. `?searchId=` adds search-scoped rank, cluster and relations.
 * Responds: 200 { paper: PaperDetail } | 404
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const { paperId } = await params;
    const searchId = request.nextUrl.searchParams.get("searchId")?.trim() || null;
    const paper = getPaperDetail(db, paperId, searchId);
    if (!paper) return fail("Paper not found.", 404);
    return Response.json({ paper });
  } catch (err) {
    console.error("[GET /api/landscape/papers/:id]", err);
    return fail("Could not load the paper.", 500);
  }
}
