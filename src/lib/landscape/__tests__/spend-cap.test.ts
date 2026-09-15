import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { searches, topics } from "@/lib/db/schema";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";
import {
  DEFAULT_MAX_SEARCHES_PER_HOUR,
  checkSearchSpendCap,
  countSearchesSince,
  maxSearchesPerHour,
} from "@/lib/landscape/spend-cap";

let db: Db;
const NOW = new Date("2026-09-15T12:00:00.000Z");

beforeEach(() => {
  db = createDb(":memory:");
  db.insert(topics)
    .values({ id: "t1", slug: "t", name: "T", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
    .run();
});

afterEach(() => {
  db.$client.close();
});

let n = 0;
function addSearch(createdAt: string) {
  db.insert(searches)
    .values({ id: `s${++n}`, topicId: "t1", depth: "quick", config: DEPTH_PRESETS.quick, status: "done", createdAt })
    .run();
}

describe("countSearchesSince", () => {
  it("counts only searches created within the window, in either timestamp format", () => {
    addSearch("2026-09-15T11:30:00.000Z"); // ISO, inside
    addSearch("2026-09-15 11:05:00"); // SQLite default format, inside
    addSearch("2026-09-15T11:00:00.000Z"); // exactly on the boundary: counts
    addSearch("2026-09-15T10:59:59.000Z"); // just outside
    addSearch("2026-09-14 11:30:00"); // yesterday
    expect(countSearchesSince(db, new Date("2026-09-15T11:00:00.000Z"))).toBe(3);
  });

  it("is zero for an empty table", () => {
    expect(countSearchesSince(db, NOW)).toBe(0);
  });
});

describe("checkSearchSpendCap", () => {
  it("allows until the hourly limit is reached, then refuses with a message", () => {
    addSearch("2026-09-15T11:10:00.000Z");
    expect(checkSearchSpendCap(db, { now: NOW, max: 2 }).ok).toBe(true);
    addSearch("2026-09-15T11:50:00.000Z");
    const result = checkSearchSpendCap(db, { now: NOW, max: 2 });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("2 searches in the last hour") });
  });

  it("ignores searches older than an hour", () => {
    addSearch("2026-09-15T10:00:00.000Z");
    addSearch("2026-09-15T10:30:00.000Z");
    expect(checkSearchSpendCap(db, { now: NOW, max: 2 }).ok).toBe(true);
  });

  it("a limit of 0 disables new searches", () => {
    expect(checkSearchSpendCap(db, { now: NOW, max: 0 }).ok).toBe(false);
  });
});

describe("maxSearchesPerHour", () => {
  it("reads the env var and falls back on missing or invalid values", () => {
    expect(maxSearchesPerHour({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_SEARCHES_PER_HOUR);
    expect(maxSearchesPerHour({ LANDSCAPE_MAX_SEARCHES_PER_HOUR: "5" } as unknown as NodeJS.ProcessEnv)).toBe(5);
    expect(maxSearchesPerHour({ LANDSCAPE_MAX_SEARCHES_PER_HOUR: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MAX_SEARCHES_PER_HOUR,
    );
    expect(maxSearchesPerHour({ LANDSCAPE_MAX_SEARCHES_PER_HOUR: "-1" } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MAX_SEARCHES_PER_HOUR,
    );
  });
});
