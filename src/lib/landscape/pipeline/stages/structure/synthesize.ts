/*
 * Stages 13-15 (diff, synthesize, finalize).
 */

import { and, asc, count, eq, sql, sum } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import {
  llmCalls,
  paperExtractions,
  searchClusters,
  searchDocuments,
  searchEdges,
  searchPapers,
  searches,
  topics,
} from "@/lib/db/schema";
import { SYNTHESIS_MODEL } from "@/lib/landscape/constants";
import { placeholderLabel } from "@/lib/landscape/cluster/terms";
import { buildDossier, type DossierPaper } from "@/lib/landscape/llm/dossier";
import type { ExtractionFields } from "@/lib/landscape/llm/extract";
import { SYNTHESIZED_KINDS, type SynthesizedKind } from "@/lib/landscape/llm/synthesize";
import { DOCUMENT_SCHEMAS, type DiffDocument } from "@/lib/landscape/llm/synthesize/schemas";
import { computeDiffWithMatch, type DiffSide } from "@/lib/landscape/pipeline/diff";
import type { DocumentKind, StageContext } from "@/lib/landscape/types";
import { refreshTopicDenormalized } from "@/lib/landscape/queries/topic-repo";
import { loadMatchableClusters } from "./cluster";
import { assignRefs, errorMessage, getSearchRow, loadPool, resolveDb, warn, type StructureDeps } from "./shared";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function upsertDocument(
  db: Db,
  searchId: string,
  kind: DocumentKind,
  value: { status: "done"; data: unknown; model: string | null } | { status: "error"; error: string; model: string | null },
  now: Date,
): void {
  const ts = now.toISOString();
  const row =
    value.status === "done"
      ? { status: "done" as const, data: DOCUMENT_SCHEMAS[kind].parse(value.data), error: null, model: value.model }
      : { status: "error" as const, data: null, error: value.error, model: value.model };
  db.insert(searchDocuments)
    .values({ searchId, kind, ...row, createdAt: ts, updatedAt: ts })
    .onConflictDoUpdate({
      target: [searchDocuments.searchId, searchDocuments.kind],
      set: { ...row, updatedAt: ts },
    })
    .run();
}

