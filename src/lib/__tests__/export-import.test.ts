import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_VERSION,
  decodeEntry,
  encodeEntry,
  parseExportFile,
} from "@/lib/backup-format";
import { exportBackupString, importBackup } from "@/lib/backup-io";
import { createDb, type Db } from "@/lib/db/create";
import * as S from "@/lib/db/schema";
import type { EntryRow } from "@/lib/db/schema";
import type { DepthConfig } from "@/lib/landscape/types";
import { fromBuffer, toBuffer } from "@/lib/embedding";

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: "e1",
    url: "https://example.com/paper",
    category: "Interpretability",
    notes: "notes worth not losing",
    whySaved: "follow-up",
    status: "read",
    rating: 5,
    title: "A Paper",
    summary: "Summary.",
    keyClaims: ["one", "two"],
    tags: ["sae"],
    authors: ["Ada", "Grace"],
    org: "Anthropic",
    venue: "arXiv",
    publishedAt: "2026-01-01",
    contentType: "paper",
    embedding: null,
    rawText: "full page text",
    ingestStatus: "done",
    ingestError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/** Encode -> JSON.stringify/parse -> validate -> decode, the way the two API
 *  routes actually do it. */
function roundTrip(r: EntryRow) {
  const file = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    count: 1,
    entries: [encodeEntry(r)],
  };
  const parsed = parseExportFile(JSON.parse(JSON.stringify(file)));
  return decodeEntry(parsed.entries[0]);
}

describe("embedding base64 round-trip", () => {
  it("preserves every float through JSON", () => {
    const vector = Float32Array.from({ length: 384 }, (_, i) => Math.cos(i) as number);
    const decoded = roundTrip(row({ embedding: toBuffer(vector) }));

    expect(decoded.embedding).toBeInstanceOf(Buffer);
    expect(Array.from(fromBuffer(decoded.embedding as Buffer))).toEqual(Array.from(vector));
  });

  it("keeps a missing embedding null instead of inventing one", () => {
    expect(roundTrip(row({ embedding: null })).embedding).toBeNull();
  });
});

describe("encodeEntry", () => {
  it("keeps notes and rawText -- this is a backup, not the wire shape", () => {
    const encoded = encodeEntry(row({ embedding: toBuffer(Float32Array.from([1, 2])) }));
    expect(encoded.notes).toBe("notes worth not losing");
    expect(encoded.rawText).toBe("full page text");
    expect(typeof encoded.embedding).toBe("string");
  });

  it("normalizes null JSON arrays", () => {
    const encoded = encodeEntry(row({ tags: null as unknown as string[] }));
    expect(encoded.tags).toEqual([]);
  });
});

describe("decodeEntry", () => {
  it("preserves all user fields verbatim", () => {
    const original = row();
    const decoded = roundTrip(original);
    expect(decoded).toMatchObject({
      id: original.id,
      url: original.url,
      notes: original.notes,
      rating: 5,
      keyClaims: ["one", "two"],
      authors: ["Ada", "Grace"],
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });
  });

  it("fills in timestamps when an older file omits them", () => {
    const parsed = parseExportFile({
      version: 1,
      entries: [{ id: "x", url: "https://example.com" }],
    });
    const decoded = decodeEntry(parsed.entries[0]);
    expect(decoded.createdAt).toBeTruthy();
    expect(decoded.category).toBe("Other");
    expect(decoded.tags).toEqual([]);
  });
});

describe("parseExportFile", () => {
  it("rejects a non-object", () => {
    expect(() => parseExportFile("nope")).toThrow(/Malformed backup file/);
  });

  it("rejects a file with no entries array", () => {
    expect(() => parseExportFile({ version: 1 })).toThrow(/entries/);
  });

  it("rejects an entry without an id", () => {
    expect(() => parseExportFile({ version: 1, entries: [{ url: "x" }] })).toThrow(
      /entries\.0\.id/,
    );
  });

  it("rejects a corrupted base64 embedding rather than decoding garbage", () => {
    expect(() =>
      parseExportFile({ version: 1, entries: [{ id: "a", embedding: "not base64!!" }] }),
    ).toThrow(/base64/);
  });

  it("rejects a file from a future version", () => {
    expect(() => parseExportFile({ version: 99, entries: [] })).toThrow(/newer than this app/);
  });
});

