import { and, eq, like, ne, or } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { topics } from "@/lib/db/schema";

export const SLUG_MAX = 60;
const FALLBACK_SLUG = "topic";

/**
 * URL slug: ASCII-fold (NFKD, strip diacritics), lowercase, runs of anything
 * non-alphanumeric become one hyphen, trimmed to SLUG_MAX at a hyphen boundary
 * when possible. Never empty: names with no ASCII letters/digits fall back to "topic".
 */
export function slugify(name: string | null | undefined): string {
  const base = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return FALLBACK_SLUG;
  if (base.length <= SLUG_MAX) return base;

  const cut = base.slice(0, SLUG_MAX);
  const lastHyphen = cut.lastIndexOf("-");
  // Only back off to a word boundary if it doesn't throw away most of the slug.
  const trimmed = lastHyphen >= SLUG_MAX / 2 ? cut.slice(0, lastHyphen) : cut;
  return trimmed.replace(/-+$/g, "") || FALLBACK_SLUG;
}

/**
 * A slug not yet used by any topic: `slugify(name)`, then `-2`, `-3`, ...
 * The suffixed form still respects SLUG_MAX. Pass `excludeId` when renaming a
 * topic so it doesn't collide with its own current slug.
 *
 * Not race-proof on its own (the unique index is the real guard); callers insert
 * synchronously right after, which is atomic under better-sqlite3.
 */
/** Anything that can run a select: the root db or a transaction handle. */
export type Queryable = Pick<Db, "select">;

export function uniqueSlug(db: Queryable, name: string, excludeId?: string): string {
  const base = slugify(name);
  const pattern = or(eq(topics.slug, base), like(topics.slug, `${base.slice(0, SLUG_MAX - 8).replace(/-+$/g, "")}%`));
  const taken = new Set(
    db
      .select({ slug: topics.slug })
      .from(topics)
      .where(excludeId ? and(pattern, ne(topics.id, excludeId)) : pattern)
      .all()
      .map((r) => r.slug),
  );
  if (!taken.has(base)) return base;

  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, "");
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
