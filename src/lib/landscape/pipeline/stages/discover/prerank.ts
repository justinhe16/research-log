import { and, eq, isNull } from "drizzle-orm";
import { papers, searchPapers } from "@/lib/db/schema";
import { cosine, fromBuffer, toBuffer } from "@/lib/embedding";
import { buildBm25Index, scoreBm25 } from "@/lib/landscape/rank/bm25";
import { rrfFuse } from "@/lib/landscape/rank/rrf";
import { topicEmbeddingText } from "@/lib/landscape/topic-dedupe";
import { loadExpansionExtras } from "./plan-expand";
import { chunks, loadSearch, loadTopic, paperEmbeddingText, tx, writeChunked, yieldNow, type Env } from "./shared";

/*
 * Stage 4 (embed) and stage 5 (prerank). Both are also run by the citations
 * stage over newly admitted papers, so they are written as idempotent passes
 * over "whatever in the pool still needs it".
 */

/** Embed every pool paper that has no stored vector. Returns how many were embedded. */
export async function embedPool(env: Env, onProgress?: (done: number, total: number) => void): Promise<number> {
  const { db, ctx, deps } = env;
  const todo = db
    .select({ id: papers.id, title: papers.title, abstract: papers.abstract })
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .where(and(eq(searchPapers.searchId, ctx.searchId), isNull(papers.embedding)))
    .all();
  let done = 0;
  for (const part of chunks(todo, deps.embedChunk)) {
    ctx.throwIfCancelled();
    const vectors = await deps.embedMany(part.map(paperEmbeddingText));
    tx(db, () => {
      part.forEach((p, i) => {
        db.update(papers).set({ embedding: toBuffer(vectors[i]) }).where(eq(papers.id, p.id)).run();
      });
    });
    done += part.length;
    onProgress?.(done, todo.length);
    await yieldNow();
  }
  return done;
}

export async function embedStage(env: Env): Promise<void> {
  const { ctx } = env;
  const before = typeof ctx.checkpoint?.embedded === "number" ? ctx.checkpoint.embedded : 0;
  const n = await embedPool(env, (done, total) => {
    ctx.setStageProgress(total ? done / total : 1);
    ctx.saveCheckpoint({ embedded: before + done });
    ctx.updateCounters({ embedded: before + done });
  });
  ctx.updateCounters({ embedded: before + n });
  ctx.setStageProgress(1);
}

/** Topic vector: stored one if present, else embedded now (not written back). */
export async function topicVector(env: Env): Promise<Float32Array | null> {
  const topic = loadTopic(env.db, env.ctx.topicId);
  if (topic.embedding) {
    try {
      return fromBuffer(topic.embedding);
    } catch {
      // fall through to re-embedding
    }
  }
  const [v] = await env.deps.embedMany([topicEmbeddingText(topic.name, topic.description)]);
  return v ?? null;
}

/**
 * BM25 over the whole pool (IDF depends on the pool, so it's always recomputed),
 * max cosine against the topic + query vectors (only for rows without one), a
 * source-rank list, fused with RRF. Rows lacking an embedding get no cosine rank.
 */
export async function prerankPool(env: Env): Promise<number> {
  const { db, ctx, deps } = env;
  const search = loadSearch(db, ctx.searchId);
  const topic = loadTopic(db, ctx.topicId);
  const extras = loadExpansionExtras(env, ctx.searchId);

  const rows = db
    .select({
      paperId: searchPapers.paperId,
      cosine: searchPapers.cosine,
      sourceRank: searchPapers.sourceRank,
      queryHits: searchPapers.queryHits,
      title: papers.title,
      abstract: papers.abstract,
      embedding: papers.embedding,
    })
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .where(eq(searchPapers.searchId, ctx.searchId))
    .all();
  if (!rows.length) return 0;

  // --- BM25 ---
  const index = buildBm25Index(rows.map((r) => ({ id: r.paperId, fields: { title: r.title, abstract: r.abstract } })));
  const queryTerms = [topic.name, ...search.queries.map((q) => q.text)];
  const bm25 = scoreBm25(index, queryTerms, { excludeTerms: extras.excludeTerms });
  await yieldNow();
  ctx.throwIfCancelled();

  // --- cosine (max over topic + queries), only where missing ---
  const cos = new Map<string, number>();
  for (const r of rows) if (r.cosine != null) cos.set(r.paperId, r.cosine);
  const missing = rows.filter((r) => r.cosine == null && r.embedding);
  if (missing.length) {
    const refs: Float32Array[] = [];
    const tv = await topicVector(env);
    if (tv) refs.push(tv);
    const qTexts = search.queries.map((q) => q.text).filter((t) => t.trim());
    if (qTexts.length) refs.push(...(await deps.embedMany(qTexts)));
    for (let i = 0; i < missing.length; i++) {
      const v = fromBuffer(missing[i].embedding!);
      let best = -1;
      for (const ref of refs) best = Math.max(best, cosine(v, ref));
      cos.set(missing[i].paperId, refs.length ? best : 0);
      if (i % 200 === 199) await yieldNow();
    }
  }
  ctx.throwIfCancelled();

  // --- fuse ---
  const cosineRanking = [...cos.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ({ id }));
  const sourceRanking = rows
    .filter((r) => r.sourceRank != null)
    .sort((a, b) => a.sourceRank! - b.sourceRank! || (b.queryHits?.length ?? 0) - (a.queryHits?.length ?? 0))
    .map((r) => ({ id: r.paperId }));
  const fused = rrfFuse(
    new Map([
      ["bm25", bm25],
      ["cosine", cosineRanking],
      ["source", sourceRanking],
    ]),
  );
  const rrf = new Map(fused.map((f) => [f.id, f.score]));
  const bm = new Map(bm25.map((b) => [b.id, b.score]));

  await writeChunked(db, rows, (r) => {
    db.update(searchPapers)
      .set({ bm25: bm.get(r.paperId) ?? 0, cosine: cos.get(r.paperId) ?? null, rrf: rrf.get(r.paperId) ?? 0 })
      .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.paperId, r.paperId)))
      .run();
  });
  return rows.length;
}

export async function prerankStage(env: Env): Promise<void> {
  const n = await prerankPool(env);
  env.ctx.updateCounters({ candidates: n });
  env.ctx.setStageProgress(1);
}
