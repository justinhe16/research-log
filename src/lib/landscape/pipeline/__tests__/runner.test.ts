import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { llmCalls, searchDocuments, searchStages, searches, topics } from "@/lib/db/schema";
import { buildStageContext, openSearchSession, SearchCancelledError } from "@/lib/landscape/pipeline/context";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { markStaleSearches } from "@/lib/landscape/pipeline/recovery";
import {
  cancelSearch,
  createSearch,
  isSearchRunning,
  resumeSearch,
  retryDocuments,
  resetJobsForTests,
  runSearch,
  startSearch,
  waitForSearch,
} from "@/lib/landscape/pipeline/runner";
import { clearStages, registerStages, type Stage, type StageMap } from "@/lib/landscape/pipeline/stage-registry";
import { STAGES, type StageName } from "@/lib/landscape/types";

vi.mock("@/lib/landscape/pipeline/stages", () => ({}));

let db: Db;
const quiet = { logger: () => {}, timers: false, hasS2Key: false };

function seedTopic(id = "t1") {
  const now = new Date().toISOString();
  db.insert(topics).values({ id, slug: id, name: `Topic ${id}`, createdAt: now, updatedAt: now }).run();
  return id;
}

function newSearch(topicId: string) {
  const r = createSearch(db, { topicId, kind: "initial", depth: "quick" });
  if (!r.ok) throw new Error(r.reason);
  return r.search.id;
}

function allStages(fn: (name: StageName) => Stage): StageMap {
  return Object.fromEntries(STAGES.map((s) => [s, fn(s)]));
}

function stageStatuses(searchId: string) {
  return Object.fromEntries(
    db
      .select()
      .from(searchStages)
      .where(eq(searchStages.searchId, searchId))
      .all()
      .map((r) => [r.stage, r.status]),
  );
}

function searchRow(id: string) {
  return db.select().from(searches).where(eq(searches.id, id)).get()!;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  db = createDb(":memory:");
  clearStages();
  resetJobsForTests();
});

afterEach(() => {
  db.$client.close();
});

