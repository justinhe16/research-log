import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { papers, searchPapers, searches, topics } from "@/lib/db/schema";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.$client.close();
});

function seedTopic(id = "t1") {
  db.insert(topics).values({ id, slug: id, name: `Topic ${id}` }).run();
}

function seedSearch(id: string, status: "queued" | "running" | "done", topicId = "t1") {
  db.insert(searches)
    .values({ id, topicId, depth: "quick", config: DEPTH_PRESETS.quick, status })
    .run();
}

describe("landscape migration", () => {
  it("allows only one active search per topic", () => {
    seedTopic();
    seedSearch("s1", "running");
    expect(() => seedSearch("s2", "queued")).toThrow(/UNIQUE/);

    // Finished searches don't hold the slot.
    seedSearch("s3", "done");
    seedSearch("s4", "done");

    // Once the active one finishes, a new one may start.
    db.update(searches).set({ status: "done" }).where(eq(searches.id, "s1")).run();
    seedSearch("s5", "queued");

    // Other topics are independent.
    seedTopic("t2");
    seedSearch("s6", "running", "t2");
  });

  it("dedupes papers on external ids but allows many NULLs", () => {
    db.insert(papers).values({ id: "p1", title: "A", normTitle: "a", arxivId: "2401.00001" }).run();
    db.insert(papers).values({ id: "p2", title: "B", normTitle: "b" }).run();
    db.insert(papers).values({ id: "p3", title: "C", normTitle: "c" }).run();
    expect(() =>
      db.insert(papers).values({ id: "p4", title: "D", normTitle: "d", arxivId: "2401.00001" }).run(),
    ).toThrow(/UNIQUE/);
  });

  it("cascades topic deletion through searches to search_papers, keeping global papers", () => {
    seedTopic();
    seedSearch("s1", "done");
    db.insert(papers).values({ id: "p1", title: "A", normTitle: "a" }).run();
    db.insert(searchPapers).values({ searchId: "s1", paperId: "p1", origin: "query" }).run();

    db.delete(topics).where(eq(topics.id, "t1")).run();

    expect(db.select().from(searches).all()).toHaveLength(0);
    expect(db.select().from(searchPapers).all()).toHaveLength(0);
    expect(db.select().from(papers).all()).toHaveLength(1);
  });

  it("round-trips JSON columns", () => {
    seedTopic();
    seedSearch("s1", "queued");
    const row = db.select().from(searches).where(eq(searches.id, "s1")).get();
    expect(row?.config).toEqual(DEPTH_PRESETS.quick);
    expect(row?.counters).toEqual({});
    expect(row?.queries).toEqual([]);
  });
});
