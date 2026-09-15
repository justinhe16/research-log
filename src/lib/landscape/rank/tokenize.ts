import { isStopword } from "./stopwords";

export type TokenizeOptions = {
  /** Apply light suffix stemming. Default true. */
  stem?: boolean;
  /** Drop stopwords (checked before stemming). Default true. */
  removeStopwords?: boolean;
  /** Tokens shorter than this are dropped. Default 2. */
  minLength?: number;
};

// A word is a run of letters/digits, optionally joined by hyphens (ASCII or the
// unicode hyphen / non-breaking hyphen) into a compound.
const WORD_RE = /[\p{L}\p{N}]+(?:[-‐‑][\p{L}\p{N}]+)*/gu;
const HYPHEN_RE = /[-‐‑]/;
const VOWEL_RE = /[aeiouy]/;

/** Lowercase, NFKD-decompose and strip combining marks ("Café" -> "cafe"). */
export function normalizeText(text: string): string {
  return (text ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

function undouble(stem: string): string {
  // "runn" -> "run", "embedd" -> "embed". Keep ll/ss/zz ("fill", "pass"), except
  // British -ell doubling when the result stays long: "modell" -> "model".
  const n = stem.length;
  if (n < 3 || stem[n - 1] !== stem[n - 2]) return stem;
  if (!/[lsz]/.test(stem[n - 1])) return stem.slice(0, -1);
  if (stem.endsWith("ell") && n - 1 >= 5) return stem.slice(0, -1);
  return stem;
}

/** Irregular forms the suffix rules would mangle. */
const STEM_EXCEPTIONS: Record<string, string> = {
  biases: "bias",
  aliases: "alias",
  canvases: "canvas",
};

/**
 * Deliberately light suffix stemmer: plurals, -ing, -ed (-ss/-us/-is/-as words
 * aren't treated as plurals). Enough to conflate
 * "model / models / modeling / modeled" without Porter's surprises. Only
 * applies to purely alphabetic tokens.
 */
export function stem(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  if (STEM_EXCEPTIONS[word]) return STEM_EXCEPTIONS[word];
  let w = word;

  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is|as)$/.test(w) && w.length > 3) w = w.slice(0, -1);

  if (w.endsWith("ing") && w.length >= 6) {
    const base = w.slice(0, -3);
    if (VOWEL_RE.test(base)) w = undouble(base);
  } else if (w.endsWith("ed") && w.length >= 5 && !w.endsWith("eed")) {
    const base = w.slice(0, -2);
    if (VOWEL_RE.test(base)) w = undouble(base);
  }
  return w;
}

/**
 * Split text into ranking terms. Hyphenated compounds yield the joined form
 * ("self-supervised" -> "selfsupervised") plus each part, so both spellings
 * match. Stopword parts are dropped but the compound itself is kept.
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const doStem = opts.stem ?? true;
  const dropStop = opts.removeStopwords ?? true;
  const minLength = opts.minLength ?? 2;
  const out: string[] = [];

  const push = (raw: string) => {
    if (raw.length < minLength) return;
    if (dropStop && isStopword(raw)) return;
    out.push(doStem ? stem(raw) : raw);
  };

  for (const match of normalizeText(text).matchAll(WORD_RE)) {
    const word = match[0];
    if (!HYPHEN_RE.test(word)) {
      push(word);
      continue;
    }
    // Stopword check on the hyphenated surface form ("state-of-the-art").
    if (dropStop && isStopword(word)) continue;
    const parts = word.split(HYPHEN_RE);
    push(parts.join(""));
    for (const part of parts) push(part);
  }
  return out;
}