// ---------------------------------------------------------------------------
// Backup v2: Landscape tables through a real (in-memory) database
// ---------------------------------------------------------------------------

const T0 = "2026-03-01T10:00:00.000Z";
const T1 = "2026-03-01T11:00:00.000Z";
const T2 = "2026-03-01T12:00:00.000Z";

const vec = (seed: number) => toBuffer(Float32Array.from({ length: 8 }, (_, i) => Math.sin(seed + i)));

function paperRow(n: number, over: Partial<S.NewPaperRow> = {}): S.NewPaperRow {
  return {
    id: `p${n}`,
    arxivId: `2401.0000${n}`,
    doi: null,
    s2Id: `s2-${n}`,
    openalexId: null,
    normTitle: `a study of sparse autoencoder feature ${n}`,
    title: `A Study of Sparse Autoencoder Feature ${n}`,
    abstract: `Abstract ${n}`,
    authors: [{ name: `Author ${n}`, hIndex: n }],
    year: 2024,
    publishedAt: "2024-01-01",
    venue: "arXiv",
    arxivUrl: `https://arxiv.org/abs/2401.0000${n}`,
    pdfUrl: null,
    citationCount: 10 * n,
    influentialCitationCount: n,
    maxAuthorHIndex: n,
    metricsUpdatedAt: T0,
    embedding: vec(n),
    createdAt: T0,
    updatedAt: T1,
    ...over,
  };
}

function searchRow(over: Partial<S.NewSearchRow> = {}): S.NewSearchRow {
  return {
    id: "s1",
    topicId: "t1",
    kind: "initial",
    baseSearchId: null,
    depth: "quick",
    config: { depth: "quick", selectCount: 15 } as unknown as DepthConfig,
    queries: [{ text: "sae", arxiv: "all:sae", categories: ["cs.LG"] }],
    since: null,
    status: "done",
    stage: "finalize" as S.NewSearchRow["stage"],
    progress: 1,
    counters: { fetched: 40 },
    error: null,
    cancelRequested: false,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 5,
    cacheWriteTokens: 6,
    costUsd: 0.0123,
    createdAt: T0,
    startedAt: T0,
    finishedAt: T1,
    heartbeatAt: T1,
    ...over,
  };
}

