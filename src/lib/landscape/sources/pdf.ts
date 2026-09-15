/**
 * Full-text helpers for the `fulltext` stage: fetch a paper PDF (arXiv first, then
 * the open-access URL), extract its text with unpdf, and cut a section-aware
 * excerpt that fits the extraction prompt.
 *
 * Server-only for `fetchPaperPdf` / `extractPdfText`; `excerptForExtraction` is pure.
 */
import { FULLTEXT_PROMPT_MAX_CHARS, PDF_MAX_BYTES } from "../constants";
import { normalizeArxivId } from "../ids";
import type { FetchBytesOptions, FetchedBytes } from "./http";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function tidy(s: string): string {
  return s.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text of a PDF (same unpdf path as `extractPdf` in src/lib/ingest/extract.ts). */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js may detach the buffer it is handed; keep the caller's bytes intact.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: tidy(Array.isArray(text) ? text.join("\n") : text), pages: totalPages };
}

// ---------------------------------------------------------------------------
// Excerpt
// ---------------------------------------------------------------------------

export type SectionKind =
  | "abstract"
  | "intro"
  | "method"
  | "experiments"
  | "results"
  | "conclusion"
  | "skip"
  | "end";

/** Sections kept in the excerpt, in output order. */
const WANTED: SectionKind[] = ["abstract", "intro", "method", "experiments", "results", "conclusion"];

const HEADING_WORDS: [SectionKind, RegExp][] = [
  ["abstract", /^abstract$/],
  ["intro", /^introduction$|^overview$/],
  [
    "method",
    /^(?:(?:our|proposed)\s+)?(?:methods?|methodology|approach|model|framework|preliminaries|problem (?:setup|formulation|statement)|background and method)$/,
  ],
  ["experiments", /^(?:experiments?|experimental (?:setup|settings?|results|evaluation)|evaluation|empirical (?:results|evaluation|study)|setup)$/],
  ["results", /^(?:results?|results and discussion|main results|analysis|discussion)$/],
  ["conclusion", /^(?:conclusions?|concluding remarks|conclusion and future work|conclusions and future work|summary|limitations)$/],
  ["skip", /^(?:related work|background|prior work|literature review)$/],
  ["end", /^(?:references|bibliography|acknowledge?ments?|appendix|appendices|supplementary material)$/],
];

/** Optional numbering: "3", "3.", "3.1", "III.", "A." (appendix-style letters only before "end"-ish words). */
const NUMBERING = /^(?:(?:\d{1,2}(?:\.\d{1,2})*|[ivx]{1,5}|[a-z])\.?\s+)?/i;

export type Heading = { kind: SectionKind; index: number; line: string };

/** Classify a single line as a section heading, or null. */
export function classifyHeading(line: string): SectionKind | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 60) return null;
  const numbered = NUMBERING.exec(trimmed)?.[0] ?? "";
  // Subsections ("3.1 Model") are too noisy to split on; keep them inside the parent.
  if (/\d+\.\d+/.test(numbered)) return null;
  const words = trimmed.slice(numbered.length).replace(/[:.]\s*$/, "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!words) return null;
  for (const [kind, re] of HEADING_WORDS) if (re.test(words)) return kind;
  return null;
}

/** Headings found line by line, with their character offsets into `text`. */
export function findHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    const kind = classifyHeading(line);
    if (kind) out.push({ kind, index, line: line.trim() });
    index += line.length + 1;
  }
  // Inline "Abstract" at the start of a line followed by text ("Abstract We propose ...").
  if (!out.some((h) => h.kind === "abstract")) {
    const m = /(^|\n)\s*abstract[\s.:—-]+(?=\S)/i.exec(text.slice(0, 5000));
    if (m) out.push({ kind: "abstract", index: m.index + m[1].length, line: "Abstract" });
  }
  return out.sort((a, b) => a.index - b.index);
}

function headTail(text: string, maxChars: number): string {
  const sep = "\n\n[...]\n\n";
  const head = Math.floor((maxChars - sep.length) * 0.7);
  const tail = maxChars - sep.length - head;
  return `${text.slice(0, head).trimEnd()}${sep}${text.slice(text.length - tail).trimStart()}`;
}

/** Split `budget` across section lengths, giving short sections their full length. */
function allocate(lengths: number[], budget: number): number[] {
  const alloc = lengths.map(() => 0);
  let remaining = budget;
  let open = lengths.map((_, i) => i);
  while (open.length && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) break;
    const next: number[] = [];
    for (const i of open) {
      const want = lengths[i] - alloc[i];
      const give = Math.min(want, share);
      alloc[i] += give;
      remaining -= give;
      if (alloc[i] < lengths[i]) next.push(i);
    }
    open = next;
  }
  return alloc;
}

