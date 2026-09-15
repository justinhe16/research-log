import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/create";
import { searchPapers, searches } from "@/lib/db/schema";
import type { ExpandedQuery } from "@/lib/landscape/types";
import {
  arxivPaper,
  freshDb,
  makeCtx,
  pool,
  s2Paper,
  seedPoolPaper,
  seedSearch,
  seedTopic,
  stagesFor,
} from "./discover-helpers";

let db: Db;
beforeEach(() => {
  db = freshDb();
  seedTopic(db);
});
afterEach(() => db.$client.close());

const q = (text: string, categories: string[] = []): ExpandedQuery => ({ text, arxiv: `all:"${text}"`, categories });

describe("plan", () => {
  it("resolves since from the publication window and validates config", async () => {
    const id = seedSearch(db, { depth: "standard" });
    await stagesFor(db).plan(makeCtx(db, id, "plan"));
    expect(db.select().from(searches).where(eq(searches.id, id)).get()!.since).toBe("2020-09-15");
  });

  it("fills since for a refresh from the base start when missing", async () => {
    seedSearch(db, { id: "base", status: "done" });
    db.update(searches).set({ startedAt: "2026-03-20T10:00:00.000Z" }).where(eq(searches.id, "base")).run();
    const id = seedSearch(db, { id: "s2", kind: "refresh", baseSearchId: "base", status: "running" });
    await stagesFor(db).plan(makeCtx(db, id, "plan"));
    expect(db.select().from(searches).where(eq(searches.id, id)).get()!.since).toBe("2026-03-20");
  });

  it("rejects an invalid config snapshot", async () => {
    const id = seedSearch(db, { config: { poolCap: 0 } });
    await expect(stagesFor(db).plan(makeCtx(db, id, "plan"))).rejects.toThrow(/config/);
  });
});

describe("expand", () => {
  it("stores the topic name as query 0 plus expanded queries and extras", async () => {
    const id = seedSearch(db);
    const expandQueries = vi.fn(async () => ({
      queries: [q("dictionary learning features", ["cs.LG"]), q("sparse autoencoders")],
      categories: ["cs.LG"],
      mustTerms: ["sparse"],
      excludeTerms: ["genomics"],
    }));
    const ctx = makeCtx(db, id, "expand");
    await stagesFor(db, { expandQueries }).expand(ctx);
    const row = db.select().from(searches).where(eq(searches.id, id)).get()!;
    expect(row.queries.map((x) => x.text)).toEqual(["sparse autoencoders", "dictionary learning features"]);
    expect(row.queries[0].categories).toEqual(["cs.LG"]);
    expect(ctx.checkpoint).toMatchObject({ done: true, extras: { excludeTerms: ["genomics"] } });
    expect(ctx.counters.queries).toBe(2);
  });

  it("falls back to the topic name with a warning", async () => {
    const id = seedSearch(db);
    const ctx = makeCtx(db, id, "expand");
    await stagesFor(db, { expandQueries: async () => Promise.reject(new Error("529 overloaded")) }).expand(ctx);
    expect(db.select().from(searches).where(eq(searches.id, id)).get()!.queries.map((x) => x.text)).toEqual([
      "sparse autoencoders",
    ]);
    expect(ctx.warnings[0]).toMatch(/expansion failed/);
  });

  it("is skipped on refresh", async () => {
    seedSearch(db, { id: "base", status: "done", queries: [q("a b c")] });
    const id = seedSearch(db, { id: "r", kind: "refresh", baseSearchId: "base" });
    const expandQueries = vi.fn();
    expect(await stagesFor(db, { expandQueries }).expand(makeCtx(db, id, "expand"))).toBe("skipped");
    expect(expandQueries).not.toHaveBeenCalled();
    expect(db.select().from(searches).where(eq(searches.id, id)).get()!.queries).toHaveLength(1);
  });
});