function seedLandscape(db: Db) {
  db.insert(S.entries).values(decodeEntry(parseExportFile({ version: 1, entries: [encodeEntry(row())] }).entries[0])).run();
  db.insert(S.topics)
    .values({
      id: "t1",
      slug: "sparse-autoencoders",
      name: "Sparse autoencoders",
      description: "SAEs",
      embedding: vec(99),
      defaultDepth: "quick",
      summary: "A field.",
      lastSearchId: "s1",
      lastSearchAt: T1,
      paperCount: 3,
      createdAt: T0,
      updatedAt: T1,
    })
    .run();
  db.insert(S.papers).values([paperRow(1), paperRow(2), paperRow(3, { embedding: null })]).run();
  db.insert(S.paperFulltext)
    .values({ paperId: "p1", text: "full text", source: "arxiv", sourceUrl: "https://arxiv.org/pdf/1", hash: "h1", truncated: true, fetchedAt: T0 })
    .run();
  db.insert(S.paperCitations)
    .values([
      { citingId: "p2", citedId: "p1", isInfluential: true, intents: ["methodology"], createdAt: T0 },
      { citingId: "p3", citedId: "p1", isInfluential: false, intents: [], createdAt: T0 },
    ])
    .run();
  db.insert(S.paperExtractions)
    .values({
      id: "x1", paperId: "p1", version: 1, source: "abstract", sourceHash: "abc", model: "haiku",
      problem: "p", method: "m", results: "r", contribution: "c", limitations: null,
      datasets: ["d"], benchmarks: [], createdAt: T0,
    })
    .run();
  db.insert(S.searches).values(searchRow()).run();
  db.insert(S.searchStages)
    .values({ searchId: "s1", stage: "plan", status: "done", checkpoint: { batches: [1, 2] }, error: null, startedAt: T0, finishedAt: T1 })
    .run();
  db.insert(S.searchPapers)
    .values([1, 2, 3].map((n) => ({
      searchId: "s1", paperId: `p${n}`, origin: "query" as const, sourceRank: n, queryHits: [0, n],
      bm25: 1.5, cosine: 0.5, rrf: 0.1, rerank: 0.9, finalRank: n, selected: true, foundational: n === 3,
      citationCount: 10, influentialCitationCount: 1, velocity: 2.5, pagerank: 0.2, maxAuthorHIndex: 4,
      influence: 0.7, clusterIdx: 0, extractionId: n === 1 ? "x1" : null, gameChanger: n === 1,
    })))
    .run();
  db.insert(S.searchClusters)
    .values({ searchId: "s1", idx: 0, label: "Features", summary: "sum", keyTerms: ["a", "b"], centroid: vec(7), size: 3, yearMin: 2024, yearMax: 2024, baseClusterIdx: null, change: null })
    .run();
  db.insert(S.searchEdges)
    .values([
      { searchId: "s1", sourceId: "p2", targetId: "p1", kind: "cites", weight: 1 },
      { searchId: "s1", sourceId: "p3", targetId: "p2", kind: "similar", weight: 0.8 },
    ])
    .run();
  db.insert(S.searchDocuments)
    .values({ searchId: "s1", kind: "clusters", status: "done", data: { topicSummary: "A field.", clusters: [] }, error: null, model: "sonnet", createdAt: T1, updatedAt: T2 })
    .run();
  db.insert(S.llmCalls)
    .values({ id: "l1", searchId: "s1", stage: "expand", purpose: "expand", model: "haiku", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, durationMs: 1200, ok: true, error: null, createdAt: T0 })
    .run();
}

/** Every exported table, ordered deterministically, for deep comparison. */
function dumpLandscape(db: Db) {
  return {
    entries: db.select().from(S.entries).orderBy(asc(S.entries.id)).all(),
    topics: db.select().from(S.topics).orderBy(asc(S.topics.id)).all(),
    papers: db.select().from(S.papers).orderBy(asc(S.papers.id)).all(),
    paperFulltext: db.select().from(S.paperFulltext).orderBy(asc(S.paperFulltext.paperId)).all(),
    paperCitations: db.select().from(S.paperCitations).orderBy(asc(S.paperCitations.citingId), asc(S.paperCitations.citedId)).all(),
    paperExtractions: db.select().from(S.paperExtractions).orderBy(asc(S.paperExtractions.id)).all(),
    searches: db.select().from(S.searches).orderBy(asc(S.searches.id)).all(),
    searchStages: db.select().from(S.searchStages).orderBy(asc(S.searchStages.searchId), asc(S.searchStages.stage)).all(),
    searchPapers: db.select().from(S.searchPapers).orderBy(asc(S.searchPapers.searchId), asc(S.searchPapers.paperId)).all(),
    searchClusters: db.select().from(S.searchClusters).orderBy(asc(S.searchClusters.searchId), asc(S.searchClusters.idx)).all(),
    searchEdges: db.select().from(S.searchEdges).orderBy(asc(S.searchEdges.sourceId), asc(S.searchEdges.targetId)).all(),
    searchDocuments: db.select().from(S.searchDocuments).orderBy(asc(S.searchDocuments.kind)).all(),
    llmCalls: db.select().from(S.llmCalls).orderBy(asc(S.llmCalls.id)).all(),
  };
}

