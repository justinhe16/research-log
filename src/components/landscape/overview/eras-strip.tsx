"use client";

import type { NarrativeDocument } from "@/lib/landscape/llm/synthesize/schemas";
import { cn } from "@/lib/utils";
import { PaperChips, type PaperLookup, yearRange } from "./primitives";

type Era = NarrativeDocument["eras"][number];

/**
 * The field's history as a horizontal band, oldest on the left. Each era sits on
 * a rail segment; the ongoing (last) era is drawn in the foreground color.
 * Stacks vertically with a left rail below `md`.
 */
export function ErasStrip({ eras, lookup }: { eras: Era[]; lookup: PaperLookup }) {
  const sorted = [...eras].sort((a, b) => a.startYear - b.startYear);
  const lastIdx = sorted.length - 1;

  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ol
        className="grid grid-cols-1 md:auto-cols-[minmax(13rem,1fr)] md:grid-flow-col md:grid-cols-none md:gap-x-1"
      >
        {sorted.map((era, i) => {
          const current = i === lastIdx;
          const ongoing = current && era.endYear === null;
          const opacity = sorted.length > 1 ? 0.25 + (0.45 * i) / Math.max(1, lastIdx) : 0.7;
          return (
            <li key={`${era.startYear}-${era.label}`} className="relative flex min-w-0 gap-3 md:flex-col md:gap-0">
              {/* rail: vertical on mobile, horizontal on desktop */}
              <div aria-hidden className="relative flex w-3 shrink-0 flex-col items-center md:h-3 md:w-full md:flex-row">
                <span
                  className={cn(
                    "absolute top-4 bottom-0 left-1/2 w-px -translate-x-1/2 md:top-1/2 md:right-0 md:bottom-auto md:left-3 md:h-0.5 md:w-auto md:translate-x-0 md:-translate-y-1/2 md:rounded-full",
                    i === lastIdx && "max-md:hidden",
                  )}
                  style={{ background: current ? "var(--foreground)" : `color-mix(in oklch, var(--foreground) ${Math.round(opacity * 100)}%, transparent)` }}
                />
                <span
                  className={cn(
                    "relative mt-1.5 size-2.5 shrink-0 rounded-full border-2 md:mt-0",
                    current ? "border-foreground bg-foreground" : "border-foreground/40 bg-background",
                  )}
                />
              </div>

              <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5 pb-6 md:pt-3 md:pr-4 md:pb-0", i === lastIdx && "pb-0")}>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-[11px] tracking-tight tabular-nums">
                    {yearRange(era.startYear, era.endYear, ongoing)}
                  </span>
                  {current && ongoing ? (
                    <span className="bg-foreground text-background inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium">Now</span>
                  ) : null}
                </div>
                <h3 className={cn("text-[14px] leading-5 font-semibold text-balance", !current && "text-foreground/85")}>{era.label}</h3>
                <p className="text-muted-foreground text-[13px] leading-5">{era.summary}</p>
                {era.keyPaperIds.length > 0 ? (
                  <div className="flex flex-col gap-1 pt-1">
                    <span className="text-muted-foreground/80 text-[11px]">{current ? "Defined by" : "Built on"}</span>
                    <PaperChips ids={era.keyPaperIds} lookup={lookup} limit={4} className="md:flex-col md:items-start" />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