describe("collect", () => {
  it("pools and dedupes both sources with query hits and best source rank", async () => {
    const id = seedSearch(db, { queries: [q("sparse autoencoders"), q("dictionary learning")], since: "2020-09-15" });
    const searchArxiv = vi.fn(async (query: unknown, _opts?: unknown) => {
      const text = (query as ExpandedQuery).text;
      return text === "sparse autoencoders"
        ? [arxivPaper("2401.00001", "Towards Monosemanticity With Sparse Autoencoders", 1), arxivPaper("2401.00002", "Scaling Sparse Autoencoders To Big Models", 2)]
        : [arxivPaper("2401.00002", "Scaling Sparse Autoencoders To Big Models", 1)];
    });
    const searchS2 = vi.fn(async () => [s2Paper("S2A", "Scaling Sparse Autoencoders To Big Models", { arxivId: "2401.00002" }), s2Paper("S2B", "Another Unique Paper About Features")]);
    const ctx = makeCtx(db, id, "collect");
    await stagesFor(db, { searchArxiv, searchS2 }).collect(ctx);

    const rows = pool(db, id);
    expect(rows).toHaveLength(3);
    const scaling = rows.find((r) => r.papers.arxivId === "2401.00002")!;
    expect(scaling.papers.s2Id).toBe("S2A");
    expect(scaling.search_papers.queryHits).toEqual([0, 1]);
    expect(scaling.search_papers.sourceRank).toBe(0);
    expect(searchArxiv.mock.calls[0][1]).toMatchObject({ since: "2020-09-15", maxResults: 50 });
    expect(ctx.counters).toMatchObject({ candidates: 3, fetched: 7, queries: 2 });
    expect(ctx.checkpoint?.doneQueries).toEqual([0, 1]);
  });

  it("warns when one source fails for every query, errors when both do", async () => {
    const id = seedSearch(db, { queries: [q("sparse autoencoders")] });
    const ctx = makeCtx(db, id, "collect");
    await stagesFor(db, {
      searchArxiv: async () => Promise.reject(new Error("arXiv 503")),
      searchS2: async () => [s2Paper("S2B", "Another Unique Paper About Features")],
    }).collect(ctx);
    expect(pool(db, id)).toHaveLength(1);
    expect(ctx.warnings.some((w) => /arXiv failed for every query/.test(w))).toBe(true);

    const id2 = seedSearch(db, { id: "s-both", topicId: "t1", status: "done", queries: [q("x y z")] });
    const failing = stagesFor(db, {
      searchArxiv: async () => Promise.reject(new Error("down")),
      searchS2: async () => Promise.reject(new Error("down")),
    });
    await expect(failing.collect(makeCtx(db, id2, "collect"))).rejects.toThrow(/every source failed/);
  });

  it("caps the pool round-robin across queries", async () => {
    const id = seedSearch(db, { queries: [q("aa"), q("bb")], config: { poolCap: 3, s2PerQuery: 0 } });
    const searchArxiv = async (query: unknown) => {
      const t = (query as ExpandedQuery).text;
      return [1, 2, 3].map((i) => arxivPaper(`${t === "aa" ? "2401" : "2402"}.0000${i}`, `Paper ${t} number ${i} long title`, i));
    };
    await stagesFor(db, { searchArxiv }).collect(makeCtx(db, id, "collect"));
    const kept = pool(db, id).map((r) => r.papers.arxivId).sort();
    expect(kept).toEqual(["2401.00001", "2401.00002", "2402.00001"]);
  });

  it("resumes from the checkpoint without re-running done queries", async () => {
    const id = seedSearch(db, { queries: [q("aa"), q("bb")], config: { s2PerQuery: 0 } });
    const searchArxiv = vi.fn(async (query: unknown) => [arxivPaper(`2403.0000${(query as ExpandedQuery).text === "aa" ? 1 : 2}`, `Title for ${(query as ExpandedQuery).text} paper here`, 1)]);
    const first = makeCtx(db, id, "collect", { cancelAfter: 3 });
    await expect(stagesFor(db, { searchArxiv }).collect(first)).rejects.toThrow(/cancelled/);
    expect(first.checkpoint?.doneQueries).toEqual([0]);

    searchArxiv.mockClear();
    await stagesFor(db, { searchArxiv }).collect(makeCtx(db, id, "collect"));
    expect(searchArxiv).toHaveBeenCalledTimes(1);
    expect((searchArxiv.mock.calls[0][0] as ExpandedQuery).text).toBe("bb");
    expect(pool(db, id)).toHaveLength(2);
  });

  it("refresh carries over the base selection", async () => {
    seedSearch(db, { id: "base", status: "done" });
    seedPoolPaper(db, "base", { id: "old", title: "Old Selected Paper From Before" }, { selected: true, finalRank: 1 });
    seedPoolPaper(db, "base", { id: "old2", title: "Old Unselected Paper From Before" }, { selected: false });
    const id = seedSearch(db, { id: "r", kind: "refresh", baseSearchId: "base", queries: [q("aa")], since: "2026-03-06" });
    const searchS2 = vi.fn(async () => [s2Paper("S2N", "Brand New Paper About Features")]);
    await stagesFor(db, { searchS2 }).collect(makeCtx(db, id, "collect"));
    const rows = pool(db, id);
    expect(rows.map((r) => [r.papers.id === "old" ? "old" : r.papers.s2Id, r.search_papers.origin]).sort()).toEqual([
      ["S2N", "query"],
      ["old", "carryover"],
    ]);
    expect((searchS2.mock.calls[0] as unknown[])[1]).toMatchObject({ since: "2026-03-06" });
    expect(db.select().from(searchPapers).where(eq(searchPapers.paperId, "old2")).all()).toHaveLength(1);
  });
});
