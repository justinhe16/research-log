import type { NextRequest } from "next/server";
import { checkSameOrigin } from "@/lib/same-origin";

/** Reject cross-origin mutating requests to the API (CSRF / drive-by localhost). */
export function proxy(request: NextRequest) {
  const result = checkSameOrigin({ method: request.method, url: request.url, headers: request.headers });
  if (!result.ok) return Response.json({ error: result.error }, { status: 403 });
}

export const config = {
  matcher: "/api/:path*",
};
