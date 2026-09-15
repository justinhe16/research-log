"use client";

import { Fragment } from "react";
import { CornerDownRightIcon } from "lucide-react";

import type { Gap, Tension } from "@/lib/landscape/llm/synthesize/schemas";
import { cn } from "@/lib/utils";
import { clusterColor } from "../cluster-colors";
import { ClusterChip } from "../metric";
import { CARD_CLASS, PaperChips, type PaperLookup } from "./primitives";

/** Disagreements: the opposing positions sit side by side, each with its papers. */
export function Tensions({ tensions, lookup }: { tensions: Tension[]; lookup: PaperLookup }) {
  return (
    <ul className="flex flex-col gap-3">
      {tensions.map((t, ti) => {
        const positions = t.positions.filter((p) => p.stance.trim());
        const clusterIdxs = [...new Set(t.clusterIdxs)].filter((idx) => lookup.clusters.some((c) => c.idx === idx));
        return (
          <li key={`${ti}-${t.title}`} className={cn(CARD_CLASS, "flex min-w-0 flex-col")}>
            <div className="flex flex-col gap-1.5 px-4 pt-3.5 pb-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="text-[14px] leading-5 font-semibold text-balance">{t.title}</h3>
                {clusterIdxs.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {clusterIdxs.map((idx) => (
                      <ClusterChip
                        key={idx}
                        color={clusterColor(lookup.clusters, idx)}
                        label={lookup.clusters.find((c) => c.idx === idx)?.label ?? null}
                        className="text-[11px]"
                      />
                    ))}
                  </div>
                ) : null}
              </div>
              <p className="text-muted-foreground max-w-[80ch] text-[13px] leading-5">{t.description}</p>
            </div>

            {positions.length > 0 ? (
              <div
                className={cn(
                  "border-border/60 grid grid-cols-1 border-t",
                  positions.length === 2 && "sm:grid-cols-[1fr_auto_1fr]",
                  positions.length >= 3 && "md:grid-cols-[1fr_auto_1fr_auto_1fr]",
                )}
              >
                {positions.map((pos, i) => (
                  <Fragment key={`${i}-${pos.stance}`}>
                    {i > 0 ? <Versus wide={positions.length >= 3 ? "md" : "sm"} /> : null}
                    <div className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:px-5">
                      <p className="text-foreground/90 text-[13px] leading-5">{pos.stance}</p>
                      <PaperChips ids={pos.paperIds} lookup={lookup} limit={4} />
                    </div>
                  </Fragment>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Versus({ wide }: { wide: "sm" | "md" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex items-center justify-center",
        wide === "sm" ? "h-0 sm:h-auto sm:w-0" : "h-0 md:h-auto md:w-0",
      )}
    >
      <span className={cn("bg-border/70 absolute inset-x-4 top-0 h-px", wide === "sm" ? "sm:inset-x-auto sm:inset-y-3 sm:h-auto sm:w-px" : "md:inset-x-auto md:inset-y-3 md:h-auto md:w-px")} />
      <span className="bg-card text-muted-foreground border-border/70 relative z-10 rounded-full border px-1.5 py-px text-[10px] leading-4">vs</span>
    </div>
  );
}

/** Open problems: why we think it's open, the papers that show it, and where to go next. */
export function Gaps({ gaps, lookup }: { gaps: Gap[]; lookup: PaperLookup }) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {gaps.map((g, gi) => (
        <li key={`${gi}-${g.title}`} className={cn(CARD_CLASS, "flex min-w-0 flex-col")}>
          <div className="flex flex-1 flex-col gap-2.5 px-4 pt-3.5 pb-3">
            <h3 className="text-[14px] leading-5 font-semibold text-balance">{g.title}</h3>
            <p className="text-foreground/85 text-[13px] leading-5">{g.description}</p>

            {g.evidence.trim() || g.evidencePaperIds.length > 0 ? (
              <div className="bg-muted/40 flex flex-col gap-2 rounded-lg px-3 py-2.5">
                <span className="text-foreground/75 text-[11px] font-medium">Why it’s open</span>
                {g.evidence.trim() ? <p className="text-muted-foreground text-xs leading-5">{g.evidence}</p> : null}
                <PaperChips ids={g.evidencePaperIds} lookup={lookup} limit={4} />
              </div>
            ) : null}
          </div>

          {g.directions.length > 0 ? (
            <div className="border-border/60 flex flex-col gap-1.5 border-t px-4 py-3">
              <span className="text-foreground/75 text-[11px] font-medium">Directions</span>
              <ul className="flex flex-col gap-1">
                {g.directions.map((d, i) => (
                  <li key={`${i}-${d}`} className="text-foreground/85 flex gap-1.5 text-[12.5px] leading-5">
                    <CornerDownRightIcon className="text-muted-foreground/70 mt-[3px] size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0">{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
