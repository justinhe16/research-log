import { MAX_INVALID_REF_RATE } from "@/lib/landscape/constants";
import { normalizeRef } from "./synthesize/schemas";

/*
 * Dossier refs ("P12") -> internal paper ids. The model is only ever shown refs;
 * everything it sends back is resolved here. Unknown refs are dropped silently
 * (per-list), but tallied so a call that mostly hallucinated refs can be retried.
 */

export type RefMap = Readonly<Record<string, string>>;

export type RefStats = {
  total: number;
  invalid: number;
  /** 0..1; 0 when no refs were seen. */
  invalidRatio: number;
  /** Distinct invalid refs as sent (normalized), for logs. */
  invalidRefs: string[];
};

/** Too many refs in one LLM answer didn't exist in the dossier. Retry the call. */
export class InvalidRefsError extends Error {
  readonly retryable = true;
  constructor(readonly stats: RefStats, context = "document") {
    super(
      `${context}: ${stats.invalid}/${stats.total} refs were not in the dossier (${Math.round(stats.invalidRatio * 100)}% > ${Math.round(MAX_INVALID_REF_RATE * 100)}%): ${stats.invalidRefs.slice(0, 8).join(", ")}`,
    );
    this.name = "InvalidRefsError";
  }
}

export function isRetryableRefError(err: unknown): err is InvalidRefsError {
  return err instanceof InvalidRefsError;
}

export type RefResolver = {
  /** One ref -> paperId, or null (counted as invalid). */
  one(ref: string): string | null;
  /** Many refs -> distinct paperIds in first-seen order; unknown dropped. */
  many(refs: readonly string[]): string[];
  stats(): RefStats;
  /** Throws InvalidRefsError when the invalid share exceeds `maxRate`. */
  assertValid(context?: string, maxRate?: number): void;
};

/** A resolver accumulates stats across every ref in one LLM answer. */
export function createRefResolver(refMap: RefMap | ReadonlyMap<string, string>): RefResolver {
  const lookup = (r: string): string | undefined =>
    refMap instanceof Map
      ? refMap.get(r)
      : Object.prototype.hasOwnProperty.call(refMap, r)
        ? (refMap as RefMap)[r]
        : undefined;
  let total = 0;
  const invalid: string[] = [];

  const one = (ref: string): string | null => {
    const key = normalizeRef(String(ref ?? ""));
    total += 1;
    const id = lookup(key);
    if (!id) {
      invalid.push(key);
      return null;
    }
    return id;
  };

  const stats = (): RefStats => ({
    total,
    invalid: invalid.length,
    invalidRatio: total === 0 ? 0 : invalid.length / total,
    invalidRefs: Array.from(new Set(invalid)),
  });

  return {
    one,
    many(refs) {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const r of refs) {
        const id = one(r);
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      return out;
    },
    stats,
    assertValid(context, maxRate = MAX_INVALID_REF_RATE) {
      const s = stats();
      if (s.total > 0 && s.invalidRatio > maxRate) throw new InvalidRefsError(s, context);
    },
  };
}

/** One-shot convenience: map a list and report. */
export function mapRefs(refs: readonly string[], refMap: RefMap): { paperIds: string[]; stats: RefStats } {
  const r = createRefResolver(refMap);
  const paperIds = r.many(refs);
  return { paperIds, stats: r.stats() };
}
