import type { Db } from "@/lib/db/create";
import { topics } from "@/lib/db/schema";
import type { SimilarTopic } from "@/lib/landscape/types";

/*
 * In-process serialization for check-then-create flows. The app runs as a single
 * Node process, so a promise chain per key is enough to stop two concurrent
 * requests from both passing a "does it exist?" check. Cached on globalThis so dev
 * HMR re-evaluations share one chain.
 */

const g = globalThis as unknown as { __landscapeLocks?: Map<string, Promise<unknown>> };
const locks: Map<string, Promise<unknown>> = (g.__landscapeLocks ??= new Map());

/** Run `fn` after every earlier `withLock(key, ...)` call has settled. */
export function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // The chain must never reject, or the next caller would skip its turn semantics.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/** Case-, whitespace- and Unicode-insensitive topic name key. */
export function normalizeTopicName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Existing topics whose name normalizes to the same key (similarity 1). */
export function exactNameMatches(db: Db, name: string): SimilarTopic[] {
  const key = normalizeTopicName(name);
  return db
    .select({
      id: topics.id,
      slug: topics.slug,
      name: topics.name,
      description: topics.description,
      lastSearchAt: topics.lastSearchAt,
      paperCount: topics.paperCount,
    })
    .from(topics)
    .all()
    .filter((t) => normalizeTopicName(t.name) === key)
    .map((t) => ({ ...t, similarity: 1 }));
}
