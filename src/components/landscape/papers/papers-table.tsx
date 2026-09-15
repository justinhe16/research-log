"use client";

import { ArrowDownIcon, ArrowUpIcon, BookmarkCheckIcon, SparklesIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ClusterDTO, PaperLite } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor } from "../cluster-colors";
import { formatCount, shortDate } from "../format";
import { ClusterChip, ScoreBar } from "../metric";

export type PaperSortKey = "rank" | "relevance" | "influence" | "date" | "citations";
export type SortState = { key: PaperSortKey; dir: "asc" | "desc" };

/** Natural first direction per column: rank ascending, everything else biggest first. */
export const DEFAULT_SORT_DIR: Record<PaperSortKey, "asc" | "desc"> = {
  rank: "asc",
  relevance: "desc",
  influence: "desc",
  date: "desc",
  citations: "desc",
};

const HEAD = "text-muted-foreground h-9 px-3 text-[11px] font-medium tracking-[0.06em] uppercase first:pl-4 last:pr-4";
const CELL = "px-3 py-2.5 first:pl-4 last:pr-4";

type PapersTableProps = {
  papers: PaperLite[];
  clusters: ClusterDTO[];
  newPaperIds: Set<string>;
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  onOpen: (paperId: string) => void;
  /** Rendered in place of rows (empty filter result). */
  emptyState?: React.ReactNode;
};

export function PapersTable({ papers, clusters, newPaperIds, sort, onSortChange, onOpen, emptyState }: PapersTableProps) {
  const clusterById = new Map(clusters.map((c) => [c.idx, c]));

  function header(key: PaperSortKey, label: string, className?: string, align: "left" | "right" = "left") {
    const active = sort.key === key;
    const Arrow = sort.dir === "asc" ? ArrowUpIcon : ArrowDownIcon;
    return (
      <TableHead
        className={cn(HEAD, className, align === "right" && "text-right")}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          onClick={() =>
            onSortChange(
              active
                ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
                : { key, dir: DEFAULT_SORT_DIR[key] },
            )
          }
          className={cn(
            "hover:text-foreground focus-visible:ring-ring/50 -mx-1 inline-flex items-center gap-1 rounded px-1 uppercase transition-colors outline-none focus-visible:ring-2",
            active && "text-foreground",
            align === "right" && "flex-row-reverse",
          )}
        >
          {label}
          <Arrow className={cn("size-3", active ? "opacity-80" : "opacity-0")} aria-hidden />
        </button>
      </TableHead>
    );
  }

  return (
    <div className="bg-card border-border/70 overflow-hidden rounded-xl border shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="border-border/60 bg-muted/30 hover:bg-transparent">
            {header("rank", "#", "w-12")}
            <TableHead className={HEAD}>Paper</TableHead>
            <TableHead className={cn(HEAD, "hidden w-[180px] lg:table-cell")}>Cluster</TableHead>
            {header("relevance", "Relevance", "hidden w-[104px] sm:table-cell")}
            {header("influence", "Influence", "hidden w-[104px] md:table-cell")}
            {header("date", "Date", "hidden w-[84px] md:table-cell")}
            {header("citations", "Cites", "w-[72px]", "right")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {papers.length === 0 && emptyState ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="p-0">
                {emptyState}
              </TableCell>
            </TableRow>
          ) : (
            papers.map((paper) => {
              const cluster = paper.clusterIdx !== null ? clusterById.get(paper.clusterIdx) : undefined;
              const color = clusterColor(clusters, paper.clusterIdx);
              const isNew = newPaperIds.has(paper.id);
              return (
                <TableRow
                  key={paper.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open ${paper.title}`}
                  onClick={() => onOpen(paper.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(paper.id);
                    }
                  }}
                  className="group border-border/60 hover:bg-muted/40 focus-visible:bg-muted/60 cursor-pointer align-top transition-colors outline-none"
                >
                  <TableCell className={cn(CELL, "text-muted-foreground font-mono text-[11px] tracking-tight tabular-nums")}>
                    <span className="flex items-center gap-1.5 pt-0.5">
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full lg:hidden"
                        style={{ background: color ?? "transparent" }}
                      />
                      {paper.rank}
                    </span>
                  </TableCell>

                  <TableCell className={cn(CELL, "max-w-0")}>
                    <div className="flex flex-col gap-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="text-foreground/90 group-hover:text-foreground truncate text-sm leading-5 font-medium tracking-tight transition-colors">
                          {paper.title}
                        </span>
                        {paper.loggedEntryId ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <BookmarkCheckIcon className="text-muted-foreground size-3.5 shrink-0" aria-label="In your log" />
                            </TooltipTrigger>
                            <TooltipContent>In your log</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px]">
                        <span className="truncate">{authorLine(paper.authors)}</span>
                        {paper.gameChanger ? (
                          <Badge variant="outline" className="border-border/70 text-foreground/80 h-4 shrink-0 rounded px-1 text-[10px] font-normal">
                            <SparklesIcon aria-hidden />
                            Game-changer
                          </Badge>
                        ) : paper.foundational ? (
                          <Badge variant="outline" className="border-border/70 text-muted-foreground h-4 shrink-0 rounded px-1 text-[10px] font-normal">
                            Foundational
                          </Badge>
                        ) : null}
                        {isNew ? (
                          <Badge className="h-4 shrink-0 rounded bg-emerald-500/12 px-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                            New
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className={cn(CELL, "hidden max-w-0 lg:table-cell")}>
                    <ClusterChip color={color} label={cluster?.label ?? null} className="pt-0.5" />
                  </TableCell>

                  <TableCell className={cn(CELL, "hidden sm:table-cell")}>
                    <ScoreBar value={paper.relevance} label="Relevance" className="pt-1" />
                  </TableCell>

                  <TableCell className={cn(CELL, "hidden md:table-cell")}>
                    <ScoreBar value={paper.influence} label="Influence" className="pt-1" />
                  </TableCell>

                  <TableCell className={cn(CELL, "text-muted-foreground hidden font-mono text-[11px] tracking-tight whitespace-nowrap tabular-nums md:table-cell")}>
                    <span className="block pt-0.5">{shortDate(paper)}</span>
                  </TableCell>

                  <TableCell className={cn(CELL, "text-right font-mono text-[11px] tracking-tight tabular-nums")}>
                    <span className="text-foreground/80 block pt-0.5">{formatCount(paper.citationCount)}</span>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export function authorLine(authors: string[]): string {
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= 2) return authors.join(", ");
  return `${authors[0]}, ${authors[1]} +${authors.length - 2}`;
}

/** Moved to ../format; re-exported for existing importers. */
export { shortDate } from "../format";

export function paperTime(paper: Pick<PaperLite, "publishedAt" | "year">): number {
  if (paper.publishedAt) {
    const t = Date.parse(paper.publishedAt);
    if (!Number.isNaN(t)) return t;
  }
  return paper.year ? Date.UTC(paper.year, 6, 1) : Number.NEGATIVE_INFINITY;
}
