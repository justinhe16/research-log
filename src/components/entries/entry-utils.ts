import type { Entry } from "@/lib/types";

export const TERMINAL_INGEST_STATUSES = new Set(["done", "error"]);

export function isIngesting(entry: Entry): boolean {
  return !TERMINAL_INGEST_STATUSES.has(entry.ingestStatus);
}

export function isIngestError(entry: Entry): boolean {
  return entry.ingestStatus === "error";
}

/** Human label for an in-flight ingest step. */
export const INGEST_LABELS: Record<string, string> = {
  pending: "Queued",
  fetching: "Fetching page",
  summarizing: "Summarizing",
  embedding: "Embedding",
  done: "Done",
  error: "Failed",
};

export function ingestLabel(status: string): string {
  return INGEST_LABELS[status] ?? status;
}

/** `https://arxiv.org/abs/1234` -> `arxiv.org`. Falls back to the raw string. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function isValidUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

/** Adds a scheme when the user pasted a bare host, so `arxiv.org/abs/1` works. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function displayTitle(entry: Entry): string {
  return entry.title?.trim() || domainOf(entry.url);
}

/**
 * Splits a summary into readable blocks. Consecutive lines starting with `-`, `*`
 * or `•` become a single list block; everything else becomes a paragraph.
 */
export type SummaryBlock = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

const BULLET_RE = /^\s*[-*•–]\s+/;

export function parseSummary(summary: string): SummaryBlock[] {
  const lines = (summary ?? "").split(/\r?\n/);
  const blocks: SummaryBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: "list", items: list });
    list = [];
  };

  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      flushParagraph();
      list.push(line.replace(BULLET_RE, "").trim());
    } else if (!line.trim()) {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushList();
  flushParagraph();

  return blocks;
}

/** Everything the client-side search box looks at. */
export function searchHaystack(entry: Entry): string {
  return [
    entry.title,
    entry.summary,
    entry.notes,
    entry.whySaved,
    entry.org ?? "",
    entry.venue ?? "",
    entry.url,
    ...entry.tags,
    ...entry.authors,
    ...entry.keyClaims,
  ]
    .join(" ")
    .toLowerCase();
}

export function formatScore(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

export const STATUS_LABELS: Record<string, string> = {
  "to-read": "To read",
  skimmed: "Skimmed",
  read: "Read",
  revisit: "Revisit",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
