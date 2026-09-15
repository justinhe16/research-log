import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searchDocuments, searchStages, searches } from "@/lib/db/schema";
import { toSearchSummary, summaryColumns } from "../queries/searches";
import { STAGES, type DocumentKind, type SearchProgress, type StageState } from "../types";

/** `GET /searches/[id]` read model: the shared SearchSummary plus stages, counters and usage. */
export function toSearchProgress(db: Db, searchId: string): SearchProgress | null {
  const s = db
    .select({
      ...summaryColumns,
      error: searches.error,
      cancelRequested: searches.cancelRequested,
      counters: searches.counters,
      inputTokens: searches.inputTokens,
      outputTokens: searches.outputTokens,
      cacheReadTokens: searches.cacheReadTokens,
      cacheWriteTokens: searches.cacheWriteTokens,
      heartbeatAt: searches.heartbeatAt,
    })
    .from(searches)
    .where(eq(searches.id, searchId))
    .get();
  if (!s) return null;

  const stageRows = new Map(
    db
      .select()
      .from(searchStages)
      .where(eq(searchStages.searchId, searchId))
      .all()
      .map((r) => [r.stage, r]),
  );
  const stages: StageState[] = STAGES.map((stage) => {
    const r = stageRows.get(stage);
    return {
      stage,
      status: r?.status ?? "pending",
      startedAt: r?.startedAt ?? null,
      finishedAt: r?.finishedAt ?? null,
      error: r?.error ?? null,
    };
  });

  const failedDocuments = db
    .select({ kind: searchDocuments.kind })
    .from(searchDocuments)
    .where(and(eq(searchDocuments.searchId, searchId), eq(searchDocuments.status, "error")))
    .all()
    .map((r) => r.kind as DocumentKind);

  return {
    ...toSearchSummary(s),
    error: s.error,
    cancelRequested: s.cancelRequested,
    stages,
    counters: s.counters ?? {},
    tokens: {
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens,
    },
    failedDocuments,
    heartbeatAt: s.heartbeatAt,
  };
}
