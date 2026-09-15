import { describe, expect, it } from "vitest";
import { sigmoid } from "@/lib/landscape/rank/cross-encoder";
import { cosineRelevance, logitRelevance } from "@/lib/landscape/rank/calibrate";

describe("relevance calibration", () => {
  it("spreads the on-topic logit band that a plain sigmoid saturates", () => {
    // Real ms-marco-MiniLM logits: niche on-topic 9.58, seminal paper 8.33, borderline 4, off-topic -5.
    const logits = [9.58, 8.33, 4, -5];
    const plain = logits.map(sigmoid);
    expect(plain[0] - plain[1]).toBeLessThan(0.0003);
    const cal = logits.map(logitRelevance);
    expect(cal[0] - cal[1]).toBeGreaterThan(0.05);
    expect(cal[0]).toBeLessThan(0.95);
    expect(cal[2]).toBeLessThan(0.45);
    expect(cal[3]).toBeLessThan(0.01);
    // Monotone.
    expect([...cal].sort((a, b) => b - a)).toEqual(cal);
  });

  it("maps cosine onto the same 0..1 scale and handles non-finite input", () => {
    expect(cosineRelevance(0.7)).toBeGreaterThan(0.9);
    expect(cosineRelevance(0.3)).toBeLessThan(0.15);
    expect(cosineRelevance(Number.NaN)).toBe(0);
    expect(logitRelevance(Number.POSITIVE_INFINITY)).toBe(1);
    expect(logitRelevance(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