function documentStatuses(db: Db, searchId: string): Map<DocumentKind, { status: "done" | "error"; data: unknown }> {
  const rows = db
    .select({ kind: searchDocuments.kind, status: searchDocuments.status, data: searchDocuments.data })
    .from(searchDocuments)
    .where(eq(searchDocuments.searchId, searchId))
    .all();
  return new Map(rows.map((r) => [r.kind, { status: r.status, data: r.data }]));
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function diffSide(db: Db, searchId: string): DiffSide {
  const pool = loadPool(db, searchId, { selectedOnly: true });
  return {
    selectedIds: pool.map((p) => p.paperId),
    citationCounts: new Map(pool.map((p) => [p.paperId, p.spCitationCount ?? p.paper.citationCount])),
    publishedAt: new Map(pool.map((p) => [p.paperId, p.paper.publishedAt])),
    clusters: loadMatchableClusters(db, searchId),
  };
}

export async function diffStage(ctx: StageContext, deps: StructureDeps): Promise<void | "skipped"> {
  if (!ctx.baseSearchId) return "skipped";
  const db = await resolveDb(ctx, deps);
  const base = getSearchRow(db, ctx.baseSearchId);
  if (!base) {
    warn(ctx, `diff: base search ${ctx.baseSearchId} no longer exists`);
    return "skipped";
  }
  const current = getSearchRow(db, ctx.searchId);
  const since = current?.since ?? base.startedAt ?? base.createdAt;

  const { diff } = computeDiffWithMatch({
    baseSearchId: base.id,
    since,
    base: diffSide(db, base.id),
    current: diffSide(db, ctx.searchId),
  });
  upsertDocument(db, ctx.searchId, "diff", { status: "done", data: diff, model: null }, deps.now());
  ctx.updateCounters({ newPapers: diff.newPaperIds.length });
  ctx.setStageProgress(1);
}

// ---------------------------------------------------------------------------
// synthesize
// ---------------------------------------------------------------------------

export type SynthesizeOptions = {
  /** Restrict to these kinds (retry). Kinds already done are always skipped. */
  kinds?: readonly SynthesizedKind[];
};

export async function synthesizeStage(
  ctx: StageContext,
  deps: StructureDeps,
  opts: SynthesizeOptions = {},
): Promise<void | "skipped"> {
  const db = await resolveDb(ctx, deps);
  const existing = documentStatuses(db, ctx.searchId);
  // retryDocuments seeds the checkpoint with { retryKinds } to limit a retry.
  const retryKinds = retryKindsFrom(ctx.checkpoint);
  const wanted = opts.kinds ?? retryKinds ?? SYNTHESIZED_KINDS;
  let pending = wanted.filter((k) => existing.get(k)?.status !== "done");

  // Refresh that changed nothing: carry the base documents over instead of paying for synthesis.
  if (pending.length && !opts.kinds && !retryKinds && ctx.kind === "refresh" && ctx.baseSearchId) {
    const reused = reuseBaseDocuments(db, ctx, deps, existing, pending);
    if (reused > 0) {
      ctx.updateCounters({ synthesisReused: reused });
      ctx.log(`synthesize: nothing changed since the base search; reused ${reused} document(s) without LLM calls`);
      pending = pending.filter((k) => documentStatuses(db, ctx.searchId).get(k)?.status !== "done");
    }
  }

  if (pending.length) {
    const failures = await runPending(db, ctx, deps, pending, existing);
    if (failures.length) {
      warn(ctx, `synthesize: ${failures.length} document(s) failed: ${failures.join("; ")}`);
    }
  }

  // (Re)apply S1 names to clusters; cheap and covers resumes.
  const clustersDoc = documentStatuses(db, ctx.searchId).get("clusters");
  if (clustersDoc?.status === "done") {
    const parsed = DOCUMENT_SCHEMAS.clusters.safeParse(clustersDoc.data);
    if (parsed.success) {
      db.$client.transaction(() => {
        for (const c of parsed.data.clusters) {
          const name = c.name.trim();
          if (!name) continue;
          db.update(searchClusters)
            .set({ label: name, summary: c.summary.trim() || null })
            .where(and(eq(searchClusters.searchId, ctx.searchId), eq(searchClusters.idx, c.idx)))
            .run();
        }
      })();
    }
  }

  const final = documentStatuses(db, ctx.searchId);
  const synthesized = SYNTHESIZED_KINDS.map((k) => final.get(k)?.status);
  ctx.updateCounters({
    documentsDone: synthesized.filter((s) => s === "done").length,
    documentsFailed: synthesized.filter((s) => s === "error").length,
  });
  ctx.setStageProgress(1);
}

/** Base-search selection as paperId -> clusterIdx. */
function selectionClusters(db: Db, searchId: string): Map<string, number | null> {
  return new Map(
    db
      .select({ paperId: searchPapers.paperId, clusterIdx: searchPapers.clusterIdx })
      .from(searchPapers)
      .where(and(eq(searchPapers.searchId, searchId), eq(searchPapers.selected, true)))
      .all()
      .map((r) => [r.paperId, r.clusterIdx]),
  );
}

export const UNCHANGED_WHAT_CHANGED =
  "Nothing material changed since the previous search: no new or dropped papers and no cluster changes, so this landscape carries over unchanged.";

/**
 * Empty-diff refresh: when the diff has no new/dropped papers and every cluster is stable,
 * the selection and each paper's cluster idx are identical to the base search, and the base
 * has every pending kind done, copy those documents (narrative.whatChanged is set to a fixed
 * "nothing changed" note, mentioning rising papers when the diff has any). Returns the number
 * copied (0 = conditions not met; synthesis runs normally).
 */
export function reuseBaseDocuments(
  db: Db,
  ctx: Pick<StageContext, "searchId" | "baseSearchId">,
  deps: Pick<StructureDeps, "now">,
  existing: Map<DocumentKind, { status: "done" | "error"; data: unknown }>,
  pending: readonly SynthesizedKind[],
): number {
  if (!ctx.baseSearchId) return 0;
  const diffRow = existing.get("diff");
  const diff = diffRow?.status === "done" ? DOCUMENT_SCHEMAS.diff.safeParse(diffRow.data) : null;
  if (!diff?.success) return 0;
  const d = diff.data;
  if (d.baseSearchId !== ctx.baseSearchId || d.newPaperIds.length || d.droppedPaperIds.length) return 0;
  if (d.clusterChanges.some((c) => c.change !== "stable")) return 0;

  const base = selectionClusters(db, ctx.baseSearchId);
  const current = selectionClusters(db, ctx.searchId);
  if (base.size === 0 || base.size !== current.size) return 0;
  for (const [id, idx] of current) if (!base.has(id) || base.get(id) !== idx) return 0;

  const baseDocs = new Map(
    db
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.searchId, ctx.baseSearchId))
      .all()
      .map((r) => [r.kind, r]),
  );
  const copies: { kind: SynthesizedKind; data: unknown; model: string | null }[] = [];
  for (const kind of pending) {
    const row = baseDocs.get(kind);
    if (row?.status !== "done") return 0;
    const parsed = DOCUMENT_SCHEMAS[kind].safeParse(row.data);
    if (!parsed.success) return 0;
    let data: unknown = parsed.data;
    if (kind === "narrative") {
      const rising = d.rising.length ? ` ${d.rising.length} paper(s) gained notable citations.` : "";
      data = { ...(parsed.data as Record<string, unknown>), whatChanged: `${UNCHANGED_WHAT_CHANGED}${rising}` };
    }
    copies.push({ kind, data, model: row.model });
  }
  db.$client.transaction(() => {
    for (const c of copies) upsertDocument(db, ctx.searchId, c.kind, { status: "done", data: c.data, model: c.model }, deps.now());
  })();
  return copies.length;
}

