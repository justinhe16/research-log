/*
 * Zod preprocessors for model-authored tool input. The model is told the schema
 * and usually follows it, but intermittently serializes arrays as strings or
 * fills optional fields with the string "null". Rejecting that outright throws
 * away an otherwise good answer, so normalize at the boundary instead.
 */

/** The model is told to return arrays, and usually does -- but it intermittently
 *  serializes them as a JSON string ('["a","b"]') or a delimited string instead.
 *  Rejecting that outright fails an otherwise perfectly good analysis, so coerce.
 *
 *  `commaSplit` is off for prose: claim sentences legitimately contain commas, so
 *  those only ever split on line/bullet boundaries. */
export function toStringArray(value: unknown, commaSplit: boolean): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;

  const raw = value.trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON after all -- fall through to delimiter splitting.
    }
  }

  const lines = raw.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  const parts = lines.length > 1 || !commaSplit ? lines : raw.split(/[,;]+/);

  return parts
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

/** Preprocessor for string arrays of prose (never comma-split). */
export const prose = (v: unknown) => toStringArray(v, false);
/** Preprocessor for string arrays of short keywords / refs (comma-split allowed). */
export const keywords = (v: unknown) => toStringArray(v, true);

/** For arrays of OBJECTS: the model sometimes sends the whole array (or a single
 *  object) JSON-encoded as a string. Parse that; wrap a lone object in an array.
 *  Anything else passes through for zod to reject with a real message. */
export function toObjectArray(value: unknown): unknown {
  let v = value;
  if (typeof v === "string") {
    const raw = v.trim();
    if (!raw) return [];
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        v = JSON.parse(raw);
      } catch {
        return value;
      }
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return [v];
  return v;
}

/** For a nested OBJECT field sent as a JSON string. */
export function toObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw.startsWith("{")) return value;
  try {
    return JSON.parse(raw);
  } catch {
    return value;
  }
}

/** The model sometimes fills an optional field with the *string* "null" (or
 *  "none"/"n/a") instead of omitting it. Persisting that means every consumer
 *  has to defend against it, so normalize to a real null at the boundary. */
const NOT_A_VALUE = new Set(["null", "undefined", "none", "n/a", "na", "unknown", "-", ""]);

export function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return NOT_A_VALUE.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** Numbers sent as strings ("2021", "2021-ish"); returns the input untouched if
 *  no leading number is found so zod reports it. Null-like strings become null. */
export function toNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (nullableText(value) === null) return null;
  const match = value.trim().match(/^-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : value;
}