describe("createSearch", () => {
  it("inserts a queued search with every stage pending", () => {
    const t = seedTopic();
    const r = createSearch(db, { topicId: t, kind: "initial", depth: "standard" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.search.status).toBe("queued");
    expect(r.search.config.depth).toBe("standard");
    expect(r.search.createdAt).toMatch(/T.*Z$/);
    expect(Object.values(stageStatuses(r.search.id))).toEqual(STAGES.map(() => "pending"));
  });

  it("returns a typed conflict for a second active search", () => {
    const t = seedTopic();
    const first = newSearch(t);
    const r = createSearch(db, { topicId: t, kind: "full", depth: "quick" });
    expect(r).toEqual({ ok: false, reason: "active_search", activeSearchId: first });
  });

  it("refresh derives since and queries from the base", () => {
    const t = seedTopic();
    const base = newSearch(t);
    db.update(searches)
      .set({
        status: "done",
        startedAt: "2026-03-20T10:00:00.000Z",
        finishedAt: "2026-03-20T11:00:00.000Z",
        queries: [{ text: "q", arxiv: "all:q", categories: [] }],
      })
      .where(eq(searches.id, base))
      .run();
    const r = createSearch(db, { topicId: t, kind: "refresh", depth: "quick" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.search.baseSearchId).toBe(base);
    expect(r.search.since).toBe("2026-03-06");
    expect(r.search.queries).toHaveLength(1);
  });

  it("refresh without a done base fails", () => {
    const t = seedTopic();
    expect(createSearch(db, { topicId: t, kind: "refresh", depth: "quick" })).toEqual({
      ok: false,
      reason: "base_not_found",
    });
  });
});

describe("runSearch", () => {
  it("runs stages in STAGES order and finishes done", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    const order: StageName[] = [];
    registerStages(
      allStages((name) => async (ctx) => {
        order.push(name);
        ctx.updateCounters({ queries: order.length });
        ctx.setStageProgress(0.5);
        return name === "diff" ? "skipped" : undefined;
      }),
    );
    expect(await runSearch(db, id, quiet)).toBe("done");
    expect(order).toEqual([...STAGES]);
    const s = searchRow(id);
    expect(s.status).toBe("done");
    expect(s.progress).toBe(1);
    expect(s.counters.queries).toBe(STAGES.length);
    expect(stageStatuses(id).diff).toBe("skipped");
    expect(stageStatuses(id).plan).toBe("done");

    const p = toSearchProgress(db, id)!;
    expect(p.stages.map((x) => x.stage)).toEqual([...STAGES]);
    expect(p.stages.every((x) => x.finishedAt)).toBe(true);
  });

  it("refreshes the topic card fields from the finished search", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    registerStages(allStages(() => async () => {}));
    await runSearch(db, id, quiet);
    const topic = db.select().from(topics).where(eq(topics.id, t)).get()!;
    expect(topic.lastSearchId).toBe(id);
    expect(topic.lastSearchAt).toBe(searchRow(id).finishedAt);
  });

  it("skips done stages on resume and passes checkpoints", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    db.update(searchStages).set({ status: "done" }).where(eq(searchStages.stage, "plan")).run();
    db.update(searchStages).set({ checkpoint: { batch: 3 } }).where(eq(searchStages.stage, "expand")).run();
    const order: StageName[] = [];
    let seen: unknown = null;
    registerStages(
      allStages((name) => async (ctx) => {
        order.push(name);
        if (name === "expand") {
          seen = ctx.checkpoint;
          ctx.saveCheckpoint({ more: true });
        }
      }),
    );
    await runSearch(db, id, quiet);
    expect(order[0]).toBe("expand");
    expect(order).not.toContain("plan");
    expect(seen).toEqual({ batch: 3 });
    const cp = db.select().from(searchStages).where(eq(searchStages.stage, "expand")).get()!.checkpoint;
    expect(cp).toEqual({ batch: 3, more: true });
  });

  it("marks the stage and search as error", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    const ran: StageName[] = [];
    registerStages(
      allStages((name) => async () => {
        ran.push(name);
        if (name === "embed") throw new Error("boom");
      }),
    );
    expect(await runSearch(db, id, quiet)).toBe("error");
    const s = searchRow(id);
    expect(s.status).toBe("error");
    expect(s.error).toContain("boom");
    const st = stageStatuses(id);
    expect(st.embed).toBe("error");
    expect(st.collect).toBe("done");
    expect(st.prerank).toBe("pending");
    expect(ran).not.toContain("prerank");
  });

  it("errors when a stage is not implemented", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    registerStages({ plan: async () => {} });
    expect(await runSearch(db, id, quiet)).toBe("error");
    expect(stageStatuses(id).expand).toBe("error");
  });

  it("cancels mid-stage and the stage returns to pending", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    let aborted = false;
    registerStages(
      allStages((name) => async (ctx) => {
        if (name !== "collect") return;
        ctx.signal.addEventListener("abort", () => (aborted = true));
        await cancelSearch(id, { db }); // not in the job registry -> cancelled immediately...
        // ...but the in-process run still observes the flag:
        ctx.throwIfCancelled();
      }),
    );
    expect(await runSearch(db, id, quiet)).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(searchRow(id).status).toBe("cancelled");
    expect(stageStatuses(id).collect).toBe("pending");
    expect(stageStatuses(id).embed).toBe("pending");
  });

  it("cancel of a registry-running search is picked up by the stage", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    const gate = deferred();
    registerStages(
      allStages((name) => async (ctx) => {
        if (name !== "collect") return;
        await gate.promise;
        ctx.throwIfCancelled();
        throw new Error("should have been cancelled");
      }),
    );
    await startSearch(id, { db, ...quiet });
    await vi.waitFor(() => expect(stageStatuses(id).collect).toBe("running"));
    const r = await cancelSearch(id, { db });
    expect(r).toEqual({ ok: true, status: "running" });
    expect(searchRow(id).cancelRequested).toBe(true);
    gate.resolve();
    await waitForSearch(id);
    expect(searchRow(id).status).toBe("cancelled");

    // Resume clears the flag and finishes.
    registerStages(allStages(() => async () => {}));
    const resumed = await resumeSearch(id, { db, ...quiet });
    expect(resumed).toEqual({ ok: true, status: "queued" });
    await waitForSearch(id);
    expect(searchRow(id).status).toBe("done");
    expect(searchRow(id).cancelRequested).toBe(false);
  });
});