function retryKindsFrom(checkpoint: Record<string, unknown> | null): SynthesizedKind[] | null {
  const raw = checkpoint?.retryKinds;
  if (!Array.isArray(raw)) return null;
  const kinds = SYNTHESIZED_KINDS.filter((k) => raw.includes(k));
  return kinds.length ? kinds : null;
}

async function runPending(
  db: Db,
  ctx: StageContext,
  deps: StructureDeps,
  pending: SynthesizedKind[],
  existing: Map<DocumentKind, { status: "done" | "error"; data: unknown }>,
): Promise<string[]> {
  const failures: string[] = [];
  const fail = (kind: SynthesizedKind, error: string) => {
    failures.push(`${kind}: ${error}`);
    upsertDocument(db, ctx.searchId, kind, { status: "error", error, model: SYNTHESIS_MODEL }, deps.now());
  };

  let dossier;
  try {
    dossier = buildSearchDossier(db, ctx);
  } catch (err) {
    for (const k of pending) fail(k, errorMessage(err));
    return failures;
  }
  ctx.throwIfCancelled();
  ctx.setStageProgress(0.05);

  const diffRow = existing.get("diff");
  const diffParsed = diffRow?.status === "done" ? DOCUMENT_SCHEMAS.diff.safeParse(diffRow.data) : null;
  const diff: DiffDocument | null = diffParsed?.success ? diffParsed.data : null;

  const result = await deps.runSynthesis({
    dossier,
    depthSynthCalls: ctx.config.synthesisCalls,
    diff,
    recorder: ctx.recorder,
    signal: ctx.signal,
    kinds: pending,
  });
  ctx.throwIfCancelled();

  for (const kind of pending) {
    const doc = result.documents[kind];
    if (doc) {
      try {
        upsertDocument(db, ctx.searchId, kind, { status: "done", data: doc, model: SYNTHESIS_MODEL }, deps.now());
        continue;
      } catch (err) {
        fail(kind, `invalid document: ${errorMessage(err)}`);
        continue;
      }
    }
    fail(kind, result.errors[kind] ?? "no document produced");
  }
  return failures;
}

