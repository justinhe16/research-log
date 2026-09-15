import { describe, expect, it } from "vitest";
import { createRefResolver, InvalidRefsError, mapRefs } from "../refs";

const refMap = { P1: "a", P2: "b", P3: "c" };

describe("refs", () => {
  it("normalizes, dedupes and drops unknown refs", () => {
    const { paperIds, stats } = mapRefs(["p1", "[P2]", "P 1", "P9", "nonsense"], refMap);
    expect(paperIds).toEqual(["a", "b"]);
    expect(stats.total).toBe(5);
    expect(stats.invalid).toBe(2);
    expect(stats.invalidRefs).toEqual(["P9", "nonsense"]);
  });

  it("does not treat prototype keys as refs", () => {
    expect(mapRefs(["constructor", "toString"], refMap).paperIds).toEqual([]);
  });

  it("throws a retryable error only above 50% invalid", () => {
    const ok = createRefResolver(refMap);
    ok.many(["P1", "P9"]); // exactly 50%
    expect(() => ok.assertValid()).not.toThrow();

    const bad = createRefResolver(refMap);
    bad.many(["P1", "P8", "P9"]);
    let err: unknown;
    try {
      bad.assertValid("record_x");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidRefsError);
    expect((err as InvalidRefsError).retryable).toBe(true);
    expect((err as InvalidRefsError).stats.invalidRatio).toBeCloseTo(2 / 3);
  });

  it("no refs is not an error", () => {
    expect(() => createRefResolver(refMap).assertValid()).not.toThrow();
  });
});
