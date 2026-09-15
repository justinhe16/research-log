/*
 * Stage 10 (cluster): seeded spherical k-means over the selection's embeddings,
 * k by silhouette, c-TF-IDF key terms, and (with a base search) matching against
 * the base clusters.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searchClusters, searchPapers } from "@/lib/db/schema";
import { fromBuffer, toBuffer } from "@/lib/embedding";
import { chooseK } from "@/lib/landscape/cluster/kmeans";
import { matchClusters, type MatchableCluster } from "@/lib/landscape/cluster/match";
import { hashSeed } from "@/lib/landscape/cluster/prng";
import { clusterKeyTerms, placeholderLabel } from "@/lib/landscape/cluster/terms";
import type { StageContext } from "@/lib/landscape/types";
import { chunkedWrite, loadPool, resolveDb, yieldLoop, type StructureDeps } from "./shared";

/** Clusters of a search with centroids and selected members, for matching / diffs. */
export function loadMatchableClusters(db: Db, searchId: string): MatchableCluster[] {
  const rows = db
    .select()
    .from(searchClusters)
    .where(eq(searchClusters.searchId, searchId))
    .orderBy(asc(searchClusters.idx))
    .all();
  if (rows.length === 0) return [];
  const members = db
    .select({ paperId: searchPapers.paperId, clusterIdx: searchPapers.clusterIdx })
    .from(searchPapers)
    .where(and(eq(searchPapers.searchId, searchId), eq(searchPapers.selected, true)))
    .orderBy(asc(searchPapers.finalRank), asc(searchPapers.paperId))
    .all();
  return rows.map((r) => {
    let centroid: Float32Array = new Float32Array(0);
    if (r.centroid) {
      try {
        centroid = fromBuffer(r.centroid);
      } catch {
        // Unreadable centroid: matching falls back to member overlap only.
      }
    }
    return {
      idx: r.idx,
      centroid,
      label: r.label,
      members: members.filter((m) => m.clusterIdx === r.idx).map((m) => m.paperId),
    };
  });
}

export async function clusterStage(ctx: StageContext, deps: StructureDeps): Promise<void | "skipped"> {
  const db = await resolveDb(ctx, deps);
  const selected = loadPool(db, ctx.searchId, { selectedOnly: true });
  const withEmb: { p: (typeof selected)[number]; v: Float32Array }[] = [];
  for (const p of selected) {
    if (!p.paper.embedding) continue;
    try {
      withEmb.push({ p, v: fromBuffer(p.paper.embedding) });
    } catch {
      /* skip */
    }
  }
  if (withEmb.length === 0) {
    ctx.log("cluster: no embedded selected papers");
    return "skipped";
  }
  ctx.setStageProgress(0.1);
  await yieldLoop();

  const { min, max } = ctx.config.kRange;
  const res = chooseK(
    withEmb.map((x) => x.v),
    [min, max],
    // Seeded per topic, not per search: k-means on a loose selection is seed-sensitive, and a
    // refresh with an unchanged selection must reproduce the base partition, or the diff
    // reports spurious grew/shrank clusters (seen in the smoke refresh).
    hashSeed(ctx.topicId),
  );
  ctx.throwIfCancelled();
  ctx.setStageProgress(0.6);
  await yieldLoop();

  // Re-index: largest cluster first, ties by best member rank, so idx/colours are stable and meaningful.
  const groups = Array.from({ length: res.k }, (_, c) => ({
    old: c,
    members: withEmb.filter((_, i) => res.labels[i] === c),
  })).filter((g) => g.members.length > 0);
  groups.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      (a.members[0].p.finalRank ?? Number.MAX_SAFE_INTEGER) - (b.members[0].p.finalRank ?? Number.MAX_SAFE_INTEGER),
  );

  const terms = clusterKeyTerms(
    groups.flatMap((g, idx) =>
      g.members.map(({ p }) => ({ clusterIdx: idx, text: `${p.paper.title}\n${p.paper.abstract ?? ""}` })),
    ),
  );

  const clusters = groups.map((g, idx) => {
    const years = g.members.map(({ p }) => p.paper.year).filter((y): y is number => y != null);
    return {
      idx,
      old: g.old,
      memberIds: g.members.map(({ p }) => p.paperId),
      keyTerms: terms[idx] ?? [],
      label: placeholderLabel(terms[idx] ?? []),
      centroid: res.centroids[g.old],
      size: g.members.length,
      yearMin: years.length ? Math.min(...years) : null,
      yearMax: years.length ? Math.max(...years) : null,
    };
  });

  // Refresh / full re-run: match against the base search's clusters.
  const matchRows = new Map<number, { baseClusterIdx: number | null; change: (typeof searchClusters.$inferInsert)["change"] }>();
  if (ctx.baseSearchId) {
    const base = loadMatchableClusters(db, ctx.baseSearchId);
    if (base.length) {
      const match = matchClusters(
        base,
        clusters.map((c) => ({ idx: c.idx, centroid: c.centroid, members: c.memberIds, label: c.label })),
      );
      for (const row of match.current) matchRows.set(row.idx, { baseClusterIdx: row.baseClusterIdx, change: row.change });
    }
  }

  const clusterOf = new Map<string, number>();
  for (const c of clusters) for (const id of c.memberIds) clusterOf.set(id, c.idx);

  db.$client.transaction(() => {
    db.delete(searchClusters).where(eq(searchClusters.searchId, ctx.searchId)).run();
    for (const c of clusters) {
      const m = matchRows.get(c.idx);
      db.insert(searchClusters)
        .values({
          searchId: ctx.searchId,
          idx: c.idx,
          label: c.label,
          keyTerms: c.keyTerms,
          centroid: toBuffer(c.centroid),
          size: c.size,
          yearMin: c.yearMin,
          yearMax: c.yearMax,
          baseClusterIdx: m?.baseClusterIdx ?? null,
          change: m?.change ?? null,
        })
        .run();
    }
    db.update(searchPapers).set({ clusterIdx: null }).where(eq(searchPapers.searchId, ctx.searchId)).run();
  })();

  await chunkedWrite(
    db,
    [...clusterOf],
    ([paperId, idx]) => {
      db.update(searchPapers)
        .set({ clusterIdx: idx })
        .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.paperId, paperId)))
        .run();
    },
    ctx,
  );

  ctx.updateCounters({ clusters: clusters.length });
  ctx.log(`cluster: k=${clusters.length} (silhouette ${res.silhouette.toFixed(3)}) over ${withEmb.length} papers`);
  ctx.setStageProgress(1);
}