/** The synthesis dossier for a search, with refs assigned by final rank. */
export function buildSearchDossier(db: Db, ctx: Pick<StageContext, "searchId" | "topicId">) {
  const search = getSearchRow(db, ctx.searchId);
  const topic = db.select().from(topics).where(eq(topics.id, ctx.topicId)).get();
  if (!search || !topic) throw new Error("search or topic not found");

  const selected = loadPool(db, ctx.searchId, { selectedOnly: true });
  if (selected.length === 0) throw new Error("no selected papers to synthesize");
  const refs = assignRefs(selected);

  const extractionRows = db
    .select({ paperId: searchPapers.paperId, x: paperExtractions })
    .from(searchPapers)
    .innerJoin(paperExtractions, eq(paperExtractions.id, searchPapers.extractionId))
    .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.selected, true)))
    .all();
  const extractions = new Map<string, ExtractionFields>(
    extractionRows.map(({ paperId, x }) => [
      paperId,
      {
        problem: x.problem,
        method: x.method,
        results: x.results,
        contribution: x.contribution,
        limitations: x.limitations,
        datasets: x.datasets,
        benchmarks: x.benchmarks,
      },
    ]),
  );
  const spRows = new Map(
    db
      .select()
      .from(searchPapers)
      .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.selected, true)))
      .all()
      .map((r) => [r.paperId, r]),
  );

  const dossierPapers: DossierPaper[] = selected.map((p) => {
    const sp = spRows.get(p.paperId)!;
    return {
      paperId: p.paperId,
      ref: refs.get(p.paperId)!,
      title: p.paper.title,
      year: p.paper.year,
      publishedAt: p.paper.publishedAt,
      venue: p.paper.venue,
      clusterIdx: p.clusterIdx,
      foundational: p.foundational,
      metrics: {
        citationCount: sp.citationCount ?? p.paper.citationCount,
        influentialCitationCount: sp.influentialCitationCount ?? p.paper.influentialCitationCount,
        velocity: sp.velocity,
        pagerank: sp.pagerank,
        influence: sp.influence,
        maxAuthorHIndex: sp.maxAuthorHIndex ?? p.paper.maxAuthorHIndex,
      },
      extraction: extractions.get(p.paperId) ?? null,
      abstract: p.paper.abstract,
    };
  });

  const clusters = db
    .select()
    .from(searchClusters)
    .where(eq(searchClusters.searchId, ctx.searchId))
    .orderBy(asc(searchClusters.idx))
    .all()
    // The heuristic label, not the stored one (S1 overwrites it), so the dossier stays byte-identical across retries.
    .map((c) => ({ idx: c.idx, label: placeholderLabel(c.keyTerms), keyTerms: c.keyTerms, size: c.size, yearMin: c.yearMin, yearMax: c.yearMax }));
  const edges = db
    .select({ source: searchEdges.sourceId, target: searchEdges.targetId, kind: searchEdges.kind, weight: searchEdges.weight })
    .from(searchEdges)
    .where(eq(searchEdges.searchId, ctx.searchId))
    .all();

  const d = buildDossier({
    topic: { name: topic.name, description: topic.description },
    papers: dossierPapers,
    clusters,
    edges,
    gameChangerCandidates: selected.filter((p) => spRows.get(p.paperId)?.gameChanger).map((p) => p.paperId),
    // The search's own timestamp, so the dossier is byte-identical across retries (prompt cache).
    generatedAt: (search.startedAt ?? search.createdAt).replace(" ", "T"),
  });
  return { text: d.text, refMap: d.refMap, clusterIdxs: d.clusterIdxs };
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

