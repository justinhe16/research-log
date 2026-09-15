import { describe, expect, it } from "vitest";
import { checkSameOrigin, isJsonContentType, isMutatingMethod, mediaType } from "@/lib/same-origin";

const URL_LOCAL = "http://localhost:3000/api/import?mode=replace";

function check(method: string, headers: Record<string, string>, url = URL_LOCAL) {
  return checkSameOrigin({ method, url, headers: new Headers(headers) });
}

describe("checkSameOrigin", () => {
  it("allows safe methods regardless of origin", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(check(m, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }).ok).toBe(true);
    }
  });

  it("treats every write method as mutating", () => {
    for (const m of ["POST", "put", "PATCH", "DELETE"]) expect(isMutatingMethod(m)).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
  });

  it("allows same-origin and user-initiated fetch metadata", () => {
    expect(check("POST", { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }).ok).toBe(true);
    expect(check("POST", { "sec-fetch-site": "none" }).ok).toBe(true);
  });

  it("rejects cross-site and same-site fetch metadata even with a matching Origin", () => {
    const cross = check("POST", { "sec-fetch-site": "cross-site", origin: "https://evil.example" });
    expect(cross).toEqual({ ok: false, error: expect.stringMatching(/cross-origin/i) });
    // Another port on localhost is same-site, not same-origin.
    expect(check("DELETE", { "sec-fetch-site": "same-site", origin: "http://localhost:3000" }).ok).toBe(false);
  });

  it("falls back to comparing Origin with the request's own origin", () => {
    expect(check("POST", { origin: "http://localhost:3000", host: "localhost:3000" }).ok).toBe(true);
    expect(check("POST", { origin: "http://localhost:3000" }).ok).toBe(true); // URL origin alone
    expect(check("POST", { origin: "https://evil.example", host: "localhost:3000" }).ok).toBe(false);
    expect(check("POST", { origin: "http://localhost:3001", host: "localhost:3000" }).ok).toBe(false);
    expect(check("POST", { origin: "null" }).ok).toBe(false);
  });

  it("compares hostnames literally (localhost is not 127.0.0.1)", () => {
    const url = "http://127.0.0.1:3000/api/entries";
    expect(check("POST", { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, url).ok).toBe(true);
    expect(check("POST", { origin: "http://localhost:3000", host: "127.0.0.1:3000" }, url).ok).toBe(false);
  });

  it("does not let a matching scheme-less or https Origin slip through", () => {
    expect(check("POST", { origin: "https://localhost:3000", host: "localhost:3000" }).ok).toBe(false);
    expect(check("POST", { origin: "localhost:3000", host: "localhost:3000" }).ok).toBe(false);
  });

  it("allows non-browser clients that send neither header (curl, scripts)", () => {
    expect(check("POST", { "content-type": "application/json" }).ok).toBe(true);
    expect(check("POST", {}).ok).toBe(true);
  });
});

describe("content type helpers", () => {
  it("parses the media type without parameters", () => {
    expect(mediaType("Application/JSON; charset=utf-8")).toBe("application/json");
    expect(mediaType(null)).toBe("");
  });

  it("recognizes only application/json as JSON", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json;charset=UTF-8")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});
