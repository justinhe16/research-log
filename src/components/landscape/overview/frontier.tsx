"use client";

import { CompassIcon, TelescopeIcon } from "lucide-react";

import type { NarrativeDocument } from "@/lib/landscape/llm/synthesize/schemas";
import { cn } from "@/lib/utils";
import { CARD_CLASS, PaperChips, type PaperLookup } from "./primitives";

/** Where the field is now (with the papers that define it) and where it is heading. */
export function FrontierOutlook({ narrative, lookup }: { narrative: NarrativeDocument; lookup: PaperLookup }) {
  const frontier = narrative.frontier.summary.trim();
  const outlook = narrative.outlook.trim();
  if (!frontier && !outlook) return null;

  return (
    <div className={cn(CARD_CLASS, "grid grid-cols-1 overflow-hidden md:grid-cols-[3fr_2fr]")}>
      {frontier ? (
        <div className="flex min-w-0 flex-col gap-2 px-4 py-4 sm:px-5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <TelescopeIcon className="text-muted-foreground size-3.5" aria-hidden />
            Current frontier
          </h3>
          <p className="text-foreground/85 max-w-[68ch] text-sm leading-6">{frontier}</p>
          <PaperChips ids={narrative.frontier.paperIds} lookup={lookup} limit={6} className="pt-1" />
        </div>
      ) : null}
      {outlook ? (
        <div
          className={cn(
            "bg-muted/35 dark:bg-muted/20 flex min-w-0 flex-col gap-2 px-4 py-4 sm:px-5",
            frontier && "border-border/60 border-t md:border-t-0 md:border-l",
          )}
        >
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <CompassIcon className="text-muted-foreground size-3.5" aria-hidden />
            Outlook
          </h3>
          <p className="text-foreground/80 text-sm leading-6">{outlook}</p>
        </div>
      ) : null}
    </div>
  );
}
