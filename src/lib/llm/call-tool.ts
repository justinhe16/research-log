import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { LlmPurpose, LlmRecorder, LlmUsage } from "@/lib/landscape/types";
import { getClient } from "./client";
import { costUsd } from "./pricing";

export type CallToolOptions<S extends z.ZodType> = {
  purpose: LlmPurpose;
  model: string;
  /** Plain string, or text blocks -- pass blocks to put `cache_control` on a stable prefix. */
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  /** The one tool the model is forced to call. */
  tool: Anthropic.Tool;
  /** Full tool list to send, in a fixed order; must include `tool`. Tool definitions
   *  are the start of the cache prefix, so calls meant to share a cached prompt must
   *  send identical lists. Defaults to `[tool]`. */
  tools?: Anthropic.Tool[];
  /** Validates (and coerces) `tool_use.input`. */
  schema: S;
  maxTokens: number;
  recorder?: LlmRecorder;
  signal?: AbortSignal;
};

export type CallToolResult<T> = {
  data: T;
  usage: LlmUsage;
  costUsd: number;
  durationMs: number;
  stopReason: string | null;
};

/** The model answered, but not in a shape we can use. Distinct from API/network
 *  errors so callers can decide to retry (e.g. per-paper after a failed batch). */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/** Forced `tool_choice` is incompatible with extended thinking. Sonnet 5 and Opus 5
 *  think adaptively when `thinking` is omitted, so they must opt out explicitly;
 *  Haiku 4.5 doesn't think unless asked, so it gets no parameter at all. */
export function needsThinkingDisabled(model: string): boolean {
  return /^claude-(sonnet|opus)-5(?:$|-)/.test(model);
}

export function usageOf(usage: Anthropic.Usage | undefined | null): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/** Human-readable zod issues, e.g. "tensions.0.refs: Too small". */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * One forced tool call: send, find the tool_use block, validate with zod, record
 * usage. Every attempt is recorded -- including failures, whose tokens were still
 * billed -- so `llm_calls` sums reconcile with the real bill.
 *
 * Throws LlmOutputError for unusable output, or the SDK's error for API failures.
 */
export async function callTool<S extends z.ZodType>(
  opts: CallToolOptions<S>,
): Promise<CallToolResult<z.output<S>>> {
  const started = Date.now();
  let usage = EMPTY_USAGE;

  const record = async (ok: boolean, error: string | null) => {
    if (!opts.recorder) return;
    try {
      await opts.recorder.record({
        purpose: opts.purpose,
        model: opts.model,
        ...usage,
        costUsd: costUsd(opts.model, usage),
        durationMs: Date.now() - started,
        ok,
        error,
      });
    } catch (err) {
      // Audit logging must never turn a good answer into a failure.
      console.error("[callTool] recorder failed", err);
    }
  };

  try {
    const tools = opts.tools ?? [opts.tool];
    if (!tools.some((t) => t.name === opts.tool.name)) {
      throw new Error(`callTool: tools must include ${opts.tool.name}.`);
    }
    const res = await getClient().messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: opts.messages,
        tools,
        tool_choice: { type: "tool", name: opts.tool.name },
        ...(needsThinkingDisabled(opts.model) ? { thinking: { type: "disabled" as const } } : {}),
      },
      { signal: opts.signal },
    );
    usage = usageOf(res.usage);

    const block = res.content.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
    if (!block || block.type !== "tool_use") {
      throw new LlmOutputError(
        `The model did not call ${opts.tool.name} (stop_reason: ${res.stop_reason}).`,
      );
    }
    if (res.stop_reason === "max_tokens") {
      // The input JSON was cut off mid-way; even if it happens to parse, it's partial.
      throw new LlmOutputError(
        `${opts.tool.name} output was truncated at max_tokens=${opts.maxTokens}.`,
      );
    }

    const parsed = opts.schema.safeParse(block.input);
    if (!parsed.success) {
      throw new LlmOutputError(
        `${opts.tool.name} returned input that failed validation -- ${formatIssues(parsed.error)}`,
      );
    }

    await record(true, null);
    return {
      data: parsed.data,
      usage,
      costUsd: costUsd(opts.model, usage),
      durationMs: Date.now() - started,
      stopReason: res.stop_reason,
    };
  } catch (err) {
    await record(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
