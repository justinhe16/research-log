/**
 * Polite HTTP layer for Landscape sources (arXiv, Semantic Scholar, OpenAlex, PDFs).
 *
 * Server-only. Every request goes through a per-host limiter, a timeout, retries,
 * and (optionally) the `api_cache` table.
 *
 * API
 * ---
 * - `fetchJson<T>(url, opts?)`   → parsed JSON (throws `HttpError` on non-2xx).
 * - `fetchText(url, opts?)`      → response text.
 * - `fetchBytes(url, opts?)`     → `{ bytes, contentType, url }`. Streams with a size cap
 *   (`maxBytes`, default `PDF_MAX_BYTES`), rejects non-http(s) URLs and hosts that
 *   resolve to private/loopback/link-local addresses (every redirect hop is re-checked).
 *   Never cached.
 * - `assertPublicUrl(url)`       → throws `UnsafeUrlError` unless the URL is safe to fetch.
 * - `hostQueue(name, cfg)`       → the shared `HostQueue` for `name` (on globalThis, HMR-safe).
 * - `purgeExpiredApiCache(db?)`  → deletes expired `api_cache` rows, returns the count.
 * - `setHttpDeps(partial)` / `resetHttpDeps()` → inject sleep/clock/random/fetch/lookup (tests).
 *
 * Options (`HttpOptions`)
 * - `host`: limiter bucket. Inferred from the URL when omitted: `arxiv` (arxiv.org and
 *   subdomains), `s2` (api.semanticscholar.org), `openalex` (api.openalex.org), otherwise
 *   the URL hostname (spaced by `RATE_LIMITS.pdf`, serial).
 * - `method` (default GET, or POST when `json` is given), `json` (POST JSON body),
 *   `headers`, `signal` (caller abort: never retried), `timeoutMs` (default 20s per attempt).
 * - `cache: { db?, source, ttlMs, bypass? }`: read-through/write-through `api_cache`.
 *   Key = `${source}:${sha256(method + url + body)}`. Only 2xx responses are stored.
 *   `bypass` skips the read but still writes the fresh response. `db` defaults to the
 *   app DB, imported lazily so importing this module never opens it.
 *
 * Etiquette: User-Agent `research-log/0.1 (mailto:$OPENALEX_MAILTO)` when that env is set;
 * `x-api-key: $SEMANTIC_SCHOLAR_API_KEY` on s2 requests. Env and rate limits are read at
 * call time. Retries on 429 / 5xx / network errors / timeouts: 1 + HTTP_MAX_RETRIES
 * attempts, backoff 2·HTTP_BACKOFF_BASE_MS·2^n + jitter, or Retry-After (seconds or
 * HTTP-date) when the server sends it. The limiter slot is released during backoff.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { and, eq, gt, lte } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { apiCache } from "@/lib/db/schema";
import {
  HTTP_BACKOFF_BASE_MS,
  HTTP_MAX_RETRIES,
  HTTP_TIMEOUT_MS,
  PDF_MAX_BYTES,
  RATE_LIMITS,
} from "../constants";

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface HttpDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  fetch: typeof fetch;
  /** Resolve a hostname to all its addresses (SSRF guard). */
  lookup: (hostname: string) => Promise<string[]>;
}

const defaultDeps: HttpDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
  // Late-bound so `vi.stubGlobal("fetch", ...)` works too.
  fetch: (input, init) => globalThis.fetch(input, init),
  lookup: async (hostname) =>
    (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address),
};

let deps: HttpDeps = { ...defaultDeps };

/** Override sleep/clock/random/fetch/lookup (tests). */
export function setHttpDeps(partial: Partial<HttpDeps>): void {
  deps = { ...deps, ...partial };
}

