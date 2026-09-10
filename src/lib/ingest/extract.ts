import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export type ExtractedContent = {
  url: string;
  title: string;
  text: string;
  contentType: string;
  authors: string[];
  publishedAt: string | null;
  venue: string | null;
  org: string | null;
};

const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 40_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Hosts that are unambiguously personal/blog writing. */
const BLOG_HOST_HINTS = [
  "substack.com",
  "medium.com",
  "wordpress.com",
  "blogspot.com",
  "ghost.io",
  "svbtle.com",
  "tumblr.com",
  "dev.to",
  "hashnode.dev",
];
const POST_HOST_HINTS = ["lesswrong.com", "alignmentforum.org", "forum.effectivealtruism.org"];

function clip(s: string, n = MAX_TEXT_CHARS): string {
  return s.length > n ? s.slice(0, n) : s;
}

function tidy(s: string): string {
  return s.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUrl(raw: string): URL {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error("No URL provided.");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme "${u.protocol}" -- only http and https are supported.`);
  }
  return u;
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) {
      throw new Error(`Timed out after ${FETCH_TIMEOUT_MS / 1000}s fetching ${url}`);
    }
    throw new Error(`Network error fetching ${url}: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res;
}

// ---------------------------------------------------------------- arXiv ----

/** Pull the bare arXiv id out of an abs/pdf/html URL, or null if not arXiv. */
export function parseArxivId(u: URL): string | null {
  if (!/(^|\.)arxiv\.org$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i);
  if (!m) return null;
  // Strip a trailing version suffix so the API returns the canonical record.
  return m[1].replace(/v\d+$/i, "");
}

function xmlText(el: Element | null | undefined): string {
  return tidy(el?.textContent ?? "");
}

async function extractArxiv(id: string, canonicalUrl: string): Promise<ExtractedContent> {
  const api = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const res = await fetchWithTimeout(api, "application/atom+xml");
  const xml = await res.text();

  const { DOMParser } = new JSDOM("").window;
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Could not parse the arXiv API response as XML.");
  }

  const entry = doc.querySelector("entry");
  if (!entry) throw new Error(`arXiv returned no record for id "${id}".`);
  if (xmlText(entry.querySelector("title")).toLowerCase() === "error") {
    throw new Error(`arXiv rejected id "${id}": ${xmlText(entry.querySelector("summary"))}`);
  }

  const title = xmlText(entry.querySelector("title")).replace(/\s*\n\s*/g, " ");
  const summary = xmlText(entry.querySelector("summary")).replace(/\s*\n\s*/g, " ");
  const authors = Array.from(entry.querySelectorAll("author > name"))
    .map((n) => xmlText(n))
    .filter(Boolean);
  const published = xmlText(entry.querySelector("published")) || null;
  // journal_ref / comment live in the arXiv namespace; getElementsByTagName on
  // the local name is the least fragile way to reach them.
  const journalRef =
    xmlText(entry.getElementsByTagName("arxiv:journal_ref")[0]) ||
    xmlText(entry.getElementsByTagName("journal_ref")[0]) ||
    null;
  const categories = Array.from(entry.querySelectorAll("category"))
    .map((c) => c.getAttribute("term") ?? "")
    .filter(Boolean);

  const text = tidy(
    [
      title && `Title: ${title}`,
      authors.length && `Authors: ${authors.join(", ")}`,
      categories.length && `arXiv categories: ${categories.join(", ")}`,
      journalRef && `Journal reference: ${journalRef}`,
      summary && `\nAbstract:\n${summary}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return {
    url: canonicalUrl,
    title: title || `arXiv:${id}`,
    text: clip(text),
    contentType: "paper",
    authors,
    publishedAt: published,
    venue: journalRef,
    org: "arXiv",
  };
}

// ------------------------------------------------------------------ PDF ----

async function extractPdf(url: string, res: Response): Promise<ExtractedContent> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  const body = tidy(Array.isArray(text) ? text.join("\n") : text);
  if (!body) throw new Error(`Extracted no text from the PDF at ${url} (it may be scanned images).`);

  // First non-trivial line is very often the paper title.
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 12 && l.length < 200) ?? "";

  return {
    url,
    title: firstLine,
    text: clip(body),
    contentType: "paper",
    authors: [],
    publishedAt: null,
    venue: null,
    org: null,
  };
}

// ----------------------------------------------------------------- HTML ----

function metaOf(doc: Document, names: string[]): string | null {
  for (const name of names) {
    const el =
      doc.querySelector(`meta[property="${name}"]`) ?? doc.querySelector(`meta[name="${name}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return null;
}

function guessContentType(host: string): string {
  const h = host.toLowerCase();
  if (POST_HOST_HINTS.some((x) => h.endsWith(x))) return "post";
  if (BLOG_HOST_HINTS.some((x) => h.endsWith(x))) return "blog";
  if (/^(www\.)?(youtube\.com|youtu\.be|vimeo\.com)$/.test(h)) return "video";
  if (/(^|\.)(docs?|documentation|developer)\./.test(h)) return "docs";
  if (/^blog\./.test(h) || /\.blog$/.test(h)) return "blog";
  // Everything else is a coin flip; the LLM gets the final say downstream.
  return "docs";
}

async function extractHtml(u: URL, res: Response): Promise<ExtractedContent> {
  const html = await res.text();
  const dom = new JSDOM(html, { url: res.url || u.toString() });
  const doc = dom.window.document;

  // Readability mutates the document, so read metadata off it first.
  const metaAuthor = metaOf(doc, [
    "article:author",
    "author",
    "citation_author",
    "twitter:creator",
    "og:article:author",
  ]);
  const publishedAt = metaOf(doc, [
    "article:published_time",
    "citation_publication_date",
    "datePublished",
    "publish_date",
    "date",
  ]);
  const siteName = metaOf(doc, ["og:site_name", "application-name"]);
  const metaTitle = metaOf(doc, ["og:title", "twitter:title"]);
  const docTitle = tidy(doc.title ?? "");
  const bodyFallback = tidy(doc.body?.textContent ?? "");

  let title = "";
  let text = "";
  try {
    const article = new Readability(doc).parse();
    if (article) {
      title = tidy(article.title ?? "");
      text = tidy(article.textContent ?? "");
    }
  } catch {
    // Readability is best-effort; fall through to the raw-body fallback.
  }
  if (!text) text = bodyFallback;
  if (!title) title = metaTitle ?? docTitle;

  if (!text) throw new Error(`No readable text found at ${u.toString()}`);

  const authors = metaAuthor
    ? metaAuthor
        .split(/\s*(?:,| and |&)\s*/)
        .map((a) => a.trim())
        .filter((a) => a.length > 1 && !/^https?:/i.test(a))
    : [];

  return {
    url: res.url || u.toString(),
    title,
    text: clip(text),
    contentType: guessContentType(u.hostname),
    authors,
    publishedAt: publishedAt ?? null,
    venue: null,
    org: siteName ?? null,
  };
}

// ------------------------------------------------------------- dispatch ----

/** Fetch a URL and pull out clean text plus whatever metadata is cheap to get. */
export async function extractContent(url: string): Promise<ExtractedContent> {
  const u = normalizeUrl(url);

  const arxivId = parseArxivId(u);
  if (arxivId) {
    return extractArxiv(arxivId, `https://arxiv.org/abs/${arxivId}`);
  }

  const looksPdf = /\.pdf(?:$|[?#])/i.test(u.pathname + u.search);
  const res = await fetchWithTimeout(
    u.toString(),
    looksPdf ? "application/pdf,*/*" : "text/html,application/xhtml+xml,*/*;q=0.8",
  );
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

  if (looksPdf || contentType.includes("application/pdf")) {
    return extractPdf(res.url || u.toString(), res);
  }
  return extractHtml(u, res);
}
