import { and, eq, inArray, isNull } from "drizzle-orm";
import { papers, searchPapers } from "@/lib/db/schema";
import { cosine, toBuffer } from "@/lib/embedding";
import { CANONICAL_MIN_COSINE } from "@/lib/landscape/constants";
import { upsertPapers } from "@/lib/landscape/papers/repo";
import type { PaperInput } from "@/lib/landscape/types";
import { cleanText } from "@/lib/sanitize";
import { topicVector } from "./prerank";
import { chunks, errMessage, loadTopic, paperEmbeddingText, rethrowIfCancelled, tx, warn, type Env } from "./shared";

/*
 * Canonical-paper recall (part of collect). Relevance-ranked keyword search under-samples
 * the field's seminal papers: a four-year window of relevance hits is dominated by recent
 * niche method papers, and without S2 there is no citation graph to surface the classics.
 * So the topic query is also run sorted by citation count (OpenAlex, plus S2 bulk search
 * when a key is set). Citation-sorted keyword hits are mostly off-topic (e.g. "sparse
 * autoencoder" intrusion detection), so each is admitted only if its title + abstract
 * embedding has cosine >= CANONICAL_MIN_COSINE to the topic vector, most cited first, up
 * to `config.canonical.maxAdmitted`. Rejected works are never written to `papers`.
 *
 * Admitted ids are recorded on the collect checkpoint (`canonicalIds`); the pool cap
 * ignores them and the rerank stage always scores them.
 */

export type CanonicalCandidate = { input: PaperInput; similarity: number };

/** Pure: dedupe by title, gate on similarity, most cited first, cap. */
export function pickCanonical(candidates: readonly CanonicalCandidate[], maxAdmitted: number, minCosine = CANONICAL_MIN_COSINE): CanonicalCandidate[] {
  const byTitle = new Map<string, CanonicalCandidate>();
  for (const c of candidates) {
    if (!(c.similarity >= minCosine)) continue;
    const key = c.input.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const prev = byTitle.get(key);
    if (!prev || (c.input.citationCount ?? -1) > (prev.input.citationCount ?? -1)) byTitle.set(key, c);
  }
  return [...byTitle.values()]
    .sort((a, b) => (b.input.citationCount ?? -1) - (a.input.citationCount ?? -1) || b.similarity - a.similarity)
    .slice(0, Math.max(0, maxAdmitted));
}

/** Topic query text for citation-sorted search: the cleaned topic name. */
export function canonicalQuery(name: string): string {
  return cleanText(name).replace(/\s+/g, " ").trim();
}

export function canonicalIdsFrom(cp: Record<string, unknown> | null | undefined): string[] {
  const v = cp?.canonicalIds;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Run canonical recall once per search (checkpointed as `canonicalDone`). Skipped on refresh
 * (the base selection is carried over) and when the config has no `canonical` block.
 * Source failures are warnings. Returns the admitted paper ids.
 */
export async function collectCanonical(env: Env, s2Available: boolean): Promise<string[]> {
  const { ctx, deps, db } = env;
  const cfg = ctx.config.canonical;
  if (ctx.checkpoint?.canonicalDone === true) return canonicalIdsFrom(ctx.checkpoint);
  if (!cfg || cfg.maxAdmitted <= 0 || cfg.perSource <= 0 || ctx.kind === "refresh") return [];

  const topic = loadTopic(db, ctx.topicId);
  const query = canonicalQuery(topic.name);
  const now = deps.now();
  // Foundations can predate the publication window; look back twice as far.
  const fromYear = ctx.config.windowYears ? now.getUTCFullYear() - 2 * ctx.config.windowYears : null;
  const since = fromYear != null ? `${fromYear}-01-01` : null;
  const inputs: PaperInput[] = [];

  try {
    inputs.push(
      ...(await deps.searchOpenAlex(query, {
        limit: cfg.perSource,
        since,
        sort: "citations",
        cache: { db },
        signal: ctx.signal,
        onRelaxed: (info) => ctx.log(`canonical: OpenAlex found nothing for "${info.query}"; relaxed retry found ${info.relaxedResults}`),
      })),
    );
  } catch (err) {
    rethrowIfCancelled(ctx, err);
    warn(ctx, `canonical recall: OpenAlex citation search failed: ${errMessage(err)}`);
  }
  ctx.throwIfCancelled();
  if (s2Available) {
    try {
      inputs.push(
        ...(await deps.searchS2ByCitations(query, {
          limit: cfg.perSource,
          yearRange: fromYear != null ? { from: fromYear } : null,
          cache: { db },
          signal: ctx.signal,
        })),
      );
    } catch (err) {
      rethrowIfCancelled(ctx, err);
      warn(ctx, `canonical recall: Semantic Scholar citation search failed: ${errMessage(err)}`);
    }
    ctx.throwIfCancelled();
  }

  let admittedIds: string[] = [];
  if (inputs.length) {
    const tv = await topicVector(env);
    const vectors = await deps.embedMany(inputs.map((p) => paperEmbeddingText({ title: p.title, abstract: p.abstract ?? null })));
    ctx.throwIfCancelled();
    const candidates = inputs.map((input, i) => ({ input, similarity: tv && vectors[i] ? cosine(tv, vectors[i]) : 0, vector: vectors[i] }));
    const picked = pickCanonical(candidates, cfg.maxAdmitted);
    const vectorOf = new Map(candidates.map((c) => [c.input, c.vector]));
    admittedIds = upsertPapers(db, picked.map((c) => c.input));
    const unique = [...new Set(admittedIds)];
    tx(db, () => {
      picked.forEach((c, i) => {
        const v = vectorOf.get(c.input);
        if (v) {
          db.update(papers)
            .set({ embedding: toBuffer(v) })
            .where(and(eq(papers.id, admittedIds[i]), isNull(papers.embedding)))
            .run();
        }
      });
    });
    for (const part of chunks(unique)) {
      tx(db, () => {
        const present = new Set(
          db
            .select({ paperId: searchPapers.paperId })
            .from(searchPapers)
            .where(and(eq(searchPapers.searchId, ctx.searchId), inArray(searchPapers.paperId, part)))
            .all()
            .map((r) => r.paperId),
        );
        for (const paperId of part) {
          if (present.has(paperId)) continue;
          db.insert(searchPapers).values({ searchId: ctx.searchId, paperId, origin: "query", queryHits: [] }).run();
        }
      });
    }
    admittedIds = unique;
    const titles = picked.slice(0, 5).map((c) => `"${c.input.title.slice(0, 60)}" (${c.input.citationCount ?? "?"})`);
    ctx.log(`canonical: ${inputs.length} citation-sorted hits, ${admittedIds.length} admitted (cosine >= ${CANONICAL_MIN_COSINE})${titles.length ? `: ${titles.join(", ")}` : ""}`);
  }
  ctx.saveCheckpoint({ canonicalDone: true, canonicalIds: admittedIds });
  ctx.updateCounters({ canonicalAdmitted: admittedIds.length });
  return admittedIds;
}
