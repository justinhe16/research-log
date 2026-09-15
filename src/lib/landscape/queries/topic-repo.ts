import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { searchDocuments, searches, topics, type TopicRow } from "@/lib/db/schema";
import { toBuffer } from "@/lib/embedding";
import { uniqueSlug } from "../slug";
import { topicEmbeddingText, type EmbedFn } from "../topic-dedupe";
import { isoKey, summaryColumns, toDepth, toSearchSummary } from "./searches";
import {
  ACTIVE_SEARCH_STATUSES,
  type Depth,
  type SearchSummary,
  type TopicCard,
  type UpdateTopicInput,
} from "../types";

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toCard(t: TopicRow, lastSearch: SearchSummary | null, activeSearch: SearchSummary | null): TopicCard {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    defaultDepth: toDepth(t.defaultDepth),
    summary: t.summary,
    paperCount: t.paperCount,
    lastSearchAt: t.lastSearchAt,
    lastSearch,
    activeSearch,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Latest done search and the active (queued/running) search for each topic id. */
function loadSearchSummaries(db: Db, topicIds: string[]) {
  const last = new Map<string, SearchSummary>();
  const active = new Map<string, SearchSummary>();
  if (topicIds.length === 0) return { last, active };

  const rows = db
    .select(summaryColumns)
    .from(searches)
    .where(
      and(
        inArray(searches.topicId, topicIds),
        inArray(searches.status, ["done", ...ACTIVE_SEARCH_STATUSES]),
      ),
    )
    .orderBy(desc(isoKey(searches.finishedAt, searches.createdAt)), desc(isoKey(searches.createdAt)))
    .all();

  for (const r of rows) {
    const s = toSearchSummary(r);
    if (s.status === "done") {
      if (!last.has(s.topicId)) last.set(s.topicId, s);
    } else if (!active.has(s.topicId)) {
      // The partial unique index guarantees at most one.
      active.set(s.topicId, s);
    }
  }
  return { last, active };
}

function cardsFor(db: Db, rows: TopicRow[]): TopicCard[] {
  const { last, active } = loadSearchSummaries(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((t) => toCard(t, last.get(t.id) ?? null, active.get(t.id) ?? null));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type CreateTopicInput = {
  name: string;
  description?: string | null;
  depth: Depth;
  /** MiniLM vector of `topicEmbeddingText(name, description)`; null if embedding failed. */
  embedding: Float32Array | null;
};

export function createTopic(db: Db, input: CreateTopicInput): TopicCard {
  const id = crypto.randomUUID();
  const name = input.name.trim();
  const now = new Date().toISOString();
  const row = db.transaction((tx) => {
    const slug = uniqueSlug(tx, name);
    return tx
      .insert(topics)
      .values({
        id,
        slug,
        name,
        description: (input.description ?? "").trim(),
        defaultDepth: input.depth,
        embedding: input.embedding ? toBuffer(input.embedding) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
  return toCard(row, null, null);
}

export function getTopicRow(db: Db, idOrSlug: string): TopicRow | null {
  return (
    db
      .select()
      .from(topics)
      .where(or(eq(topics.id, idOrSlug), eq(topics.slug, idOrSlug)))
      // An id match wins over a (theoretical) slug that equals another topic's id.
      .orderBy(sql`case when ${topics.id} = ${idOrSlug} then 0 else 1 end`)
      .get() ?? null
  );
}

export function getTopicByIdOrSlug(db: Db, idOrSlug: string): TopicCard | null {
  const row = getTopicRow(db, idOrSlug);
  return row ? cardsFor(db, [row])[0] : null;
}

/** Cards for the grid, most recently active first (last search, else creation). */
export function listTopicCards(db: Db): TopicCard[] {
  const rows = db
    .select()
    .from(topics)
    .orderBy(desc(isoKey(topics.lastSearchAt, topics.createdAt)), desc(isoKey(topics.createdAt)))
    .all();
  return cardsFor(db, rows);
}

export type UpdateTopicOptions = {
  /** Called with the new embedding text when name or description change. If it
   *  throws, the old embedding is cleared (a stale vector would mis-dedupe). */
  reembed?: EmbedFn;
};

/**
 * Patch name / description / defaultDepth. The slug is stable: a rename never
 * changes it, so existing links keep working. Returns null if the topic is missing.
 */
export async function updateTopic(
  db: Db,
  idOrSlug: string,
  patch: UpdateTopicInput,
  { reembed }: UpdateTopicOptions = {},
): Promise<TopicCard | null> {
  const current = getTopicRow(db, idOrSlug);
  if (!current) return null;

  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  const description = patch.description !== undefined ? patch.description.trim() : current.description;
  const textChanged = name !== current.name || description !== current.description;

  let embedding: Buffer | null | undefined; // undefined = leave as-is
  if (textChanged && reembed) {
    try {
      embedding = toBuffer(await reembed(topicEmbeddingText(name, description)));
    } catch {
      embedding = null;
    }
  }

  db.transaction((tx) => {
    const set: Partial<typeof topics.$inferInsert> = {
      name,
      description,
      updatedAt: new Date().toISOString(),
    };
    if (patch.defaultDepth !== undefined) set.defaultDepth = patch.defaultDepth;
    if (embedding !== undefined) set.embedding = embedding;
    tx.update(topics).set(set).where(eq(topics.id, current.id)).run();
  });

  return getTopicByIdOrSlug(db, current.id);
}

export type DeleteTopicResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "active_search"; searchId: string };

/** Delete a topic (cascades to its searches). Refuses while a search is queued or running. */
export function deleteTopic(db: Db, idOrSlug: string): DeleteTopicResult {
  return db.transaction((tx): DeleteTopicResult => {
    const row = tx
      .select({ id: topics.id })
      .from(topics)
      .where(or(eq(topics.id, idOrSlug), eq(topics.slug, idOrSlug)))
      .orderBy(sql`case when ${topics.id} = ${idOrSlug} then 0 else 1 end`)
      .get();
    if (!row) return { ok: false, reason: "not_found" };

    const active = tx
      .select({ id: searches.id })
      .from(searches)
      .where(and(eq(searches.topicId, row.id), inArray(searches.status, [...ACTIVE_SEARCH_STATUSES])))
      .get();
    if (active) return { ok: false, reason: "active_search", searchId: active.id };

    tx.delete(topics).where(eq(topics.id, row.id)).run();
    return { ok: true, id: row.id };
  });
}

/**
 * Recompute the card fields from the latest done search: last_search_id,
 * last_search_at (its finishedAt, else createdAt), paper_count (selected papers)
 * and summary (the clusters document's topicSummary, kept if absent). With no
 * done search the fields reset. Called by finalize and after deleting a search.
 */
export function refreshTopicDenormalized(db: Db, topicId: string): void {
  db.transaction((tx) => {
    const latest = tx
      .select(summaryColumns)
      .from(searches)
      .where(and(eq(searches.topicId, topicId), eq(searches.status, "done")))
      .orderBy(desc(isoKey(searches.finishedAt, searches.createdAt)), desc(isoKey(searches.createdAt)))
      .get();

    const touched = new Date().toISOString();
    if (!latest) {
      tx.update(topics)
        .set({ lastSearchId: null, lastSearchAt: null, paperCount: 0, summary: null, updatedAt: touched })
        .where(eq(topics.id, topicId))
        .run();
      return;
    }

    const doc = tx
      .select({ data: searchDocuments.data })
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.searchId, latest.id),
          eq(searchDocuments.kind, "clusters"),
          eq(searchDocuments.status, "done"),
        ),
      )
      .get();
    const topicSummary = (doc?.data as { topicSummary?: unknown } | null | undefined)?.topicSummary;

    tx.update(topics)
      .set({
        lastSearchId: latest.id,
        // Normalize a SQLite-default "YYYY-MM-DD HH:MM:SS" so card ordering stays consistent.
        lastSearchAt: (latest.finishedAt ?? latest.createdAt).replace(" ", "T"),
        paperCount: latest.paperCount ?? 0,
        ...(typeof topicSummary === "string" && topicSummary.trim() ? { summary: topicSummary.trim() } : {}),
        updatedAt: touched,
      })
      .where(eq(topics.id, topicId))
      .run();
  });
}