describe("llm recorder", () => {
  it("rolls tokens and cost into the search equal to the llm_calls sum", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    const calls = [
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 50, costUsd: 0.01 },
      { inputTokens: 300, outputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.025 },
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.0005 },
    ];
    registerStages(
      allStages((name) => async (ctx) => {
        if (name !== "extract") return;
        await Promise.all(
          calls.map((c) =>
            ctx.recorder.record({ ...c, purpose: "extract_abstracts", model: "m", durationMs: 10, ok: true }),
          ),
        );
      }),
    );
    await runSearch(db, id, quiet);
    const rows = db.select().from(llmCalls).where(eq(llmCalls.searchId, id)).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.stage === "extract" && r.createdAt.includes("T"))).toBe(true);
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0);
    const s = searchRow(id);
    expect(s.inputTokens).toBe(sum("inputTokens"));
    expect(s.outputTokens).toBe(sum("outputTokens"));
    expect(s.cacheReadTokens).toBe(sum("cacheReadTokens"));
    expect(s.cacheWriteTokens).toBe(sum("cacheWriteTokens"));
    expect(s.costUsd).toBeCloseTo(sum("costUsd"), 10);
    expect(s.counters.llmCalls).toBe(3);
    expect(toSearchProgress(db, id)!.tokens.inputTokens).toBe(401);
  });

  it("buildStageContext exposes the StageContext contract", () => {
    const t = seedTopic();
    const id = newSearch(t);
    const session = openSearchSession(db, id, quiet)!;
    const ctx = buildStageContext(session, "plan");
    expect(ctx.searchId).toBe(id);
    expect(ctx.topicId).toBe(t);
    expect(ctx.kind).toBe("initial");
    expect(ctx.baseSearchId).toBeNull();
    expect(ctx.checkpoint).toBeNull();
    expect(() => ctx.throwIfCancelled()).not.toThrow();
    db.update(searches).set({ cancelRequested: true }).where(eq(searches.id, id)).run();
    expect(() => ctx.throwIfCancelled()).toThrow(SearchCancelledError);
    expect(ctx.signal.aborted).toBe(true);
    session.dispose();
  });
});

describe("concurrency", () => {
  it("runs at most 2 searches and starts queued ones when a slot frees", async () => {
    const ids = ["a", "b", "c"].map((t) => newSearch(seedTopic(t)));
    const gates = new Map(ids.map((id) => [id, deferred()]));
    let active = 0;
    let maxActive = 0;
    registerStages(
      allStages((name) => async (ctx) => {
        if (name !== "plan") return;
        active++;
        maxActive = Math.max(maxActive, active);
        await gates.get(ctx.searchId)!.promise;
        active--;
      }),
    );
    for (const id of ids) await startSearch(id, { db, ...quiet });
    await vi.waitFor(() => expect(active).toBe(2));
    expect(searchRow(ids[2]).status).toBe("queued");
    expect(isSearchRunning(ids[2])).toBe(true);

    gates.get(ids[0])!.resolve();
    await waitForSearch(ids[0]);
    await vi.waitFor(() => expect(searchRow(ids[2]).status).toBe("running"));
    gates.get(ids[1])!.resolve();
    gates.get(ids[2])!.resolve();
    await Promise.all(ids.map(waitForSearch));
    expect(maxActive).toBe(2);
    expect(ids.map((id) => searchRow(id).status)).toEqual(["done", "done", "done"]);
  });

  it("reserves the slot synchronously so concurrent starts run once", async () => {
    const id = newSearch(seedTopic());
    let runs = 0;
    registerStages(allStages((name) => async () => void (name === "plan" && runs++)));
    const a = startSearch(id, { db, ...quiet });
    expect(isSearchRunning(id)).toBe(true);
    const b = startSearch(id, { db, ...quiet });
    await Promise.all([a, b]);
    await waitForSearch(id);
    expect(runs).toBe(1);
    expect(searchRow(id).status).toBe("done");
  });

  it("cancelling a search waiting for a slot cancels it immediately", async () => {
    const ids = ["a", "b", "c"].map((t) => newSearch(seedTopic(t)));
    const gate = deferred();
    let ran = 0;
    registerStages(
      allStages((name) => async () => {
        if (name !== "plan") return;
        ran++;
        await gate.promise;
      }),
    );
    for (const id of ids) await startSearch(id, { db, ...quiet });
    await vi.waitFor(() => expect(ran).toBe(2));
    expect(await cancelSearch(ids[2], { db })).toEqual({ ok: true, status: "cancelled" });
    expect(isSearchRunning(ids[2])).toBe(false);
    gate.resolve();
    await Promise.all(ids.map(waitForSearch));
    expect(ran).toBe(2);
    expect(searchRow(ids[2]).status).toBe("cancelled");
  });
});

