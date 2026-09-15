"use client";

import { CheckIcon, HistoryIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEPTH_LABELS } from "@/lib/landscape/constants";
import type { SearchSummary } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { formatUsd, relativeTime, SEARCH_KIND_LABELS, SEARCH_STATUS_LABELS } from "./format";

type SearchHistoryMenuProps = {
  /** Newest first. */
  searches: SearchSummary[];
  selectedId: string | null;
  latestDoneId: string | null;
  onSelect: (searchId: string) => void;
};

/** Every search of a topic; picking a finished one shows its snapshot (`?search=`). */
export function SearchHistoryMenu({ searches, selectedId, latestDoneId, onSelect }: SearchHistoryMenuProps) {
  const viewingOlder = selectedId !== null && latestDoneId !== null && selectedId !== latestDoneId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="text-xs" disabled={searches.length === 0}>
          <HistoryIcon data-icon="inline-start" />
          History
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">{searches.length}</span>
          {viewingOlder ? <span aria-label="Viewing an older search" className="size-1.5 rounded-full bg-amber-500" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-muted-foreground text-[11px] font-medium tracking-[0.06em] uppercase">
          Searches
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {searches.map((s) => {
          const selectable = s.status === "done";
          const selected = s.id === selectedId;
          const when = relativeTime(s.finishedAt ?? s.startedAt ?? s.createdAt);
          return (
            <DropdownMenuItem
              key={s.id}
              disabled={!selectable}
              onSelect={() => onSelect(s.id)}
              className="items-start gap-2.5 py-1.5"
            >
              <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                {selected ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {SEARCH_KIND_LABELS[s.kind]}
                  <span className="text-muted-foreground font-normal">{DEPTH_LABELS[s.depth]}</span>
                  {s.id === latestDoneId ? (
                    <span className="text-muted-foreground bg-muted rounded px-1 text-[10px] font-normal">Latest</span>
                  ) : null}
                  {s.status !== "done" ? (
                    <span
                      className={cn(
                        "ml-auto rounded px-1 text-[10px] font-normal",
                        s.status === "error" || s.status === "interrupted"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {SEARCH_STATUS_LABELS[s.status]}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <span>{when ?? "—"}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular">{s.paperCount} papers</span>
                  <span aria-hidden>·</span>
                  <span className="font-mono tracking-tight tabular-nums">{formatUsd(s.costUsd)}</span>
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
