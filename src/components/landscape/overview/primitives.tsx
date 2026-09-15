"use client";

import type { ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import type { ClusterDTO, PaperLite } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor } from "../cluster-colors";

/** Everything a section needs to resolve paper ids into chips. */
export type PaperLookup = {
  byId: Map<string, PaperLite>;
  clusters: ClusterDTO[];
  onOpenPaper: (paperId: string) => void;
};

export const CARD_CLASS = "bg-card border-border/70 rounded-xl border shadow-sm";

export function Section({
  id,
  title,
  count,
  description,
  aside,
  children,
  className,
}: {
  id: string;
  title: string;
  count?: number;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `overview-${id}`;
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={headingId} className="flex items-baseline gap-2 text-[15px] leading-6 font-semibold">
            {title}
            {count !== undefined ? (
              <span className="text-muted-foreground font-mono text-[11px] font-normal tracking-tight tabular-nums">{count}</span>
            ) : null}
          </h2>
          {description ? <p className="text-muted-foreground text-xs leading-5">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Quiet inline notice for a section whose synthesis failed. */
export function SectionNotice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border-border/70 text-muted-foreground flex items-start gap-2.5 rounded-xl border border-dashed px-4 py-3 text-xs leading-5">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="flex flex-col">
        <span className="text-foreground/85 font-medium">{title}</span>
        {children ? <span>{children}</span> : null}
      </div>
    </div>
  );
}

/** A paper reference as a keyboard-accessible chip that opens the paper sheet. */
export function PaperChip({
  paper,
  clusters,
  onOpenPaper,
  className,
  trailing,
}: {
  paper: PaperLite;
  clusters: ClusterDTO[];
  onOpenPaper: (paperId: string) => void;
  className?: string;
  trailing?: ReactNode;
}) {
  const color = clusterColor(clusters, paper.clusterIdx);
  return (
    <button
      type="button"
      onClick={() => onOpenPaper(paper.id)}
      title={paper.title}
      aria-label={paper.title}
      className={cn(
        "group/chip border-border/70 bg-background/60 text-foreground/85 inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-[11.5px] leading-none transition-colors outline-none",
        "hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:border-ring/60 focus-visible:ring-ring/25 focus-visible:ring-[3px]",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color ?? "var(--muted-foreground)" }} />
      <span className="min-w-0 truncate">{shortTitle(paper.title)}</span>
      {paper.year ? (
        <span className="text-muted-foreground shrink-0 font-mono text-[10.5px] tracking-tight tabular-nums">{paper.year}</span>
      ) : null}
      {trailing}
    </button>
  );
}

/** Chips for a list of paper ids; unknown ids are dropped. */
export function PaperChips({
  ids,
  lookup,
  limit,
  className,
  chipClassName,
}: {
  ids: string[];
  lookup: PaperLookup;
  limit?: number;
  className?: string;
  chipClassName?: string;
}) {
  const papers = resolvePapers(ids, lookup.byId);
  if (papers.length === 0) return null;
  const shown = limit ? papers.slice(0, limit) : papers;
  const hidden = papers.length - shown.length;
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      {shown.map((p) => (
        <PaperChip key={p.id} paper={p} clusters={lookup.clusters} onOpenPaper={lookup.onOpenPaper} className={chipClassName} />
      ))}
      {hidden > 0 ? <span className="text-muted-foreground self-center text-[11px]">+{hidden} more</span> : null}
    </div>
  );
}

export function resolvePapers(ids: string[], byId: Map<string, PaperLite>): PaperLite[] {
  const seen = new Set<string>();
  const out: PaperLite[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      seen.add(id);
      out.push(p);
    }
  }
  return out;
}

/** "Sparse Feature Circuits: Discovering and Editing…" -> "Sparse Feature Circuits". */
export function shortTitle(title: string): string {
  const head = title.split(/:\s/)[0]?.trim() ?? title;
  return head.length >= 12 ? head : title;
}

export function yearRange(start: number | null, end: number | null, openEnded = false): string {
  if (start === null && end === null) return "";
  if (start !== null && end === null) return openEnded ? `${start}–now` : `${start}`;
  if (start === null) return `${end}`;
  return start === end ? `${start}` : `${start}–${end}`;
}