export async function finalizeStage(ctx: StageContext, deps: StructureDeps): Promise<void | "skipped"> {
  const db = await resolveDb(ctx, deps);
  const now = deps.now().toISOString();

  const selectedCount =
    db
      .select({ n: count() })
      .from(searchPapers)
      .where(and(eq(searchPapers.searchId, ctx.searchId), eq(searchPapers.selected, true)))
      .get()?.n ?? 0;
  const extracted =
    db
      .select({ n: count() })
      .from(searchPapers)
      .where(
        and(
          eq(searchPapers.searchId, ctx.searchId),
          eq(searchPapers.selected, true),
          sql`${searchPapers.extractionId} is not null`,
        ),
      )
      .get()?.n ?? 0;
  const clusterCount =
    db.select({ n: count() }).from(searchClusters).where(eq(searchClusters.searchId, ctx.searchId)).get()?.n ?? 0;
  const docs = documentStatuses(db, ctx.searchId);
  const synthesized = SYNTHESIZED_KINDS.map((k) => docs.get(k)?.status);

  // Roll up cost from the llm_calls audit, when the recorder wrote one.
  const usage = db
    .select({
      n: count(),
      input: sum(llmCalls.inputTokens),
      output: sum(llmCalls.outputTokens),
      cacheRead: sum(llmCalls.cacheReadTokens),
      cacheWrite: sum(llmCalls.cacheWriteTokens),
      cost: sum(llmCalls.costUsd),
    })
    .from(llmCalls)
    .where(eq(llmCalls.searchId, ctx.searchId))
    .get();
  const llmCallCount = usage?.n ?? 0;
  if (llmCallCount > 0) {
    db.update(searches)
      .set({
        inputTokens: Number(usage?.input ?? 0),
        outputTokens: Number(usage?.output ?? 0),
        cacheReadTokens: Number(usage?.cacheRead ?? 0),
        cacheWriteTokens: Number(usage?.cacheWrite ?? 0),
        costUsd: Number(usage?.cost ?? 0),
      })
      .where(eq(searches.id, ctx.searchId))
      .run();
  }

  ctx.updateCounters({
    selected: selectedCount,
    clusters: clusterCount,
    extracted,
    documentsDone: synthesized.filter((s) => s === "done").length,
    documentsFailed: synthesized.filter((s) => s === "error").length,
    ...(llmCallCount > 0 ? { llmCalls: llmCallCount } : {}),
  });

  // The runner marks the search done only after this stage, so the latest-done
  // lookup in refreshTopicDenormalized can't see it yet. Write this search's card
  // fields directly; the runner should call refreshTopicDenormalized again once
  // the status is `done` (it is idempotent and reconciles last_search_at).
  // A document retry on an older search must not steal the card from a newer done search.
  const self = getSearchRow(db, ctx.searchId);
  const newerDone = self
    ? db
        .select({ id: searches.id })
        .from(searches)
        .where(
          and(
            eq(searches.topicId, ctx.topicId),
            eq(searches.status, "done"),
            sql`${searches.id} != ${ctx.searchId}`,
            sql`replace(${searches.createdAt}, ' ', 'T') > ${self.createdAt.replace(" ", "T")}`,
          ),
        )
        .get()
    : null;
  if (self?.status === "done" || newerDone) {
    refreshTopicDenormalized(db, ctx.topicId);
    ctx.setStageProgress(1);
    return;
  }
  const clustersDoc = docs.get("clusters");
  const parsed = clustersDoc?.status === "done" ? DOCUMENT_SCHEMAS.clusters.safeParse(clustersDoc.data) : null;
  const summary = parsed?.success ? parsed.data.topicSummary.trim() : "";
  db.update(topics)
    .set({
      lastSearchId: ctx.searchId,
      lastSearchAt: now,
      paperCount: selectedCount,
      ...(summary ? { summary } : {}),
      updatedAt: now,
    })
    .where(eq(topics.id, ctx.topicId))
    .run();
  ctx.setStageProgress(1);
}
