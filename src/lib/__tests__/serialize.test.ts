import { describe, expect, it } from "vitest";
import type { EntryRow } from "@/lib/db/schema";
import { toEntry } from "@/lib/serialize";
import { cleanMetaValue } from "@/components/entries/entry-utils";

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: "e1",
    url: "https://example.com/paper",
    category: "Alignment",
    notes: "private notes",
    whySaved: "cited by X",
    status: "to-read",
    rating: null,
    title: "A Paper",
    summary: "It is about things.",
    keyClaims: ["claim"],
    tags: ["tag"],
    authors: ["Ada"],
    org: null,
    venue: null,
    publishedAt: null,
    contentType: "paper",
    embedding: null,
    rawText: null,
    ingestStatus: "done",
    ingestError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("toEntry", () => {
  it("drops embedding and rawText from the wire shape", () => {
    const entry = toEntry(row({ embedding: Buffer.alloc(8), rawText: "a wall of text" }));
    expect(entry).not.toHaveProperty("embedding");
    expect(entry).not.toHaveProperty("rawText");
  });

  it("sets hasEmbedding from the blob's presence", () => {
    expect(toEntry(row({ embedding: null })).hasEmbedding).toBe(false);
    expect(toEntry(row({ embedding: Buffer.alloc(4) })).hasEmbedding).toBe(true);
    // A zero-length blob is still an embedding attempt, not "missing".
    expect(toEntry(row({ embedding: Buffer.alloc(0) })).hasEmbedding).toBe(true);
  });

  it("defaults null JSON arrays to []", () => {
    const entry = toEntry(
      row({
        keyClaims: null as unknown as string[],
        tags: null as unknown as string[],
        authors: null as unknown as string[],
      }),
    );
    expect(entry.keyClaims).toEqual([]);
    expect(entry.tags).toEqual([]);
    expect(entry.authors).toEqual([]);
  });

  it("passes user-owned fields through untouched", () => {
    const entry = toEntry(row({ notes: "keep me", rating: 4 }));
    expect(entry.notes).toBe("keep me");
    expect(entry.rating).toBe(4);
    expect(entry.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// Regression: model-emitted "null"/"n/a" strings passed truthy checks and
// rendered as literal junk in the dialog's provenance line.
describe("cleanMetaValue", () => {
  it("strips model placeholder strings", () => {
    for (const junk of ["null", "None", "N/A", "  unknown ", "-", ""]) {
      expect(cleanMetaValue(junk)).toBeNull();
    }
  });

  it("keeps and trims real values", () => {
    expect(cleanMetaValue("  Thinking Machines Lab ")).toBe("Thinking Machines Lab");
  });

  it("handles null and undefined", () => {
    expect(cleanMetaValue(null)).toBeNull();
    expect(cleanMetaValue(undefined)).toBeNull();
  });
});