export function resetHttpDeps(): void {
  deps = { ...defaultDeps };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
  }
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(
    readonly url: string,
    readonly maxBytes: number,
  ) {
    super(`Response from ${url} exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Host limiter
// ---------------------------------------------------------------------------

export interface HostQueueConfig {
  /** Minimum spacing between request starts, in ms. */
  minIntervalMs: number;
  /** Max requests in flight at once. */
  concurrency: number;
}

/** Semaphore + start-time spacing. Config is mutable so callers can refresh it per call. */
export class HostQueue {
  private active = 0;
  private waiters: (() => void)[] = [];
  private nextStartAt = 0;

  constructor(
    readonly name: string,
    public config: HostQueueConfig,
  ) {}

  /** Run `fn` once a slot is free and the minimum interval has elapsed. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const now = deps.now();
      const startAt = Math.max(now, this.nextStartAt);
      // Reserve the start time synchronously so concurrent callers can't share it.
      this.nextStartAt = startAt + this.config.minIntervalMs;
      if (startAt > now) await deps.sleep(startAt - now);
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < Math.max(1, this.config.concurrency)) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next waiter (active count unchanged).
    if (next) next();
    else this.active--;
  }
}

const globalForQueues = globalThis as unknown as {
  __researchLogHostQueues?: Map<string, HostQueue>;
};

/** Shared limiter for `name`, created on first use. Updates its config when given. */
export function hostQueue(name: string, config: HostQueueConfig): HostQueue {
  const queues = (globalForQueues.__researchLogHostQueues ??= new Map());
  let queue = queues.get(name);
  if (!queue) {
    queue = new HostQueue(name, config);
    queues.set(name, queue);
  } else {
    queue.config = config;
  }
  return queue;
}

/** Drop all limiter state (tests). */
export function resetHostQueues(): void {
  globalForQueues.__researchLogHostQueues?.clear();
}

/** Limiter config for a known host, read at call time (env can change between runs). */
export function hostConfig(host: string): HostQueueConfig {
  switch (host) {
    case "arxiv":
      return { minIntervalMs: RATE_LIMITS.arxiv, concurrency: 1 };
    case "s2":
      return {
        minIntervalMs: s2ApiKey() ? RATE_LIMITS.s2WithKey : RATE_LIMITS.s2WithoutKey,
        concurrency: 1,
      };
    case "openalex":
      return { minIntervalMs: RATE_LIMITS.openalex, concurrency: 2 };
    default:
      return { minIntervalMs: RATE_LIMITS.pdf, concurrency: 1 };
  }
}

/** Limiter bucket for a URL. */
export function inferHost(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname === "arxiv.org" || hostname.endsWith(".arxiv.org")) return "arxiv";
  if (hostname === "api.semanticscholar.org") return "s2";
  if (hostname === "api.openalex.org") return "openalex";
  return hostname;
}

function s2ApiKey(): string | undefined {
  return process.env.SEMANTIC_SCHOLAR_API_KEY?.trim() || undefined;
}

function userAgent(): string {
  const mailto = process.env.OPENALEX_MAILTO?.trim();
  return mailto ? `research-log/0.1 (mailto:${mailto})` : "research-log/0.1";
}

// ---------------------------------------------------------------------------
// Core request with retries
// ---------------------------------------------------------------------------

export interface HttpCacheOptions {
  /** Defaults to the app DB (lazy import). */
  db?: Db;
  /** Stored in `api_cache.host` and used as the key prefix, e.g. "arxiv". */
  source: string;
  ttlMs: number;
  /** Skip the cache read (still writes the fresh response). */
  bypass?: boolean;
}

export interface HttpOptions {
  host?: string;
  method?: string;
  /** JSON body; implies POST unless `method` is set. */
  json?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CachedHttpOptions extends HttpOptions {
  cache?: HttpCacheOptions;
}

export interface FetchBytesOptions extends HttpOptions {
  maxBytes?: number;
  /** Max redirect hops (each re-checked by the SSRF guard). Default 5. */
  maxRedirects?: number;
}

const RETRY_AFTER_MAX_MS = 120_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parse Retry-After (delta seconds or HTTP-date) into ms, or null. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(RETRY_AFTER_MAX_MS, Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, date - nowMs));
}

function backoffMs(attempt: number): number {
  return 2 * HTTP_BACKOFF_BASE_MS * 2 ** attempt + Math.floor(deps.random() * 500);
}

function buildInit(url: string, opts: HttpOptions, host: string): RequestInit {
  const headers: Record<string, string> = { "User-Agent": userAgent() };
  if (host === "s2") {
    const key = s2ApiKey();
    if (key) headers["x-api-key"] = key;
  }
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = "application/json";
  }
  Object.assign(headers, opts.headers);
  return { method: requestMethod(opts), headers, body };
}

function requestMethod(opts: HttpOptions): string {
  return (opts.method ?? (opts.json !== undefined ? "POST" : "GET")).toUpperCase();
}

/**
 * Send with limiter + timeout + retries. Resolves with a response whose status is 2xx
 * (or 3xx when `redirect: "manual"`); throws `HttpError` otherwise. The caller consumes
 * the body inside `consume`, still under the attempt's timeout.
 */
async function send<T>(
  url: string,
  opts: HttpOptions,
  extraInit: RequestInit,
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  const host = opts.host ?? inferHost(url);
  const init = { ...buildInit(url, opts, host), ...extraInit };
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    const isLast = attempt >= HTTP_MAX_RETRIES;
    let retryDelay: number;
    try {
      const outcome = await hostQueue(host, hostConfig(host)).run(async () => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        const res = await deps.fetch(url, { ...init, signal });
        if (res.ok || (init.redirect === "manual" && res.status >= 300 && res.status < 400)) {
          return { done: true as const, value: await consume(res) };
        }
        const text = await res.text().catch(() => "");
        if (!isRetryableStatus(res.status) || isLast) throw new HttpError(res.status, url, text);
        return {
          done: false as const,
          retryAfter: parseRetryAfter(res.headers.get("retry-after"), deps.now()),
        };
      });
      if (outcome.done) return outcome.value;
      retryDelay = outcome.retryAfter ?? backoffMs(attempt);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (
        err instanceof HttpError ||
        err instanceof ResponseTooLargeError ||
        err instanceof UnsafeUrlError ||
        isLast
      ) {
        throw err;
      }
      // Network error or per-attempt timeout.
      retryDelay = backoffMs(attempt);
    }
    await abortableSleep(retryDelay, opts.signal);
  }
}

/** `deps.sleep` that rejects with the signal's reason as soon as the caller aborts. */
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return raceSignal(deps.sleep(ms), signal);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function resolveDb(db?: Db): Promise<Db> {
  if (db) return db;
  const mod = await import("@/lib/db");
  return mod.db;
}

/** SQLite CURRENT_TIMESTAMP format, so string comparison matches the column default. */
function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function cacheKey(source: string, method: string, url: string, body?: string): string {
  const hash = createHash("sha256")
    .update(`${method}\n${url}\n${body ?? ""}`)
    .digest("hex");
  return `${source}:${hash}`;
}

async function cachedText(url: string, opts: CachedHttpOptions, accept?: string): Promise<string> {
  const headers = accept ? { Accept: accept, ...opts.headers } : opts.headers;
  const reqOpts = { ...opts, headers };
  const cache = opts.cache;
  if (!cache) return send(url, reqOpts, {}, (res) => res.text());

  const db = await resolveDb(cache.db);
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
  const key = cacheKey(cache.source, requestMethod(opts), url, body);

  for (;;) {
    const inFlight = inFlightCached.get(key);
    if (!inFlight) break;
    try {
      // Join, but reject promptly if our own signal aborts.
      return await raceSignal(inFlight.promise, opts.signal);
    } catch (err) {
      opts.signal?.throwIfAborted();
      // The owner was cancelled: don't inherit its abort, fetch ourselves.
      if (inFlight.signal?.aborted) continue;
      throw err;
    }
  }

  const entry: InFlight = {
    promise: cachedTextUncached(db, key, url, reqOpts, cache),
    signal: opts.signal,
  };
  inFlightCached.set(key, entry);
  try {
    return await entry.promise;
  } finally {
    if (inFlightCached.get(key) === entry) inFlightCached.delete(key);
  }
}

interface InFlight {
  promise: Promise<string>;
  /** The owner's signal: if it aborted, joiners retry on their own. */
  signal?: AbortSignal;
}

/** Identical cached requests in flight share one fetch. */
const inFlightCached = new Map<string, InFlight>();

async function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

async function cachedTextUncached(
  db: Db,
  key: string,
  url: string,
  reqOpts: HttpOptions,
  cache: HttpCacheOptions,
): Promise<string> {
  if (!cache.bypass) {
    const hit = db
      .select({ body: apiCache.body })
      .from(apiCache)
      .where(and(eq(apiCache.key, key), gt(apiCache.expiresAt, sqliteTimestamp(deps.now()))))
      .get();
    if (hit) return hit.body;
  }

  let status = 200;
  const text = await send(url, reqOpts, {}, async (res) => {
    status = res.status;
    return res.text();
  });
  const fetchedAt = deps.now();
  const row = {
    key,
    host: cache.source,
    url,
    status,
    body: text,
    fetchedAt: sqliteTimestamp(fetchedAt),
    expiresAt: sqliteTimestamp(fetchedAt + cache.ttlMs),
  };
  db.insert(apiCache)
    .values(row)
    .onConflictDoUpdate({ target: apiCache.key, set: row })
    .run();
  return text;
}

/** Delete expired `api_cache` rows. Returns the number removed. */
export async function purgeExpiredApiCache(db?: Db): Promise<number> {
  const handle = await resolveDb(db);
  const result = handle
    .delete(apiCache)
    .where(lte(apiCache.expiresAt, sqliteTimestamp(deps.now())))
    .run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

export async function fetchText(url: string, opts: CachedHttpOptions = {}): Promise<string> {
  return cachedText(url, opts);
}

export async function fetchJson<T = unknown>(url: string, opts: CachedHttpOptions = {}): Promise<T> {
  const text = await cachedText(url, opts, "application/json");
  return JSON.parse(text) as T;
}

export interface FetchedBytes {
  bytes: Uint8Array;
  contentType: string | null;
  /** Final URL after redirects. */
  url: string;
}

/** Fetch a (possibly untrusted) URL as bytes with an SSRF guard and a size cap. */
export async function fetchBytes(url: string, opts: FetchBytesOptions = {}): Promise<FetchedBytes> {
  const maxBytes = opts.maxBytes ?? PDF_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const result = await send(
      current,
      // Only honour an explicit host bucket for the first hop.
      hop === 0 ? opts : { ...opts, host: undefined },
      { redirect: "manual" },
      async (res): Promise<FetchedBytes | { redirect: string }> => {
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => {});
          const location = res.headers.get("location");
          if (!location) throw new HttpError(res.status, current, "redirect without Location");
          return { redirect: new URL(location, current).toString() };
        }
        return { bytes: await readCapped(res, current, maxBytes), contentType: res.headers.get("content-type"), url: current };
      },
    );
    if ("redirect" in result) {
      current = result.redirect;
      continue;
    }
    return result;
  }
  throw new HttpError(310, url, `more than ${maxRedirects} redirects`);
}

async function readCapped(res: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(url, maxBytes);
  }
  if (!res.body) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new ResponseTooLargeError(url, maxBytes);
    return new Uint8Array(buffer);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** Expand an IPv6 address to 8 hextets (handles `::` and embedded IPv4). */
function expandIpv6(ip: string): number[] {
  let addr = ip.split("%")[0].toLowerCase();
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - headParts.length - tailParts.length : 0;
  return [...headParts, ...Array(fill).fill("0"), ...tailParts].map((h) => parseInt(h || "0", 16));
}

function isBlockedIpv6(ip: string): boolean {
  const h = expandIpv6(ip);
  if (h.length !== 8 || h.some((x) => Number.isNaN(x))) return true;
  const allZeroPrefix = h.slice(0, 5).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 part.
  if (allZeroPrefix && (h[5] === 0xffff || h[5] === 0)) {
    if (h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
    return isBlockedIpv4(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2002) {
    // 6to4 (2002::/16): IPv4 in hextets 1-2.
    return isBlockedIpv4(`${h[1] >> 8}.${h[1] & 0xff}.${h[2] >> 8}.${h[2] & 0xff}`);
  }
  if (h[0] === 0x2001 && h[1] === 0) {
    // Teredo (2001::/32): client IPv4 is the last 32 bits XOR 0xffffffff.
    const a = h[6] ^ 0xffff;
    const b = h[7] ^ 0xffff;
    return isBlockedIpv4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    // NAT64: judge the embedded IPv4.
    return isBlockedIpv4(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
  }
  return false;
}

/** True if `ip` (v4 or v6 literal) is private, loopback, link-local or otherwise non-public. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * Throw `UnsafeUrlError` unless `url` is http(s) and every address its host resolves to
 * is public. Note: DNS can change between this check and the fetch (rebinding); this is a
 * best-effort guard for a local single-user app.
 */
export async function assertPublicUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http(s) URLs can be fetched: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError(`URLs with credentials are not allowed: ${url}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new UnsafeUrlError(`URL has no host: ${url}`);

  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new UnsafeUrlError(`Refusing to fetch a local address: ${url}`);
    }
    try {
      addresses = await deps.lookup(hostname);
    } catch {
      throw new UnsafeUrlError(`Could not resolve host: ${hostname}`);
    }
    if (addresses.length === 0) throw new UnsafeUrlError(`Could not resolve host: ${hostname}`);
  }
  if (addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`Refusing to fetch a private or local address: ${url}`);
  }
  return parsed;
}