/**
 * Pick abstract / intro / method / experiments / results / conclusion from paper
 * text by heading, dropping related work, references and appendices. Sections that
 * don't fit are truncated proportionally. Falls back to head (70%) + tail (30%) of
 * the body (references cut off) when fewer than two wanted sections are found.
 */
export function excerptForExtraction(text: string, maxChars = FULLTEXT_PROMPT_MAX_CHARS): string {
  const clean = tidy(text ?? "");
  if (clean.length <= maxChars) return clean;

  const headings = findHeadings(clean);
  const firstEnd = headings.find((h) => h.kind === "end" && h.index > clean.length * 0.3);
  const body = firstEnd ? clean.slice(0, firstEnd.index).trimEnd() : clean;

  type Section = { kind: SectionKind; text: string };
  const sections: Section[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!WANTED.includes(h.kind)) continue;
    if (h.index >= body.length) break;
    const end = Math.min(headings[i + 1]?.index ?? body.length, body.length);
    const chunk = body.slice(h.index, end).trim();
    if (chunk.length > h.line.length + 20) sections.push({ kind: h.kind, text: chunk });
  }

  const distinct = new Set(sections.map((s) => s.kind));
  if (distinct.size < 2) return body.length <= maxChars ? body : headTail(body, maxChars);

  // Title/authors block before the first heading, briefly.
  const preamble = headings.length ? body.slice(0, Math.min(headings[0].index, 1500)).trim() : "";
  const sep = "\n\n";
  const parts = preamble ? [{ kind: "abstract" as SectionKind, text: preamble }, ...sections] : sections;
  const overhead = sep.length * (parts.length - 1) + parts.length * 6; // room for " [...]" markers
  const alloc = allocate(
    parts.map((p) => p.text.length),
    Math.max(0, maxChars - overhead),
  );

  const out = parts
    .map((p, i) => (alloc[i] >= p.text.length ? p.text : alloc[i] > 0 ? `${p.text.slice(0, alloc[i]).trimEnd()} [...]` : ""))
    .filter(Boolean)
    .join(sep);
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export type FetchBytesFn = (url: string, opts: FetchBytesOptions) => Promise<FetchedBytes>;

export type FetchPaperPdfOptions = {
  fetchBytes?: FetchBytesFn;
  signal?: AbortSignal;
  maxBytes?: number;
};

export type FetchedPaperPdf = { bytes: Uint8Array; url: string; via: "arxiv" | "pdfUrl" };

const defaultFetchBytes: FetchBytesFn = async (url, opts) => {
  const http = await import("./http");
  return http.fetchBytes(url, opts);
};

/** Candidate PDF URLs in preference order (arXiv first, then an http(s) pdfUrl). */
export function pdfCandidates(paper: { arxivId?: string | null; pdfUrl?: string | null }): { url: string; via: "arxiv" | "pdfUrl" }[] {
  const out: { url: string; via: "arxiv" | "pdfUrl" }[] = [];
  const arxivId = normalizeArxivId(paper.arxivId) ?? normalizeArxivId(paper.pdfUrl);
  if (arxivId) out.push({ url: `https://arxiv.org/pdf/${arxivId}`, via: "arxiv" });
  const pdfUrl = paper.pdfUrl?.trim();
  if (pdfUrl && /^https?:\/\//i.test(pdfUrl) && !out.some((c) => c.url === pdfUrl) && !(arxivId && normalizeArxivId(pdfUrl))) {
    out.push({ url: pdfUrl, via: "pdfUrl" });
  }
  return out;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF" may be preceded by a little junk; the spec allows it within the first 1024 bytes.
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i + 3 < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

/**
 * Download a paper's PDF. Returns null when the paper has no candidate URL; throws the
 * last error when every candidate failed (HTTP error, size cap, not a PDF, unsafe URL).
 */
export async function fetchPaperPdf(
  paper: { arxivId?: string | null; pdfUrl?: string | null },
  opts: FetchPaperPdfOptions = {},
): Promise<FetchedPaperPdf | null> {
  const candidates = pdfCandidates(paper);
  if (!candidates.length) return null;
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  let lastError: unknown = null;
  for (const c of candidates) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    try {
      const res = await fetchBytes(c.url, {
        maxBytes: opts.maxBytes ?? PDF_MAX_BYTES,
        signal: opts.signal,
        headers: { Accept: "application/pdf" },
      });
      if (!looksLikePdf(res.bytes)) throw new Error(`Not a PDF: ${c.url} (${res.contentType ?? "unknown type"})`);
      return { bytes: res.bytes, url: res.url || c.url, via: c.via };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
