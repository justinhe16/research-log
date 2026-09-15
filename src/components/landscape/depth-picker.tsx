"use client";

import { useMemo } from "react";
import { InfoIcon } from "lucide-react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEPTH_LABELS, DEPTH_PRESETS } from "@/lib/landscape/constants";
import { estimate } from "@/lib/landscape/estimate";
import { DEPTHS, type Depth } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { formatMinutesRange, formatUsd, formatUsdRange } from "./format";

type DepthPickerProps = {
  value: Depth;
  onChange: (depth: Depth) => void;
  /** Whether the server has a Semantic Scholar key. `undefined` = unknown: no hint is shown. */
  hasS2Key?: boolean;
  /** Present for a refresh estimate. */
  refreshDaysSince?: number;
  disabled?: boolean;
  className?: string;
};

/** Quick / Standard / Deep, with a live paper, time and cost estimate for the selection. */
export function DepthPicker({ value, onChange, hasS2Key, refreshDaysSince, disabled, className }: DepthPickerProps) {
  const estimates = useMemo(() => {
    const opts = {
      hasS2Key: hasS2Key ?? true,
      refresh: refreshDaysSince !== undefined ? { daysSince: refreshDaysSince } : undefined,
    };
    return Object.fromEntries(DEPTHS.map((d) => [d, estimate(d, opts)])) as Record<Depth, ReturnType<typeof estimate>>;
  }, [hasS2Key, refreshDaysSince]);

  const current = estimates[value];
  const notes = hasS2Key === undefined ? current.notes.filter((n) => !n.startsWith("No Semantic Scholar")) : current.notes;

  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3", className)}>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => {
          if (v) onChange(v as Depth);
        }}
        variant="outline"
        size="sm"
        spacing={0}
        disabled={disabled}
        aria-label="Search depth"
        className="bg-background dark:bg-input/20 w-full sm:w-auto"
      >
        {DEPTHS.map((d) => (
          <ToggleGroupItem
            key={d}
            value={d}
            aria-label={`${DEPTH_LABELS[d]}, about ${formatUsd(estimates[d].costUsd.expected)}`}
            className="data-[state=on]:bg-muted data-[state=on]:text-foreground text-muted-foreground flex-1 gap-1.5 px-3 text-xs sm:flex-none"
          >
            {DEPTH_LABELS[d]}
            <span className="text-muted-foreground/80 font-mono text-[10px] tracking-tight tabular-nums">
              ~{formatUsd(estimates[d].costUsd.expected)}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4" aria-live="polite">
        <span className="text-foreground/80 tabular">{DEPTH_PRESETS[value].selectCount} papers</span>
        <Sep />
        <span className="tabular">{formatMinutesRange(current.minutes.low, current.minutes.high)}</span>
        <Sep />
        <span className="tabular">{formatUsdRange(current.costUsd.low, current.costUsd.high)}</span>
        {notes.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm transition-colors outline-none focus-visible:ring-2",
                  hasS2Key === false && "text-amber-700 dark:text-amber-400",
                )}
              >
                <InfoIcon className="size-3" aria-hidden />
                {hasS2Key === false ? "Slower without S2 key" : "Note"}
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </p>
    </div>
  );
}

function Sep() {
  return <span aria-hidden className="bg-border h-3 w-px" />;
}
