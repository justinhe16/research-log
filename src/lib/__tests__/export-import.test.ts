import { describe, expect, it } from "vitest";
import {
  BACKUP_VERSION,
  decodeEntry,
  encodeEntry,
  parseExportFile,
} from "@/lib/backup-format";
import type { EntryRow } from "@/lib/db/schema";
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
