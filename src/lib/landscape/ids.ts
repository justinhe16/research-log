/*
 * External-id normalizers. Every id is normalized before it touches `papers`, so
 * the unique indexes actually dedupe: "arXiv:2401.01234v3", the abs URL and the
 * arXiv DOI all collapse to "2401.01234".
 */

/** New-style (0704 onward): YYMM.NNNN or YYMM.NNNNN. */
const NEW_ARXIV = /(\d{4}\.\d{4,5})(?:v\d+)?/;
/** Old-style: archive(.SUBJ)/YYMMNNN, e.g. hep-th/9901001, math.GT/0309136. */
const OLD_ARXIV = /([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/;

/**
 * Accepts a bare id, "arXiv:" prefix, abs/pdf/html URLs (with or without ".pdf"
 * and version), or the 10.48550/arXiv.X DOI. Returns the versionless id, or null.
 */
export function normalizeArxivId(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;

  // DOI form: 10.48550/arXiv.2401.01234 (any resolver prefix).
  const doi = s.match(/10\.48550\/arxiv\.(.+)$/i);
  if (doi) s = doi[1];

  s = s
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html|format)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");

  const anchoredNew = s.match(new RegExp(`^${NEW_ARXIV.source}$`));
  if (anchoredNew) return anchoredNew[1];
  const anchoredOld = s.match(new RegExp(`^${OLD_ARXIV.source}$`, "i"));
  if (anchoredOld) return canonicalOld(anchoredOld[1]);

  return null;
}

/** Old-style archives are lowercase; the optional subject class is uppercase. */
function canonicalOld(id: string): string {
  const [archive, num] = id.split("/");
  const [name, subject] = archive.split(".");
  return `${name.toLowerCase()}${subject ? `.${subject.toUpperCase()}` : ""}/${num}`;
}

/** Find an arXiv id anywhere in a URL or string (for matching logged entries). */
export function findArxivId(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const direct = normalizeArxivId(input);
  if (direct) return direct;
  // Anything else must mention arXiv: a bare "1234.5678" inside an arbitrary URL is not evidence.
  if (!/arxiv/i.test(input)) return null;
  const m = input.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+)/i) ?? input.match(/arxiv[:.]\s*([^\s?#]+)/i);
  return m ? normalizeArxivId(m[1]) : null;
}

/**
 * Lowercased bare DOI ("10.1234/abc"), stripping "doi:" and resolver URLs.
 * DOIs are case-insensitive by spec, so lowercasing is safe for dedupe.
 */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  s = s
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/[?#].*$/, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // Leave malformed percent-escapes as-is.
  }
  s = s.trim().replace(/[.,;]+$/, "");
  return /^10\.\d{4,9}\/\S+$/.test(s) ? s.toLowerCase() : null;
}

/**
 * Title key for fuzzy dedupe: NFKD, strip diacritics / punctuation / markup,
 * lowercase, collapse whitespace. "BERT: Pre-training of Deep..." and
 * "Bert pre-training of deep ..." map to the same key.
 */
export function normalizeTitle(input: string | null | undefined): string {
  if (typeof input !== "string") return "";
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\$[^$]*\$/g, (m) => m.replace(/[\\{}^_$]/g, ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Bare OpenAlex work id ("W123"), from a URL or bare id. */
export function normalizeOpenAlexId(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const m = input.trim().match(/(?:^|\/)(W\d+)$/i);
  return m ? m[1].toUpperCase() : null;
}
