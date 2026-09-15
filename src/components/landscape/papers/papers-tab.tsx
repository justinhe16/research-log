"use client";

import { useMemo, useState } from "react";
import { FilterXIcon, SearchIcon, SearchXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LandscapeSnapshot, PaperLite } from "@/lib/landscape/types";
import { clusterColor } from "../cluster-colors";
import { ClusterChip } from "../metric";
import { StateMessage } from "../state-message";
import { PapersTable, paperTime, type SortState } from "./papers-table";

const ALL = "all";

export type PapersTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

function compare(a: PaperLite, b: PaperLite, sort: SortState): number {
  const nullsLast = (x: number | null, y: number | null) => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sort.dir === "asc" ? x - y : y - x;
  };
  let result: number;
  switch (sort.key) {
    case "rank":
      result = nullsLast(a.rank, b.rank);
      break;
    case "relevance":
      result = nullsLast(a.relevance, b.relevance);
      break;
    case "influence":
      result = nullsLast(a.influence, b.influence);
      break;
    case "citations":
      result = nullsLast(a.citationCount, b.citationCount);
      break;
    case "date": {
      const ta = paperTime(a);
      const tb = paperTime(b);
      result = nullsLast(Number.isFinite(ta) ? ta : null, Number.isFinite(tb) ? tb : null);
      break;
    }
  }
  return result || a.rank - b.rank;
}

export function PapersTab({ snapshot, onOpenPaper }: PapersTabProps) {
  const [query, setQuery] = useState("");
  const [cluster, setCluster] = useState<string>(ALL);
  const [hideLogged, setHideLogged] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: "rank", dir: "asc" });

  const newPaperIds = useMemo(() => new Set(snapshot.documents.diff?.newPaperIds ?? []), [snapshot.documents.diff]);
  const hasFilters = query.trim() !== "" || cluster !== ALL || hideLogged;
  const loggedCount = snapshot.papers.filter((p) => p.loggedEntryId).length;

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.papers
      .filter((p) => {
        if (cluster !== ALL && String(p.clusterIdx) !== cluster) return false;
        if (hideLogged && p.loggedEntryId) return false;
        if (needle) {
          const hay = `${p.title} ${p.authors.join(" ")} ${p.venue ?? ""} ${p.tldr ?? ""}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      })
      .sort((a, b) => compare(a, b, sort));
  }, [snapshot.papers, query, cluster, hideLogged, sort]);

  function clearFilters() {
    setQuery("");
    setCluster(ALL);
    setHideLogged(false);
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground/70 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, authors, venues…"
            className="h-8 pl-8 text-sm"
            aria-label="Search papers"
          />
        </div>
        <div className="flex items-center gap-2">
          {snapshot.clusters.length > 0 ? (
            <Select value={cluster} onValueChange={setCluster}>
              <SelectTrigger
                className="text-muted-foreground data-[state=open]:text-foreground w-full text-xs sm:w-[200px]"
                aria-label="Filter by cluster"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All clusters</SelectItem>
                {snapshot.clusters.map((c) => (
                  <SelectItem key={c.idx} value={String(c.idx)}>
                    <ClusterChip color={clusterColor(snapshot.clusters, c.idx)} label={c.label} className="text-foreground" />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {loggedCount > 0 ? (
            <Label className="text-muted-foreground hover:text-foreground flex h-8 shrink-0 cursor-pointer items-center gap-2 px-1 text-xs font-normal whitespace-nowrap">
              <Checkbox checked={hideLogged} onCheckedChange={(v) => setHideLogged(v === true)} />
              Hide logged
            </Label>
          ) : null}
          {hasFilters ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={clearFilters}
              aria-label="Clear filters"
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <FilterXIcon />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="text-muted-foreground flex items-center gap-2 px-0.5 text-[11px]">
        <span className="tabular">
          {rows.length} {rows.length === 1 ? "paper" : "papers"}
          {hasFilters && rows.length !== snapshot.papers.length ? ` of ${snapshot.papers.length}` : ""}
        </span>
        {newPaperIds.size > 0 ? (
          <>
            <span className="bg-border h-3 w-px" aria-hidden />
            <span className="tabular">{newPaperIds.size} new since last search</span>
          </>
        ) : null}
        {loggedCount > 0 ? (
          <>
            <span className="bg-border h-3 w-px" aria-hidden />
            <span className="tabular">{loggedCount} in your log</span>
          </>
        ) : null}
      </div>

      <PapersTable
        papers={rows}
        clusters={snapshot.clusters}
        newPaperIds={newPaperIds}
        sort={sort}
        onSortChange={setSort}
        onOpen={onOpenPaper}
        emptyState={
          <StateMessage
            className="rounded-none border-0"
            icon={<SearchXIcon />}
            title={snapshot.papers.length === 0 ? "This search selected no papers" : "No papers match your filters"}
            body={
              snapshot.papers.length === 0
                ? "Try a broader topic name or a deeper search."
                : "Try a different search term or show every cluster."
            }
            action={
              hasFilters ? (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
      />
    </section>
  );
}
