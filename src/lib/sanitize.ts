/** Text coming back from the model is not trusted markup-free: because the prompt
 *  wraps page content in <document> tags, the model sometimes mimics that style and
 *  wraps its own output (e.g. each key claim in <item>...</item>). Extracted page
 *  text can also carry stray fragments and HTML entities.
 *
 *  These helpers scrub that at the ingest boundary so no markup is ever stored. */

/** Matches only things that genuinely look like tags: `<` followed by an optional
 *  slash and then a LETTER. This deliberately leaves prose like "x < y" and
 *  "n <= 10" intact, which a naive /<[^>]*>/ would destroy in a math-heavy paper. */
const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\/?>/g;

/** Unclosed leading/trailing fragments left by truncation, e.g. a dangling "<div". */
const DANGLING_RE = /<\/?[a-zA-Z][^<>]*$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Ignore control chars and out-of-range values rather than emitting junk.
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function stripTags(input: string): string {
  return input.replace(TAG_RE, "").replace(DANGLING_RE, "");
}

/** Full scrub for a single line of model-authored text. */
export function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  // Decode first, then strip: an encoded "&lt;script&gt;" should become inert
  // text, not survive as a tag. Strip again afterwards to catch double-encoding.
  let out = stripTags(decodeEntities(input));
  if (/[<&]/.test(out)) out = stripTags(decodeEntities(out));
  return out.replace(/[ \t ]+/g, " ").trim();
}

/** Same as cleanText but preserves paragraph/bullet line structure. */
export function cleanMultiline(input: unknown): string {
  if (typeof input !== "string") return "";
  return cleanText(input.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
