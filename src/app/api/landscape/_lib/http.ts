import type { z } from "zod";
import { isJsonContentType } from "@/lib/same-origin";
import type { SearchActionResult } from "@/lib/landscape/pipeline/runner";

/* Shared helpers for the Landscape route handlers (private folder: not a route). */

export function fail(message: string, status: number, extra?: Record<string, unknown>) {
  return Response.json({ error: message, ...extra }, { status });
}

export function issuesMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export const JSON_CONTENT_TYPE_ERROR = "Content-Type must be application/json.";

/** Read and validate a JSON body. `allowEmpty` treats a missing body as `{}`.
 *  A non-empty body must be sent as `Content-Type: application/json` (415 otherwise). */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): Promise<Parsed<T>> {
  let body: unknown;
  try {
    const text = await request.text();
    if (!text.trim()) {
      if (!allowEmpty) return { ok: false, response: fail("Request body must be valid JSON.", 400) };
      body = {};
    } else if (!isJsonContentType(request.headers.get("content-type"))) {
      return { ok: false, response: fail(JSON_CONTENT_TYPE_ERROR, 415) };
    } else {
      body = JSON.parse(text);
    }
  } catch {
    return { ok: false, response: fail("Request body must be valid JSON.", 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, response: fail(issuesMessage(parsed.error), 400) };
  return { ok: true, data: parsed.data };
}

/** Map a failed runner action to an HTTP error. */
export function actionFailure(result: Exclude<SearchActionResult, { ok: true }>, verb: string): Response {
  switch (result.reason) {
    case "not_found":
      return fail("Search not found.", 404);
    case "invalid_status":
      return fail(`Cannot ${verb} a search that is ${result.status}.`, 409);
    case "active_search":
      return fail("This topic already has a search in progress.", 409, { activeSearchId: result.activeSearchId });
  }
}