describe("retryDocuments", () => {
  it("resets only the tail stages and re-runs them", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    registerStages(allStages((name) => async () => (name === "diff" ? "skipped" : undefined)));
    await runSearch(db, id, quiet);
    db.update(searchStages).set({ checkpoint: { x: 1 } }).where(eq(searchStages.searchId, id)).run();
    db.insert(searchDocuments)
      .values({ searchId: id, kind: "gaps", status: "error", error: "bad", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })
      .run();
    expect(toSearchProgress(db, id)!.failedDocuments).toEqual(["gaps"]);

    const order: StageName[] = [];
    registerStages(allStages((name) => async () => void order.push(name)));
    const r = await retryDocuments(id, { db, ...quiet, kinds: ["gaps"] });
    expect(r).toEqual({ ok: true, status: "queued" });
    await waitForSearch(id);
    expect(order).toEqual(["diff", "synthesize", "finalize"]);
    expect(searchRow(id).status).toBe("done");
    const cps = Object.fromEntries(
      db.select().from(searchStages).where(eq(searchStages.searchId, id)).all().map((r) => [r.stage, r.checkpoint]),
    );
    expect(cps.extract).toEqual({ x: 1 });
    expect(cps.synthesize).toEqual({ retryKinds: ["gaps"] });
    expect(cps.finalize).toBeNull();
  });

  it("refuses while the search is active", async () => {
    const t = seedTopic();
    const id = newSearch(t);
    expect(await retryDocuments(id, { db })).toEqual({ ok: false, reason: "invalid_status", status: "queued" });
  });
});

describe("markStaleSearches", () => {
  it("interrupts orphaned and stale searches, resetting running stages", () => {
    const [orphan, stale, fresh, done] = ["a", "b", "c", "d"].map((t) => newSearch(seedTopic(t)));
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    db.update(searches).set({ status: "running", heartbeatAt: "2026-09-15T11:59:50.000Z" }).where(eq(searches.id, orphan)).run();
    db.update(searches).set({ status: "running", heartbeatAt: "2026-09-15T11:50:00.000Z" }).where(eq(searches.id, stale)).run();
    db.update(searches).set({ status: "running", heartbeatAt: "2026-09-15T11:59:50.000Z" }).where(eq(searches.id, fresh)).run();
    db.update(searches).set({ status: "done" }).where(eq(searches.id, done)).run();
    db.update(searchStages).set({ status: "running" }).where(eq(searchStages.stage, "collect")).run();
    db.update(searchStages).set({ status: "done" }).where(eq(searchStages.stage, "plan")).run();

    const swept = markStaleSearches(db, { isRunning: (id) => id !== orphan, now });
    expect(swept.sort()).toEqual([orphan, stale].sort());
    expect(searchRow(orphan).status).toBe("interrupted");
    expect(searchRow(stale).status).toBe("interrupted");
    expect(searchRow(fresh).status).toBe("running");
    expect(searchRow(done).status).toBe("done");
    expect(stageStatuses(orphan).collect).toBe("pending");
    expect(stageStatuses(orphan).plan).toBe("done");
    expect(stageStatuses(fresh).collect).toBe("running");
  });
});
