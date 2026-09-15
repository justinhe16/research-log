import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { apiCache } from "@/lib/db/schema";
import { RATE_LIMITS } from "@/lib/landscape/constants";
import {
  HttpError,
  ResponseTooLargeError,
  UnsafeUrlError,
  assertPublicUrl,
  fetchBytes,
  fetchJson,
  fetchText,
  hostConfig,
  hostQueue,
  inferHost,
  isPrivateAddress,
  parseRetryAfter,
  purgeExpiredApiCache,
  resetHostQueues,
  resetHttpDeps,
  setHttpDeps,
} from "../http";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

/** Virtual clock: sleep advances time instantly and records the delay. */
function virtualTime(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  const sleeps: number[] = [];
  setHttpDeps({
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    random: () => 0,
  });
  return {
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): FetchMock {
  const fn = vi.fn<typeof fetch>(async (input, init) => impl(String(input), init));
  setHttpDeps({ fetch: fn });
  return fn;
}

beforeEach(() => {
  resetHttpDeps();
  resetHostQueues();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetHttpDeps();
  resetHostQueues();
});

describe("host config", () => {
  it("infers hosts from URLs", () => {
    expect(inferHost("https://export.arxiv.org/api/query?x")).toBe("arxiv");
    expect(inferHost("https://arxiv.org/pdf/1234")).toBe("arxiv");
    expect(inferHost("https://api.semanticscholar.org/graph/v1/paper")).toBe("s2");
    expect(inferHost("https://api.openalex.org/works")).toBe("openalex");
    expect(inferHost("https://example.com/a.pdf")).toBe("example.com");
  });

  it("reads the S2 key at call time", () => {
    vi.stubEnv("SEMANTIC_SCHOLAR_API_KEY", "");
    expect(hostConfig("s2").minIntervalMs).toBe(RATE_LIMITS.s2WithoutKey);
    vi.stubEnv("SEMANTIC_SCHOLAR_API_KEY", "k");
    expect(hostConfig("s2").minIntervalMs).toBe(RATE_LIMITS.s2WithKey);
    expect(hostConfig("openalex")).toEqual({ minIntervalMs: RATE_LIMITS.openalex, concurrency: 2 });
    expect(hostConfig("arxiv")).toEqual({ minIntervalMs: RATE_LIMITS.arxiv, concurrency: 1 });
  });

  it("stores queues on globalThis", () => {
    const a = hostQueue("x", { minIntervalMs: 1, concurrency: 1 });
    const b = hostQueue("x", { minIntervalMs: 5, concurrency: 1 });
    expect(a).toBe(b);
    expect(b.config.minIntervalMs).toBe(5);
  });
});

describe("limiter", () => {
  it("spaces request starts (fake timers)", async () => {
    vi.useFakeTimers({ now: 0 });
    const starts: number[] = [];
    const q = hostQueue("spaced", { minIntervalMs: 1000, concurrency: 1 });
    const runs = [0, 1, 2].map(() =>
      q.run(async () => {
        starts.push(Date.now());
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(runs);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("caps concurrency", async () => {
    vi.useFakeTimers({ now: 0 });
    const q = hostQueue("conc", { minIntervalMs: 0, concurrency: 2 });
    let active = 0;
    let peak = 0;
    const runs = Array.from({ length: 5 }, () =>
      q.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 100));
        active--;
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("applies arXiv spacing to real fetches", async () => {
    vi.useFakeTimers({ now: 0 });
    const times: number[] = [];
    mockFetch(() => {
      times.push(Date.now());
      return new Response("ok");
    });
    const p = Promise.all([1, 2].map((i) => fetchText(`https://export.arxiv.org/api/query?i=${i}`)));
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(times).toEqual([0, RATE_LIMITS.arxiv]);
  });
});

describe("requests", () => {
  it("sends User-Agent, S2 key and JSON bodies", async () => {
    vi.stubEnv("OPENALEX_MAILTO", "me@example.com");
    vi.stubEnv("SEMANTIC_SCHOLAR_API_KEY", "secret");
    virtualTime();
    const fetch = mockFetch(() => json({ ok: 1 }));
    const res = await fetchJson<{ ok: number }>("https://api.semanticscholar.org/graph/v1/paper/batch", {
      json: { ids: ["a"] },
    });
    expect(res).toEqual({ ok: 1 });
    const init = fetch.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"ids":["a"]}');
    expect(headers["User-Agent"]).toBe("research-log/0.1 (mailto:me@example.com)");
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("does not send the S2 key to other hosts", async () => {
    vi.stubEnv("SEMANTIC_SCHOLAR_API_KEY", "secret");
    virtualTime();
    const fetch = mockFetch(() => json({}));
    await fetchJson("https://api.openalex.org/works");
    expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
  });

  it("retries 5xx with exponential backoff", async () => {
    const clock = virtualTime();
    let n = 0;
    const fetch = mockFetch(() => (++n < 3 ? new Response("boom", { status: 503 }) : json({ n })));
    const res = await fetchJson("https://api.openalex.org/works", { host: "test" });
    expect(res).toEqual({ n: 3 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(clock.sleeps.filter((ms) => ms >= 2000)).toEqual([2000, 4000]);
  });

  it("honours Retry-After seconds on 429", async () => {
    const clock = virtualTime();
    let n = 0;
    mockFetch(() =>
      ++n === 1 ? new Response("", { status: 429, headers: { "Retry-After": "7" } }) : json({}),
    );
    await fetchJson("https://api.openalex.org/works", { host: "test" });
    expect(clock.sleeps).toContain(7000);
  });

  it("honours Retry-After dates", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(parseRetryAfter("garbage", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it("retries network errors and gives up after 4 tries", async () => {
    virtualTime();
    const fetch = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchText("https://api.openalex.org/works", { host: "test" })).rejects.toThrow("fetch failed");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry 4xx", async () => {
    virtualTime();
    const fetch = mockFetch(() => new Response("nope", { status: 404 }));
    const err = await fetchText("https://api.openalex.org/works", { host: "test" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts during backoff", async () => {
    let t = 0;
    let wake: (() => void) | undefined;
    setHttpDeps({
      now: () => t,
      random: () => 0,
      // Backoff sleeps never resolve on their own: only an abort can end them.
      sleep: (ms) => (ms >= 2000 ? new Promise<void>((r) => (wake = r)) : Promise.resolve(void (t += ms))),
    });
    const fetch = mockFetch(() => new Response("", { status: 503 }));
    const controller = new AbortController();
    const p = fetchText("https://api.openalex.org/works", { host: "abort", signal: controller.signal });
    await vi.waitFor(() => expect(wake).toBeDefined());
    controller.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the queue moving after failures", async () => {
    const clock = virtualTime();
    const times: number[] = [];
    let n = 0;
    mockFetch(() => {
      times.push(clock.now());
      n++;
      if (n === 1) return new Response("", { status: 404 });
      if (n === 2) throw new TypeError("fetch failed");
      return new Response("ok");
    });
    const opts = { host: "arxiv" };
    const url = "https://export.arxiv.org/api/query";
    await expect(fetchText(url, opts)).rejects.toBeInstanceOf(HttpError);
    // Network error: retried, succeeds on the third fetch.
    expect(await fetchText(url, opts)).toBe("ok");
    expect(await fetchText(url, opts)).toBe("ok");
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(RATE_LIMITS.arxiv);
    }
    expect(times).toHaveLength(4);
  });

  it("throws the final HttpError when retries run out", async () => {
    virtualTime();
    const fetch = mockFetch(() => new Response("", { status: 500 }));
    await expect(fetchText("https://api.openalex.org/works", { host: "test" })).rejects.toBeInstanceOf(HttpError);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("api_cache", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
  });
  afterEach(() => {
    db.$client.close();
  });

  const url = "https://api.openalex.org/works?search=x";

  it("serves hits without fetching", async () => {
    virtualTime();
    let n = 0;
    const fetch = mockFetch(() => json({ n: ++n }));
    const cache = { db, source: "openalex", ttlMs: 60_000 };
    expect(await fetchJson(url, { cache })).toEqual({ n: 1 });
    expect(await fetchJson(url, { cache })).toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const rows = db.select().from(apiCache).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].key.startsWith("openalex:")).toBe(true);
    expect(rows[0].status).toBe(200);
  });

  it("dedupes identical in-flight requests", async () => {
    virtualTime();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = mockFetch(async () => {
      await gate;
      return json({ ok: true });
    });
    const cache = { db, source: "openalex", ttlMs: 60_000 };
    const a = fetchJson(url, { cache });
    const b = fetchJson(url, { cache });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    release!();
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a joiner refetches when the owner's request is cancelled", async () => {
    virtualTime();
    let calls = 0;
    const fetch = mockFetch(
      (_u, init) =>
        new Promise<Response>((resolve, reject) => {
          calls++;
          if (calls === 1) {
            // Owner's fetch hangs until its signal aborts.
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
          } else {
            resolve(json({ own: true }));
          }
        }),
    );
    const cache = { db, source: "openalex", ttlMs: 60_000 };
    const owner = new AbortController();
    const joiner = new AbortController();
    const a = fetchJson(url, { cache, signal: owner.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const b = fetchJson(url, { cache, signal: joiner.signal });
    await new Promise((r) => setImmediate(r));
    expect(fetch).toHaveBeenCalledTimes(1); // joined, not fetching yet
    owner.abort(new Error("owner cancelled"));
    await expect(a).rejects.toThrow("owner cancelled");
    expect(await b).toEqual({ own: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a joiner that aborts rejects promptly", async () => {
    virtualTime();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = mockFetch(async () => {
      await gate;
      return json({ ok: true });
    });
    const cache = { db, source: "openalex", ttlMs: 60_000 };
    const a = fetchJson(url, { cache });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const joiner = new AbortController();
    const b = fetchJson(url, { cache, signal: joiner.signal });
    await new Promise((r) => setImmediate(r));
    joiner.abort(new Error("joiner cancelled"));
    // Rejects while the owner's fetch is still pending.
    await expect(b).rejects.toThrow("joiner cancelled");
    release!();
    expect(await a).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keys on method and body", async () => {
    virtualTime();
    const fetch = mockFetch(() => json({}));
    const cache = { db, source: "s2", ttlMs: 60_000 };
    await fetchJson(url, { cache, json: { a: 1 } });
    await fetchJson(url, { cache, json: { a: 2 } });
    await fetchJson(url, { cache });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("refetches expired entries", async () => {
    const clock = virtualTime();
    let n = 0;
    const fetch = mockFetch(() => json({ n: ++n }));
    const cache = { db, source: "openalex", ttlMs: 60_000 };
    await fetchJson(url, { cache });
    clock.advance(61_000);
    expect(await fetchJson(url, { cache })).toEqual({ n: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(db.select().from(apiCache).all()).toHaveLength(1);
  });

  it("bypass skips the read but writes", async () => {
    virtualTime();
    let n = 0;
    const fetch = mockFetch(() => json({ n: ++n }));
    await fetchJson(url, { cache: { db, source: "openalex", ttlMs: 60_000 } });
    expect(await fetchJson(url, { cache: { db, source: "openalex", ttlMs: 60_000, bypass: true } })).toEqual({ n: 2 });
    expect(await fetchJson(url, { cache: { db, source: "openalex", ttlMs: 60_000 } })).toEqual({ n: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache errors", async () => {
    virtualTime();
    mockFetch(() => new Response("", { status: 404 }));
    await expect(fetchJson(url, { cache: { db, source: "openalex", ttlMs: 60_000 } })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(db.select().from(apiCache).all()).toHaveLength(0);
  });

  it("purges expired rows", async () => {
    const clock = virtualTime();
    mockFetch(() => json({}));
    await fetchJson(`${url}&a`, { cache: { db, source: "openalex", ttlMs: 1_000 } });
    await fetchJson(`${url}&b`, { cache: { db, source: "openalex", ttlMs: 600_000 } });
    clock.advance(5_000);
    expect(await purgeExpiredApiCache(db)).toBe(1);
    expect(db.select().from(apiCache).all()).toHaveLength(1);
  });
});

describe("fetchBytes", () => {
  function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    });
  }

  it("caps bodies without a stream", async () => {
    virtualTime();
    const res = new Response("x".repeat(200));
    Object.defineProperty(res, "body", { value: null });
    mockFetch(() => res);
    await expect(fetchBytes("https://93.184.215.14/a.pdf", { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("gives up after maxRedirects", async () => {
    virtualTime();
    let i = 0;
    const fetch = mockFetch(
      () => new Response(null, { status: 302, headers: { location: `/r${++i}` } }),
    );
    const err = await fetchBytes("https://93.184.215.14/a.pdf", { maxRedirects: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(String(err.message)).toContain("redirects");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns bytes under the cap", async () => {
    virtualTime();
    mockFetch(() => new Response(streamOf([10, 20]), { headers: { "content-type": "application/pdf" } }));
    const res = await fetchBytes("https://93.184.215.14/a.pdf", { maxBytes: 100 });
    expect(res.bytes.byteLength).toBe(30);
    expect(res.contentType).toBe("application/pdf");
  });

  it("aborts streams over the cap", async () => {
    virtualTime();
    mockFetch(() => new Response(streamOf([60, 60])));
    await expect(fetchBytes("https://93.184.215.14/a.pdf", { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("rejects declared oversize content-length", async () => {
    virtualTime();
    const fetch = mockFetch(() => new Response("x", { headers: { "content-length": "1000" } }));
    await expect(fetchBytes("https://93.184.215.14/a.pdf", { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects private hosts before fetching", async () => {
    virtualTime();
    const fetch = mockFetch(() => new Response("x"));
    for (const u of [
      "http://127.0.0.1/x",
      "http://10.1.2.3/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x",
      "http://[fe80::1]/x",
      "http://[::ffff:127.0.0.1]/x",
      "file:///etc/passwd",
      "ftp://93.184.215.14/x",
    ]) {
      await expect(fetchBytes(u)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-checks redirect targets", async () => {
    virtualTime();
    const fetch = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    );
    await expect(fetchBytes("https://93.184.215.14/a.pdf")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows public redirects", async () => {
    virtualTime();
    mockFetch((u) =>
      u.endsWith("/a.pdf")
        ? new Response(null, { status: 301, headers: { location: "/b.pdf" } })
        : new Response(streamOf([5])),
    );
    const res = await fetchBytes("https://93.184.215.14/a.pdf");
    expect(res.url).toBe("https://93.184.215.14/b.pdf");
    expect(res.bytes.byteLength).toBe(5);
  });
});

describe("assertPublicUrl", () => {
  it("classifies addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    // 6to4 embedding 127.0.0.1 / 8.8.8.8
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true);
    expect(isPrivateAddress("2002:808:808::1")).toBe(false);
    // Teredo: client IPv4 XOR 0xffffffff. 10.0.0.1 -> f5ff:fffe, 8.8.8.8 -> f7f7:f7f7
    expect(isPrivateAddress("2001:0:4136:e378:8000:63bf:f5ff:fffe")).toBe(true);
    expect(isPrivateAddress("2001:0:4136:e378:8000:63bf:f7f7:f7f7")).toBe(false);
  });

  it("checks every resolved address", async () => {
    setHttpDeps({ lookup: async () => ["8.8.8.8", "10.0.0.1"] });
    await expect(assertPublicUrl("https://evil.example/x")).rejects.toBeInstanceOf(UnsafeUrlError);
    setHttpDeps({ lookup: async () => ["8.8.8.8"] });
    await expect(assertPublicUrl("https://ok.example/x")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
