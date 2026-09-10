import { describe, expect, it } from "vitest";
import { toStringArray } from "@/lib/ingest/summarize";

// Regression: Haiku intermittently returns keyClaims/tags as a string rather
// than an array, which used to fail validation and kill the whole ingest.
describe("toStringArray", () => {
  it("passes arrays through untouched", () => {
    expect(toStringArray(["a", "b"], true)).toEqual(["a", "b"]);
  });

  it("parses a JSON-encoded array string", () => {
    expect(toStringArray('["rlhf","scaling-laws"]', true)).toEqual(["rlhf", "scaling-laws"]);
  });

  it("splits a comma-delimited keyword string", () => {
    expect(toStringArray("rlhf, scaling-laws; evals", true)).toEqual([
      "rlhf",
      "scaling-laws",
      "evals",
    ]);
  });

  it("does NOT comma-split prose, since claims contain commas", () => {
    const claim = "Batch size, not atomics, drives nondeterminism.";
    expect(toStringArray(claim, false)).toEqual([claim]);
  });

  it("splits prose on newlines and strips bullet and number markers", () => {
    const input = "- First claim, with a comma\n2. Second claim\n• Third claim";
    expect(toStringArray(input, false)).toEqual([
      "First claim, with a comma",
      "Second claim",
      "Third claim",
    ]);
  });

  it("prefers line boundaries over commas for multi-line keyword input", () => {
    expect(toStringArray("alpha, beta\ngamma", true)).toEqual(["alpha, beta", "gamma"]);
  });

  it("falls back to delimiter splitting when JSON is malformed", () => {
    expect(toStringArray('["broken", "json', true)).toEqual(['["broken"', '"json']);
  });

  it("returns an empty array for blank input and leaves non-strings alone", () => {
    expect(toStringArray("   ", true)).toEqual([]);
    expect(toStringArray(null, true)).toBeNull();
    expect(toStringArray(42, true)).toBe(42);
  });
});
