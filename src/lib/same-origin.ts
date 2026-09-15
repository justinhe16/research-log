/*
 * Same-origin guard for mutating API requests (applied by src/proxy.ts).
 *
 * The app has no auth: it trusts whoever can reach localhost. Without this, any
 * website open in the user's browser could fire a "simple" cross-origin POST
 * (text/plain, no preflight) at http://localhost:3000/api/** to start paid
 * searches or replace-import an empty backup. Pure so it can be unit tested.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuardInput = {
  method: string;
  url: string;
  headers: Pick<Headers, "get">;
};

export type GuardResult = { ok: true } | { ok: false; error: string };

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** The origins this request could legitimately come from: the request URL's own
 *  origin and the origin implied by its Host header. Hostnames are compared
 *  literally (localhost and 127.0.0.1 are different origins). */
function ownOrigins(url: string, host: string | null): Set<string> {
  const origins = new Set<string>();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
    origins.add(parsed.origin);
  } catch {
    // Unparseable URL: fall through to the Host header alone.
  }
  if (host) {
    const protocol = parsed?.protocol ?? "http:";
    try {
      origins.add(new URL(`${protocol}//${host}`).origin);
    } catch {
      // Malformed Host header contributes nothing.
    }
  }
  return origins;
}

export function checkSameOrigin({ method, url, headers }: GuardInput): GuardResult {
  if (!isMutatingMethod(method)) return { ok: true };

  const fetchSite = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite) {
    // "none" = user-initiated (address bar, bookmark); "same-origin" = our own pages.
    if (fetchSite === "same-origin" || fetchSite === "none") return { ok: true };
    return { ok: false, error: "Cross-origin requests to this API are not allowed." };
  }

  const origin = headers.get("origin")?.trim();
  if (origin) {
    if (ownOrigins(url, headers.get("host")).has(origin)) return { ok: true };
    return { ok: false, error: "Cross-origin requests to this API are not allowed." };
  }

  // Browsers always send Origin (and modern ones Sec-Fetch-Site) on cross-origin
  // POST/PUT/PATCH/DELETE, so neither header means a non-browser client (curl, scripts).
  return { ok: true };
}

/** Media type without parameters, lowercased ("application/json; charset=utf-8" -> "application/json"). */
export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function isJsonContentType(contentType: string | null): boolean {
  return mediaType(contentType) === "application/json";
}
