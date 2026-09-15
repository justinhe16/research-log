import { fail } from "../_lib/http";

export const runtime = "nodejs";

/**
 * GET /api/landscape/config
 * Server-side facts the UI needs for hints (never the key itself).
 * Responds: 200 { hasS2Key: boolean }
 */
export async function GET() {
  try {
    return Response.json({ hasS2Key: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()) });
  } catch (err) {
    console.error("[GET /api/landscape/config]", err);
    return fail("Could not load the configuration.", 500);
  }
}
