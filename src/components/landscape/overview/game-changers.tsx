"use client";

import { SparklesIcon } from "lucide-react";

import type { NarrativeDocument } from "@/lib/landscape/llm/synthesize/schemas";
import type { PaperLite } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor } from "../cluster-colors";
import { formatCount } from "../format";
import { ClusterChip } from "../metric";
import { CARD_CLASS, type PaperLookup } from "./primitives";

type Item = { paper: PaperLite; why: string | null; evidence: string | null };

/**
 * Papers that shifted the field. Uses the narrative's picks when available,
 * otherwise falls back to the pipeline's `gameChanger` flags with the tldr.
 */
export function GameChangers({
  narrative,
  papers,
  lookup,
}: {
  narrative: NarrativeDocument | null;
  papers: PaperLite[];
  lookup: PaperLookup;
}) {
  const items: Item[] = narrative
    ? narrative.gameChangers.flatMap((g, i, all) => {
        const paper = lookup.byId.get(g.paperId);
        const firstOccurrence = all.findIndex((o) => o.paperId === g.paperId) === i;
        return paper && firstOccurrence ? [{ paper, why: g.why, evidence: g.evidence }] : [];
      })
    : papers.filter((p) => p.gameChanger).slice(0, 5).map((paper) => ({ paper, why: paper.tldr, evidence: null }));

  if (items.length === 0) return null;
  const maxCites = Math.max(1, ...items.map((i) => i.paper.citationCount ?? 0));
  const maxVelocity = Math.max(1, ...items.map((i) => i.paper.velocity ?? 0));

  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {items.map(({ paper, why, evidence }) => {
        const cluster = lookup.clusters.find((c) => c.idx === paper.clusterIdx);
        const color = clusterColor(lookup.clusters, paper.clusterIdx);
        return (
          <li
            key={paper.id}
            className={cn(
              CARD_CLASS,
              "group/gc relative flex min-w-0 flex-col transition-colors",
              "hover:border-border hover:bg-muted/20 focus-within:border-ring/50 focus-within:ring-ring/20 focus-within:ring-[3px]",
            )}
          >
            <div className="flex flex-1 flex-col gap-2 px-4 pt-3.5 pb-3">
              <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px]">
                <SparklesIcon className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                {cluster ? <ClusterChip color={color} label={cluster.label} className="text-[11px]" /> : null}
                <span className="ml-auto shrink-0 font-mono tracking-tight tabular-nums">{paper.year ?? ""}</span>
              </div>
              <h3 className="text-[14px] leading-5 font-semibold text-balance">
                <button
                  type="button"
                  onClick={() => lookup.onOpenPaper(paper.id)}
                  className="text-left outline-none after:absolute after:inset-0 after:rounded-xl"
                >
                  {paper.title}
                </button>
              </h3>
              {why ? <p className="text-foreground/85 text-[13px] leading-5">{why}</p> : null}
              {evidence ? (
                <p className="text-muted-foreground border-border/80 mt-auto border-l-2 pl-2.5 text-xs leading-5">{evidence}</p>
              ) : null}
            </div>

            <dl className="border-border/60 grid grid-cols-3 gap-3 border-t px-4 py-2.5">
              <Stat label="Citations" value={formatCount(paper.citationCount)} fill={(paper.citationCount ?? 0) / maxCites} color={color} />
              <Stat
                label="Per year"
                value={paper.velocity === null ? "—" : formatCount(paper.velocity)}
                fill={(paper.velocity ?? 0) / maxVelocity}
                color={color}
              />
              <Stat
                label="PageRank"
                value={paper.pagerank === null ? "—" : String(Math.round(paper.pagerank * 100))}
                fill={paper.pagerank ?? 0}
                color={color}
              />
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({ label, value, fill, color }: { label: string; value: string; fill: number; color: string | null }) {
  const w = Math.max(0, Math.min(1, Number.isFinite(fill) ? fill : 0));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground truncate text-[10.5px]">{label}</dt>
      <dd className="flex flex-col gap-1">
        <span className="text-foreground/90 font-mono text-[12px] tracking-tight tabular-nums">{value}</span>
        <span aria-hidden className="bg-muted relative h-1 w-full overflow-hidden rounded-full">
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${w * 100}%`, background: color ?? "var(--foreground)" }} />
        </span>
      </dd>
    </div>
  );
}
