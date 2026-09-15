import { describe, expect, it } from "vitest";
import { costUsd, priceFor } from "@/lib/llm/pricing";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("costUsd", () => {
  it("prices Haiku 4.5 at $1/$5 per MTok, including dated snapshot ids", () => {
    expect(costUsd("claude-haiku-4-5-20251001", { ...zero, inputTokens: 1_000_000 })).toBeCloseTo(1);
    expect(costUsd("claude-haiku-4-5", { ...zero, outputTokens: 1_000_000 })).toBeCloseTo(5);
  });

  it("prices Sonnet 5 at $2/$10 with cache write x1.25 and read x0.1", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    expect(costUsd("claude-sonnet-5", usage)).toBeCloseTo(2 + 10 + 2.5 + 0.2);
  });

  it("refuses to guess an unknown model's price", () => {
    expect(() => priceFor("claude-unknown-9")).toThrow(/No price/);
  });
});
