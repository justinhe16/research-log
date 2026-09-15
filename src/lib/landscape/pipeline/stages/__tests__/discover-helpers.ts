import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "@/lib/db/create";
import { papers, searchPapers, searchStages, searches, topics } from "@/lib/db/schema";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";
import type { S2Paper } from "@/lib/landscape/sources/semantic-scholar";
import type { ArxivPaper } from "@/lib/landscape/sources/arxiv";
import {
  STAGES,
  type Depth,
  type DepthConfig,
  type ExpandedQuery,
  type SearchCounters,
  type SearchKind,
  type StageContext,
  type StageName,
} from "@/lib/landscape/types";
import { createDiscoverStages, type DiscoverDeps } from "../discover";

export const NOW = new Date("2026-09-15T12:00:00.000Z");
export const TS = "2026-09-15T12:00:00.000Z";

export function freshDb(): Db {
  return createDb(":memory:");
}

export function seedTopic(db: Db, id = "t1", name = "sparse autoencoders", description = "interpretability of language models") {
  db.insert(topics).values({ id, slug: id, name, description, createdAt: TS, updatedAt: TS }).run();
  return id;
}

export function seedSearch(
  db: Db,
  opts: {
    id?: string;
    topicId?: string;
    depth?: Depth;
    config?: Partial<DepthConfig>;
    kind?: SearchKind;
    baseSearchId?: string | null;
    queries?: ExpandedQuery[];
    since?: string | null;
    status?: "queued" | "running" | "done";
  } = {},
) {
  const id = opts.id ?? "s1";
  const depth = opts.depth ?? "standard";
  db.insert(searches)
    .values({
      id,
      topicId: opts.topicId ?? "t1",
      kind: opts.kind ?? "initial",
      baseSearchId: opts.baseSearchId ?? null,
      depth,
      config: { ...DEPTH_PRESETS[depth], ...opts.config },
      queries: opts.queries ?? [],
      since: opts.since ?? null,
      status: opts.status ?? "running",
      createdAt: TS,
      startedAt: TS,
    })
    .run();
  for (const stage of STAGES) db.insert(searchStages).values({ searchId: id, stage }).run();
  return id;
}

export type FakeCtx = StageContext & {
  warnings: string[];
  logs: string[];
  counters: SearchCounters;
  progress: number[];
};

/** A StageContext backed by the search_stages row (so cross-stage checkpoint reads work). */
export function makeCtx(db: Db, searchId: string, stage: StageName, opts: { cancelAfter?: number } = {}): FakeCtx {
  const search = db.select().from(searches).where(eq(searches.id, searchId)).get()!;
  const row = db
    .select()
    .from(searchStages)
    .where(and(eq(searchStages.searchId, searchId), eq(searchStages.stage, stage)))
    .get();
  const controller = new AbortController();
  let calls = 0;
  const ctx: FakeCtx = {
    searchId,
    topicId: search.topicId,
    kind: search.kind,
    config: search.config,
    baseSearchId: search.baseSearchId,
    checkpoint: row?.checkpoint ?? null,
    saveCheckpoint(patch) {
      ctx.checkpoint = { ...(ctx.checkpoint ?? {}), ...patch };
      db.update(searchStages)
        .set({ checkpoint: ctx.checkpoint })
        .where(and(eq(searchStages.searchId, searchId), eq(searchStages.stage, stage)))
        .run();
    },
    updateCounters(patch) {
      Object.assign(ctx.counters, patch);
    },
    setStageProgress(f) {
      ctx.progress.push(f);
    },
    throwIfCancelled() {
      calls++;
      if (opts.cancelAfter !== undefined && calls > opts.cancelAfter) {
        const err = new Error("cancelled");
        err.name = "SearchCancelledError";
        throw err;
      }
    },
    signal: controller.signal,
    recorder: { record: () => {} },
    hasS2Key: true,
    log(m) {
      ctx.logs.push(m);
    },
    warnings: [],
    logs: [],
    counters: {},
    progress: [],
  };
  (ctx as unknown as { db: Db }).db = db;
  (ctx as unknown as { warn: (m: string) => void }).warn = (m) => ctx.warnings.push(m);
  return ctx;
}

/** Deterministic bag-of-words vector (16 dims, normalized). */
export function fakeVector(text: string): Float32Array {
  const v = new Float32Array(16);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 16] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function arxivPaper(id: string, title: string, rank: number, extra: Partial<ArxivPaper> = {}): ArxivPaper {
  return {
    title,
    arxivId: id,
    abstract: `${title} abstract`,
    authors: [{ name: "Ada Lovelace" }],
    year: 2025,
    publishedAt: "2025-01-01T00:00:00.000Z",
    source: "arxiv",
    rank,
    version: 1,
    updatedAt: null,
    primaryCategory: "cs.LG",
    categories: ["cs.LG"],
    journalRef: null,
    comment: null,
    ...extra,
  };
}

export function s2Paper(s2Id: string, title: string, extra: Partial<S2Paper> = {}): S2Paper {
  return {
    title,
    s2Id,
    abstract: `${title} abstract`,
    authors: [{ name: "Grace Hopper" }],
    year: 2024,
    source: "s2",
    referenceCount: null,
    citationCount: 10,
    influentialCitationCount: 1,
    ...extra,
  };
}

export function fakeDeps(db: Db, overrides: Partial<DiscoverDeps> = {}): DiscoverDeps {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    db,
    now: () => new Date(NOW.getTime()),
    expandQueries: unexpected("expandQueries"),
    searchArxiv: async () => [],
    searchS2: async () => [],
    s2References: async () => [],
    s2Citations: async () => [],
    s2BatchPapers: async (ids) => ids.map(() => null),
    openAlexWorksByDoi: async () => new Map(),
    embedMany: async (texts) => texts.map(fakeVector),
    scorePairs: async (_q, docs) => docs.map((d) => Math.min(1, d.length / 1000)),
    citationLinkLimit: 50,
    embedChunk: 8,
    rerankChunk: 4,
    ...overrides,
  } as DiscoverDeps;
}

export function stagesFor(db: Db, overrides: Partial<DiscoverDeps> = {}) {
  return createDiscoverStages(fakeDeps(db, overrides)) as Required<ReturnType<typeof createDiscoverStages>>;
}

export function pool(db: Db, searchId: string) {
  return db
    .select()
    .from(searchPapers)
    .innerJoin(papers, eq(papers.id, searchPapers.paperId))
    .where(eq(searchPapers.searchId, searchId))
    .all();
}

/** Insert a paper + pool row directly. */
export function seedPoolPaper(
  db: Db,
  searchId: string,
  p: { id: string; title: string; abstract?: string; s2Id?: string; arxivId?: string; doi?: string; citationCount?: number | null; year?: number },
  row: Partial<typeof searchPapers.$inferInsert> = {},
) {
  db.insert(papers)
    .values({
      id: p.id,
      title: p.title,
      normTitle: p.title.toLowerCase(),
      abstract: p.abstract ?? `${p.title} abstract`,
      s2Id: p.s2Id ?? null,
      arxivId: p.arxivId ?? null,
      doi: p.doi ?? null,
      citationCount: p.citationCount ?? null,
      year: p.year ?? 2024,
      createdAt: TS,
      updatedAt: TS,
    })
    .onConflictDoNothing()
    .run();
  db.insert(searchPapers).values({ searchId, paperId: p.id, origin: "query", ...row }).run();
}
