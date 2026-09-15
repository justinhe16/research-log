import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { topics } from "@/lib/db/schema";
import { exactNameMatches, normalizeTopicName, withLock } from "../lock";

describe("withLock", () => {
  it("runs same-key callbacks one at a time, in order", async () => {
    const events: string[] = [];
    const task = (name: string, ms: number) =>
      withLock("k", async () => {
        events.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([task("a", 20), task("b", 1), task("c", 1)]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("keeps going after a callback throws", async () => {
    const failed = withLock("k2", async () => {
      throw new Error("boom");
    });
    const next = withLock("k2", () => 42);
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe(42);
  });

  it("serializes a check-then-create so only one wins", async () => {
    const created: string[] = [];
    const attempt = () =>
      withLock("create", async () => {
        if (created.includes("x")) return false;
        await new Promise((r) => setTimeout(r, 5)); // e.g. an await between check and insert
        created.push("x");
        return true;
      });
    expect(await Promise.all([attempt(), attempt()])).toEqual([true, false]);
    expect(created).toEqual(["x"]);
  });
});

describe("exactNameMatches", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
  });
  afterEach(() => db.$client.close());

  it("normalizes case, whitespace and unicode", () => {
    expect(normalizeTopicName("  Sparse   AUTOencoders ")).toBe("sparse autoencoders");
    expect(normalizeTopicName("ＲＡＧ")).toBe("rag");
  });

  it("finds topics with the same normalized name", () => {
    db.insert(topics)
      .values([
        { id: "a", slug: "rag", name: "RAG" },
        { id: "b", slug: "rag-2", name: "Retrieval-augmented generation" },
      ])
      .run();
    expect(exactNameMatches(db, " rag ")).toEqual([
      { id: "a", slug: "rag", name: "RAG", description: "", lastSearchAt: null, paperCount: 0, similarity: 1 },
    ]);
    expect(exactNameMatches(db, "RAG systems")).toEqual([]);
  });
});
