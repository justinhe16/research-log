import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { papers, searchPapers } from "@/lib/db/schema";
import { updatePaperMetrics, upsertPaper } from "@/lib/landscape/papers/repo";
import { S2_BATCH_SIZE } from "@/lib/landscape/constants";
import { chunks, errMessage, rethrowIfCancelled, tx, warn, yieldNow, s2LookupId, type Env } from "./shared";

/*
 * Stage 7 (enrich): fresh metrics for the part of the pool that can reach the
 * selection (top rerankTopN x 1.5 by rrf; on refresh also every carried-over
 * paper). S2 batch first; OpenAlex by DOI for whatever S2 didn't know. Metrics
 * are then snapshotted onto search_papers for the whole pool.
 *
 * Refresh bypasses the api_cache so citation deltas are real.
 */

type Target = { id: string; s2Id: string | null; arxivId: string | null; doi: string | null };

export function enrichTargets(env: Env): string[] {
  const { db, ctx } = env;
  const n = Math.ceil(ctx.config.rerankTopN * 1.5);
  const top = db
    .select({ id: searchPapers.paperId })
    .from(searchPapers)
    .where(eq(searchPapers.searchId, ctx.searchId))
    .orderBy(desc(sql`coalesce(${searchPapers.rrf}, 0)`), searchPapers.paperId)
    .limit(n)
    .all()
    .map((r) => r.id);
  if (ctx.kind !== "refresh") return top;
  const carried = db
    .select({ id: searchPapers.paperId })
    .from(searchPapers)
    .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.origin, "carryover")))
    .all()
    .map((r) => r.id);
  return [...new Set([...top, ...carried])];
}

function loadTargets(env: Env, ids: string[]): Target[] {
  const byId = new Map<string, Target>();
  for (const part of chunks(ids, 500)) {
    for (const r of env.db
      .select({ id: papers.id, s2Id: papers.s2Id, arxivId: papers.arxivId, doi: papers.doi })
      .from(papers)
      .where(inArray(papers.id, part))
      .all()) {
      byId.set(r.id, r);
    }
  }
  return ids.map((id) => byId.get(id)).filter((t): t is Target => !!t);
}

/** Copy the latest paper metrics onto this search's pool rows. */
function snapshotMetrics(env: Env): void {
  env.db.run(sql`
    UPDATE search_papers SET
      citation_count = p.citation_count,
      influential_citation_count = p.influential_citation_count,
      max_author_h_index = p.max_author_h_index
    FROM papers AS p
    WHERE search_papers.search_id = ${env.ctx.searchId} AND p.id = search_papers.paper_id
  `);
}

export async function enrichStage(env: Env): Promise<void> {
  const { ctx, db, deps } = env;
  const bypass = ctx.kind === "refresh";
  const cache = { db, bypass };

  const targetIds: string[] = Array.isArray(ctx.checkpoint?.targets)
    ? (ctx.checkpoint.targets as string[])
    : enrichTargets(env);
  if (!Array.isArray(ctx.checkpoint?.targets)) ctx.saveCheckpoint({ targets: targetIds });
  let doneBatches = typeof ctx.checkpoint?.doneBatches === "number" ? ctx.checkpoint.doneBatches : 0;
  let enriched = typeof ctx.checkpoint?.enriched === "number" ? ctx.checkpoint.enriched : 0;
  const missingDois: string[] = Array.isArray(ctx.checkpoint?.missingDois) ? (ctx.checkpoint.missingDois as string[]) : [];

  const batches = chunks(targetIds, S2_BATCH_SIZE);
  let s2Failures = 0;
  let attempted = 0;
  for (let b = doneBatches; b < batches.length; b++) {
    ctx.throwIfCancelled();
    const targets = loadTargets(env, batches[b]);
    const lookups = targets.map((t) => ({ t, key: s2LookupId(t) })).filter((x): x is { t: Target; key: string } => !!x.key);
    let results: Awaited<ReturnType<typeof deps.s2BatchPapers>> = [];
    let failed = false;
    if (lookups.length) {
      try {
        results = await deps.s2BatchPapers(lookups.map((x) => x.key), undefined, { cache, signal: ctx.signal });
      } catch (err) {
        rethrowIfCancelled(ctx, err);
        failed = true;
        warn(ctx, `Semantic Scholar metrics batch failed: ${errMessage(err)}`);
      }
    }
    const found = new Set<string>();
    tx(db, () => {
      lookups.forEach(({ t }, i) => {
        const p = results[i];
        if (!p) return;
        // Fill missing external ids / metadata (may merge duplicates), then overwrite metrics.
        const id = upsertPaper(db, { ...p, title: p.title });
        updatePaperMetrics(db, id, {
          citationCount: p.citationCount,
          influentialCitationCount: p.influentialCitationCount,
          maxAuthorHIndex: p.maxAuthorHIndex,
        });
        found.add(t.id);
        enriched++;
      });
    });
    for (const t of targets) {
      if (!found.has(t.id) && t.doi) missingDois.push(t.doi);
    }
    attempted++;
    if (failed) s2Failures++;
    doneBatches = b + 1;
    ctx.saveCheckpoint({ doneBatches, enriched, missingDois });
    ctx.updateCounters({ enriched });
    ctx.setStageProgress((0.8 * doneBatches) / Math.max(1, batches.length));
    await yieldNow();
  }
  if (attempted > 0 && s2Failures === attempted) {
    warn(ctx, "Semantic Scholar metrics unavailable; using OpenAlex only");
  }

  // --- OpenAlex fallback by DOI ---
  if (missingDois.length && ctx.checkpoint?.openalexDone !== true) {
    ctx.throwIfCancelled();
    try {
      const works = await deps.openAlexWorksByDoi([...new Set(missingDois)], { cache, signal: ctx.signal });
      tx(db, () => {
        for (const w of works.values()) {
          const id = upsertPaper(db, w);
          updatePaperMetrics(db, id, { citationCount: w.citationCount });
          enriched++;
        }
      });
    } catch (err) {
      rethrowIfCancelled(ctx, err);
      warn(ctx, `OpenAlex metrics fallback failed: ${errMessage(err)}`);
    }
    ctx.saveCheckpoint({ openalexDone: true, enriched });
  }

  snapshotMetrics(env);
  ctx.updateCounters({ enriched });
  ctx.setStageProgress(1);
}
