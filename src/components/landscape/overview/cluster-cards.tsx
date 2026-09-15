"use client";

import type { ClustersDocument } from "@/lib/landscape/llm/synthesize/schemas";
import type { ClusterDTO } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { colorSlotVar } from "../cluster-colors";
import { CARD_CLASS, PaperChip, resolvePapers, type PaperLookup, yearRange } from "./primitives";
import { ChangeBadge } from "./summary-hero";

/**
 * One card per cluster. Synthesized names, summaries and key ideas are layered on
 * the heuristic ClusterDTO, so cards still render (with key terms) when the
 * clusters document is missing.
 */
export function ClusterCards({
  clusters,
  doc,
  lookup,
}: {
  clusters: ClusterDTO[];
  doc: ClustersDocument | null;
  lookup: PaperLookup;
}) {
  const synth = new Map((doc?.clusters ?? []).map((c) => [c.idx, c]));
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {clusters.map((c) => {
        const s = synth.get(c.idx);
        const color = colorSlotVar(c.color);
        const summary = s?.summary || c.summary;
        const repIds = s?.representativePaperIds.length ? s.representativePaperIds : c.paperIds.slice(0, 3);
        const reps = resolvePapers(repIds, lookup.byId).slice(0, 4);
        const years = yearRange(c.yearMin, c.yearMax);
        return (
          <li
            key={c.idx}
            id={`overview-cluster-${c.idx}`}
            className={cn(CARD_CLASS, "relative flex min-w-0 scroll-mt-20 flex-col overflow-hidden")}
          >
            <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />
            <div className="flex flex-1 flex-col gap-2.5 px-4 pt-4 pb-3.5">
              <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 text-[14px] leading-5 font-semibold text-balance">{s?.name || c.label}</h3>
                {c.change && c.change !== "stable" ? <ChangeBadge change={c.change} className="mt-px" /> : null}
              </div>
              <p className="text-muted-foreground -mt-1.5 font-mono text-[11px] tracking-tight tabular-nums">
                {c.size} {c.size === 1 ? "paper" : "papers"}
                {years ? ` · ${years}` : ""}
              </p>

              {summary ? <p className="text-foreground/85 text-[13px] leading-5">{summary}</p> : null}

              {s && s.keyIdeas.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {s.keyIdeas.slice(0, 5).map((idea, i) => (
                    <li key={`${i}-${idea}`} className="text-foreground/80 flex gap-2 text-[12.5px] leading-5">
                      <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="min-w-0">{idea}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {reps.length > 0 ? (
                <div className="mt-auto flex flex-col gap-1.5 pt-1">
                  <span className="text-muted-foreground/80 text-[11px]">Representative papers</span>
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    {reps.map((p) => (
                      <PaperChip key={p.id} paper={p} clusters={lookup.clusters} onOpenPaper={lookup.onOpenPaper} />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {c.keyTerms.length > 0 ? (
              <p className="border-border/60 text-muted-foreground/80 truncate border-t px-4 py-2 text-[11px]" title={c.keyTerms.join(", ")}>
                {c.keyTerms.slice(0, 6).join(", ")}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