const exportParsed = (db: Db, opts?: { fulltext?: boolean }) =>
  parseExportFile(JSON.parse(exportBackupString(db, { exportedAt: T2, ...opts })));

describe("backup v2 (landscape)", () => {
  let source: Db;
  let target: Db;

  beforeEach(() => {
    source = createDb(":memory:");
    target = createDb(":memory:");
    seedLandscape(source);
  });

  it("exports version 2 with every landscape table and no api_cache", () => {
    source.insert(S.apiCache).values({ key: "k", host: "h", url: "u", status: 200, body: "{}", fetchedAt: T0, expiresAt: T1 }).run();
    const raw = JSON.parse(exportBackupString(source));
    expect(raw.version).toBe(2);
    expect(raw.count).toBe(1);
    expect(Object.keys(raw.landscape).sort()).toEqual(
      ["llmCalls", "paperCitations", "paperExtractions", "paperFulltext", "papers", "searchClusters",
        "searchDocuments", "searchEdges", "searchPapers", "searchStages", "searches", "topics"].sort(),
    );
    expect(raw.landscape.apiCache).toBeUndefined();
    expect(typeof raw.landscape.papers[0].embedding).toBe("string");
    expect(typeof raw.landscape.searchClusters[0].centroid).toBe("string");
    expect(raw.landscape.searchDocuments[0].data).toEqual({ topicSummary: "A field.", clusters: [] });
  });

  it("round-trips into an empty database unchanged", () => {
    const result = importBackup(target, exportParsed(source));
    expect(result.imported).toBe(1);
    expect(result.landscape).toMatchObject({
      topics: 1, papers: 3, papersMerged: 0, fulltext: 1, citations: 2, extractions: 1, searches: 1,
      searchStages: 1, searchPapers: 3, searchClusters: 1, searchEdges: 2, searchDocuments: 1, llmCalls: 1,
      skipped: { topics: 0, papers: 0, searches: 0, searchesMissingTopic: 0, rows: 0 },
    });
    expect(dumpLandscape(target)).toEqual(dumpLandscape(source));
  });

  it("is idempotent in merge mode", () => {
    const file = exportParsed(source);
    importBackup(target, file);
    const again = importBackup(target, file);
    expect(again.imported).toBe(0);
    expect(again.landscape).toMatchObject({ topics: 0, papers: 0, searches: 0, llmCalls: 0 });
    expect(dumpLandscape(target)).toEqual(dumpLandscape(source));
  });

  it("?fulltext=0 omits paper_fulltext and still imports", () => {
    const raw = JSON.parse(exportBackupString(source, { fulltext: false }));
    expect("paperFulltext" in raw.landscape).toBe(false);
    const result = importBackup(target, parseExportFile(raw));
    expect(result.landscape?.fulltext).toBe(0);
    expect(target.select().from(S.paperFulltext).all()).toEqual([]);
    expect(target.select().from(S.papers).all()).toHaveLength(3);
  });

  it("remaps children onto a pre-existing paper that shares an arXiv id", () => {
    target.insert(S.papers)
      .values(paperRow(1, { id: "local-1", s2Id: null, title: "Local copy", normTitle: "local copy", embedding: null }))
      .run();
    const result = importBackup(target, exportParsed(source));
    expect(result.landscape).toMatchObject({ papers: 2, papersMerged: 1 });

    expect(target.select({ id: S.papers.id }).from(S.papers).orderBy(asc(S.papers.id)).all().map((p) => p.id)).toEqual(
      ["local-1", "p2", "p3"],
    );
    const local = target.select().from(S.papers).where(eq(S.papers.id, "local-1")).get()!;
    expect(local.title).toBe("Local copy"); // existing row wins
    expect(local.s2Id).toBe("s2-1"); // ...but missing ids are filled in
    expect(local.embedding).toEqual(vec(1)); // ...and a missing vector

    expect(target.select().from(S.paperFulltext).all().map((f) => f.paperId)).toEqual(["local-1"]);
    expect(target.select().from(S.paperExtractions).all().map((x) => x.paperId)).toEqual(["local-1"]);
    expect(
      target.select().from(S.paperCitations).all().map((c) => `${c.citingId}->${c.citedId}`).sort(),
    ).toEqual(["p2->local-1", "p3->local-1"]);
    const sp = target.select().from(S.searchPapers).where(eq(S.searchPapers.paperId, "local-1")).get();
    expect(sp?.extractionId).toBe("x1");
    expect(target.select().from(S.searchPapers).where(eq(S.searchPapers.paperId, "p1")).all()).toEqual([]);
    expect(
      target.select().from(S.searchEdges).all().map((e) => `${e.sourceId}->${e.targetId}`).sort(),
    ).toEqual(["p2->local-1", "p3->p2"]);
  });

  it("remaps paper ids inside search documents and re-validates them", () => {
    source.insert(S.searchDocuments)
      .values({
        searchId: "s1",
        kind: "reading_path",
        status: "done",
        data: { steps: [
          { phase: "foundations", paperId: "p1", reason: "start" },
          { phase: "core", paperId: "p2", reason: "next" },
        ] },
        createdAt: T1,
        updatedAt: T2,
      })
      .run();
    target.insert(S.papers).values(paperRow(1, { id: "local-1", s2Id: null })).run();

    importBackup(target, exportParsed(source));
    const doc = target.select().from(S.searchDocuments).where(eq(S.searchDocuments.kind, "reading_path")).get()!;
    expect((doc.data as { steps: { paperId: string }[] }).steps.map((s) => s.paperId)).toEqual(["local-1", "p2"]);
  });

  it("rejects a search document that fails its schema after remapping", () => {
    const file = exportParsed(source);
    file.landscape!.searchDocuments[0].data = { clusters: "nope" };
    expect(() => importBackup(target, file)).toThrow(/search document s1\/clusters is malformed/);
    expect(target.select().from(S.topics).all()).toEqual([]);
  });

  it("stores imported queued/running searches as interrupted", () => {
    source.insert(S.topics).values({ id: "t2", slug: "rag", name: "RAG", createdAt: T0, updatedAt: T0 }).run();
    source.insert(S.searches).values(searchRow({ id: "s2", topicId: "t2", status: "running", finishedAt: null })).run();
    source.insert(S.searchStages)
      .values([
        { searchId: "s2", stage: "plan", status: "done", startedAt: T0, finishedAt: T0 },
        { searchId: "s2", stage: "expand", status: "running", startedAt: T1, finishedAt: null },
      ])
      .run();

    const result = importBackup(target, exportParsed(source));
    expect(result.landscape?.interrupted).toBe(1);
    const s2 = target.select().from(S.searches).where(eq(S.searches.id, "s2")).get()!;
    expect(s2.status).toBe("interrupted");
    expect(s2.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const stages = target.select().from(S.searchStages).where(eq(S.searchStages.searchId, "s2")).all();
    expect(stages.find((s) => s.stage === "expand")?.status).toBe("pending");
    expect(stages.find((s) => s.stage === "plan")?.status).toBe("done");
  });

  it("merge: skips searches whose topic is missing, uniquifies a clashing slug", () => {
    target.insert(S.topics).values({ id: "other", slug: "sparse-autoencoders", name: "Mine", createdAt: T0, updatedAt: T0 }).run();
    const file = exportParsed(source);
    file.landscape!.searches.push({ ...file.landscape!.searches[0], id: "orphan", topicId: "nope" });
    file.landscape!.searchPapers.push({ ...file.landscape!.searchPapers[0], searchId: "orphan" });

    const result = importBackup(target, file);
    expect(result.landscape).toMatchObject({ topics: 1, renamedSlugs: 1, searches: 1 });
    expect(result.landscape?.skipped.searchesMissingTopic).toBe(1);
    expect(result.landscape?.skipped.rows).toBe(1);
    expect(target.select().from(S.topics).where(eq(S.topics.id, "t1")).get()?.slug).toBe("sparse-autoencoders-2");
    expect(target.select().from(S.searches).where(eq(S.searches.id, "orphan")).get()).toBeUndefined();
  });

  it("recomputes a topic card whose last search was not imported", () => {
    const file = exportParsed(source);
    file.landscape!.topics[0].lastSearchId = "gone";
    file.landscape!.searches = [];
    const result = importBackup(target, file);
    expect(result.landscape?.searches).toBe(0);
    const t = target.select().from(S.topics).where(eq(S.topics.id, "t1")).get()!;
    expect(t.lastSearchId).toBeNull();
    expect(t.paperCount).toBe(0);
    // Orphaned llm_calls keep their history with the search link cleared.
    expect(target.select().from(S.llmCalls).get()?.searchId).toBeNull();
  });

  it("replace mode wipes landscape tables (keeping api_cache) before inserting", () => {
    target.insert(S.topics).values({ id: "old", slug: "old", name: "Old", createdAt: T0, updatedAt: T0 }).run();
    target.insert(S.papers).values(paperRow(9, { id: "old-paper" })).run();
    target.insert(S.entries).values(decodeEntry(parseExportFile({ version: 1, entries: [{ id: "old-entry", url: "x" }] }).entries[0])).run();
    target.insert(S.apiCache).values({ key: "k", host: "h", url: "u", status: 200, body: "{}", fetchedAt: T0, expiresAt: T1 }).run();

    const result = importBackup(target, exportParsed(source), { replace: true });
    expect(result.replaced).toBe(true);
    expect(dumpLandscape(target)).toEqual(dumpLandscape(source));
    expect(target.select().from(S.apiCache).all()).toHaveLength(1);
  });

  it("replace with a v1 file leaves landscape data alone", () => {
    importBackup(target, exportParsed(source));
    const result = importBackup(target, parseExportFile({ version: 1, entries: [{ id: "v1", url: "https://x" }] }), { replace: true });
    expect(result).toMatchObject({ imported: 1, replaced: true });
    expect(result.landscape).toBeUndefined();
    expect(target.select().from(S.entries).all().map((e) => e.id)).toEqual(["v1"]);
    expect(target.select().from(S.papers).all()).toHaveLength(3);
  });

  it("still imports a v1 file", () => {
    const parsed = parseExportFile({ version: 1, exportedAt: T0, count: 1, entries: [encodeEntry(row())] });
    const result = importBackup(target, parsed);
    expect(result).toEqual({ imported: 1, skipped: 0, replaced: false, missingEmbeddings: 1 });
    expect(target.select().from(S.entries).get()?.notes).toBe("notes worth not losing");
  });

  it("rolls back everything when a row fails mid-import", () => {
    const file = exportParsed(source);
    // A document for a search that is inserted, but with an invalid NOT NULL value.
    (file.landscape!.searchClusters[0] as { label: unknown }).label = null;
    expect(() => importBackup(target, file)).toThrow();
    expect(target.select().from(S.entries).all()).toEqual([]);
    expect(target.select().from(S.papers).all()).toEqual([]);
  });

  it("validates landscape rows: tolerates extra keys, rejects missing required ones", () => {
    const raw = JSON.parse(exportBackupString(source));
    raw.landscape.papers[0].futureColumn = "ignored";
    expect(() => parseExportFile(raw)).not.toThrow();
    delete raw.landscape.searches[0].topicId;
    expect(() => parseExportFile(raw)).toThrow(/landscape\.searches\.0\.topicId/);
  });

  it("rejects version 3", () => {
    expect(() => parseExportFile({ version: 3, entries: [] })).toThrow(/Backup version 3 is newer/);
  });
});
