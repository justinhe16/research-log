import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmCallRecord } from "@/lib/landscape/types";

const create = vi.fn();
vi.mock("@/lib/llm/client", () => ({ getClient: () => ({ messages: { create } }) }));

const { callTool, LlmOutputError, needsThinkingDisabled } = await import("@/lib/llm/call-tool");

const tool = { name: "record_x", description: "x", input_schema: { type: "object" as const, properties: {} } };
const schema = z.object({ label: z.string().min(1) });
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };

function response(input: unknown, stop_reason = "tool_use") {
  return { content: [{ type: "tool_use", name: "record_x", id: "t", input }], stop_reason, usage };
}

function recorder() {
  const calls: LlmCallRecord[] = [];
  return { calls, record: (c: LlmCallRecord) => void calls.push(c) };
}

const base = {
  purpose: "synth_clusters" as const,
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  tool,
  schema,
  maxTokens: 500,
};

beforeEach(() => create.mockReset());

describe("callTool", () => {
  it("forces the tool, disables thinking on Sonnet 5, and records cache usage", async () => {
    create.mockResolvedValue(response({ label: "ok" }));
    const rec = recorder();
    const res = await callTool({ ...base, model: "claude-sonnet-5", recorder: rec });

    expect(res.data).toEqual({ label: "ok" });
    const params = create.mock.calls[0][0];
    expect(params.tool_choice).toEqual({ type: "tool", name: "record_x" });
    expect(params.thinking).toEqual({ type: "disabled" });
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 0 });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ ok: true, purpose: "synth_clusters", model: "claude-sonnet-5" });
    expect(rec.calls[0].costUsd).toBeCloseTo((100 * 2 + 1000 * 0.2 + 20 * 10) / 1e6);
  });

  it("sends no thinking param to Haiku", async () => {
    create.mockResolvedValue(response({ label: "ok" }));
    await callTool({ ...base, model: "claude-haiku-4-5-20251001" });
    expect(create.mock.calls[0][0]).not.toHaveProperty("thinking");
  });

  it("throws a readable validation error and still records the billed call", async () => {
    create.mockResolvedValue(response({ label: "" }));
    const rec = recorder();
    const err = await callTool({ ...base, model: "claude-sonnet-5", recorder: rec }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect(err.message).toMatch(/label/);
    expect(rec.calls[0]).toMatchObject({ ok: false, inputTokens: 100 });
  });

  it("rejects truncated output", async () => {
    create.mockResolvedValue(response({ label: "partial" }, "max_tokens"));
    await expect(callTool({ ...base, model: "claude-sonnet-5" })).rejects.toThrow(/truncated/);
  });

  it("sends the full tools list while forcing the named tool", async () => {
    const other = { name: "record_y", description: "y", input_schema: { type: "object" as const, properties: {} } };
    create.mockResolvedValue(response({ label: "ok" }));
    await callTool({ ...base, model: "claude-sonnet-5", tools: [tool, other] });
    const params = create.mock.calls[0][0];
    expect(params.tools).toEqual([tool, other]);
    expect(params.tool_choice).toEqual({ type: "tool", name: "record_x" });
  });

  it("throws when the forced tool is not in tools", async () => {
    const other = { name: "record_y", description: "y", input_schema: { type: "object" as const, properties: {} } };
    await expect(callTool({ ...base, model: "claude-sonnet-5", tools: [other] })).rejects.toThrow(/record_x/);
    expect(create).not.toHaveBeenCalled();
  });

  it("detects models that need thinking disabled", () => {
    expect(needsThinkingDisabled("claude-sonnet-5")).toBe(true);
    expect(needsThinkingDisabled("claude-opus-5")).toBe(true);
    expect(needsThinkingDisabled("claude-sonnet-4-6")).toBe(false);
    expect(needsThinkingDisabled("claude-haiku-4-5")).toBe(false);
  });
});
