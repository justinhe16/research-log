import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { entries } from "@/lib/db/schema";
import { loggedEntryIdFor, loggedIndex, normalizeUrlKey } from "@/lib/landscape/papers/logged";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.$client.close();
});

function log(id: string, url: string) {
  db.insert(entries).values({ id, url }).run();
}

describe("normalizeUrlKey", () => {
  it.each([
    ["https://www.Example.com/Path/?q=1#x", "example.com/Path"],
    ["http://example.com/", "example.com"],
    ["example.com/a//", "example.com/a"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeUrlKey(input)).toBe(expected);
  });
});

describe("loggedIndex", () => {
  it("matches arXiv abs and pdf URLs by id", () => {
    log("e1", "https://arxiv.org/abs/1706.03762v5");
    log("e2", "http://arxiv.org/pdf/2401.01234v2.pdf");
    const idx = loggedIndex(db);
    expect(loggedEntryIdFor(idx, { arxivId: "1706.03762" })).toBe("e1");
    expect(loggedEntryIdFor(idx, { arxivUrl: "https://arxiv.org/abs/2401.01234" })).toBe("e2");
    expect(loggedEntryIdFor(idx, { arxivId: "2401.99999" })).toBeNull();
  });

  it("matches doi.org URLs by DOI, case-insensitively", () => {
    log("e1", "https://doi.org/10.1145/3292500.3330701");
    log("e2", "https://doi.org/10.48550/arXiv.2305.00001");
    const idx = loggedIndex(db);
    expect(loggedEntryIdFor(idx, { doi: "10.1145/3292500.3330701".toUpperCase() })).toBe("e1");
    expect(loggedEntryIdFor(idx, { arxivId: "2305.00001" })).toBe("e2");
  });

  it("matches normalized URLs", () => {
    log("e1", "https://www.openreview.net/pdf/abc123/?download=1#top");
    const idx = loggedIndex(db);
    expect(loggedEntryIdFor(idx, { pdfUrl: "http://openreview.net/pdf/abc123" })).toBe("e1");
    expect(loggedEntryIdFor(idx, { pdfUrl: "http://openreview.net/pdf/zzz" })).toBeNull();
    expect(loggedEntryIdFor(idx, {})).toBeNull();
  });
});
