import { describe, expect, it } from "vitest";
import { DEPTH_PRESETS } from "@/lib/landscape/constants";
import { estimate } from "@/lib/landscape/estimate";
import { DEPTHS } from "@/lib/landscape/types";

describe("estimate", () => {
  const withKey = { hasS2Key: true };

  it("is monotonic in cost, time and calls across presets", () => {
    const [quick, standard, deep] = DEPTHS.map((d) => estimate(d, withKey));
    for (const key of ["expected", "low", "high"] as const) {
      expect(quick.costUsd[key]).toBeLessThan(standard.costUsd[key]);
      expect(standard.costUsd[key]).toBeLessThan(deep.costUsd[key]);
      expect(quick.minutes[key]).toBeLessThan(standard.minutes[key]);
      expect(standard.minutes[key]).toBeLessThan(deep.minutes[key]);
    }
    expect(quick.llmCalls.haiku).toBeLessThan(standard.llmCalls.haiku);
    expect(standard.llmCalls.haiku).toBeLessThan(deep.llmCalls.haiku);
  });

  it("lands near the plan's ballpark figures", () => {
    const [quick, standard, deep] = DEPTHS.map((d) => estimate(d, withKey));
    expect(quick.costUsd.expected).toBeGreaterThan(0.05);
    expect(quick.costUsd.expected).toBeLessThan(0.2);
    expect(standard.costUsd.expected).toBeGreaterThan(0.15);
    expect(standard.costUsd.expected).toBeLessThan(0.5);
    expect(deep.costUsd.expected).toBeGreaterThan(0.4);
    expect(deep.costUsd.expected).toBeLessThan(1.2);
    expect(quick.minutes.expected).toBeLessThan(4);
    expect(deep.minutes.expected).toBeLessThan(20);
    expect(quick.llmCalls.sonnet).toBe(3);
    expect(standard.llmCalls.sonnet).toBe(5);
  });

  it("orders low <= expected <= high", () => {
    const e = estimate("standard", withKey);
    expect(e.costUsd.low).toBeLessThanOrEqual(e.costUsd.expected);
    expect(e.costUsd.expected).toBeLessThanOrEqual(e.costUsd.high);
    expect(e.minutes.low).toBeLessThanOrEqual(e.minutes.expected);
    expect(e.minutes.expected).toBeLessThanOrEqual(e.minutes.high);
  });

  it("makes a refresh cheaper and faster than the initial run", () => {
    for (const depth of DEPTHS) {
      const initial = estimate(depth, withKey);
      const refresh = estimate(depth, { ...withKey, refresh: { daysSince: 14 } });
      expect(refresh.costUsd.expected).toBeLessThan(initial.costUsd.expected);
      expect(refresh.minutes.expected).toBeLessThan(initial.minutes.expected);
      expect(refresh.llmCalls.haiku).toBeLessThan(initial.llmCalls.haiku);
      // Synthesis always runs in full.
      expect(refresh.llmCalls.sonnet).toBe(initial.llmCalls.sonnet);
    }
  });

  it("makes an older refresh cost more than a recent one", () => {
    const recent = estimate("standard", { ...withKey, refresh: { daysSince: 7 } });
    const old = estimate("standard", { ...withKey, refresh: { daysSince: 900 } });
    expect(old.costUsd.expected).toBeGreaterThan(recent.costUsd.expected);
  });

  it("is slower without an S2 key and says so", () => {
    const keyed = estimate("standard", withKey);
    const keyless = estimate("standard", { hasS2Key: false });
    expect(keyless.minutes.expected).toBeGreaterThan(keyed.minutes.expected);
    expect(keyless.costUsd.expected).toBe(keyed.costUsd.expected);
    expect(keyless.notes.join(" ")).toMatch(/Semantic Scholar/);
  });

  it("accepts a DepthConfig directly", () => {
    expect(estimate(DEPTH_PRESETS.deep, withKey)).toEqual(estimate("deep", withKey));
  });
});
