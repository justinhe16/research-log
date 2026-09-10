import { describe, expect, it } from "vitest";
import { cosine, fromBuffer, toBuffer } from "@/lib/embedding";

// Only the pure helpers are tested here: loading the real MiniLM model would
// pull ~90MB and make the suite network-dependent.

describe("toBuffer / fromBuffer", () => {
  it("round-trips values exactly", () => {
    const v = Float32Array.from([0, 1, -1, 0.5, -0.25, 3.4028234663852886e38, 1e-38]);
    const back = fromBuffer(toBuffer(v));
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it("round-trips a full-size vector", () => {
    const v = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i) as number);
    expect(Array.from(fromBuffer(toBuffer(v)))).toEqual(Array.from(v));
  });

  it("honours byteOffset on a subarray view", () => {
    const full = Float32Array.from([9, 9, 1, 2, 3]);
    const view = full.subarray(2); // non-zero byteOffset into a shared buffer
    expect(Array.from(fromBuffer(toBuffer(view)))).toEqual([1, 2, 3]);
  });

  it("does not alias the source vector", () => {
    const v = Float32Array.from([1, 2, 3]);
    const buf = toBuffer(v);
    v[0] = 99;
    expect(Array.from(fromBuffer(buf))).toEqual([1, 2, 3]);
  });

  it("rejects a blob that is not a whole number of float32s", () => {
    expect(() => fromBuffer(Buffer.alloc(5))).toThrow(/float32/);
  });
});

describe("cosine", () => {
  it("is ~1 for identical vectors", () => {
    const a = Float32Array.from([0.1, 0.9, -0.4, 0.2]);
    expect(cosine(a, Float32Array.from(a))).toBeCloseTo(1, 6);
  });

  it("is ~0 for orthogonal vectors", () => {
    expect(cosine(Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0]))).toBeCloseTo(0, 6);
  });

  it("is ~-1 for opposed vectors", () => {
    expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([-1, -2, -3]))).toBeCloseTo(-1, 6);
  });

  it("never exceeds 1 (float drift on self-comparison)", () => {
    const a = Float32Array.from({ length: 384 }, () => Math.random());
    expect(cosine(a, a)).toBeLessThanOrEqual(1);
  });

  it("returns 0 rather than throwing on length mismatch", () => {
    expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2]))).toBe(0);
  });

  it("returns 0 for empty or zero vectors", () => {
    expect(cosine(new Float32Array(0), new Float32Array(0))).toBe(0);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});
