"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, ChevronDownIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

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
import { estimate } from "@/lib/landscape/estimate";
import { DEPTHS, type Depth, type StartSearchInput, type TopicDetail } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { withFixture, type FixtureMode } from "./fixture-mode";
import { formatMinutesRange, formatUsd, relativeTime } from "./format";
import { SearchHistoryMenu } from "./search-history-menu";

type TopicHeaderProps = {
  topic: TopicDetail;
  selectedSearchId: string | null;
  onSelectSearch: (searchId: string) => void;
  onStartSearch: (input: StartSearchInput) => void;
  /** A search is queued/running, so new ones are blocked. */
  searchActive: boolean;
  starting: boolean;
  hasS2Key?: boolean;
  fixture?: FixtureMode | null;
};

export function TopicHeader({
  topic,
  selectedSearchId,
  onSelectSearch,
  onStartSearch,
  searchActive,
  starting,
  hasS2Key,
  fixture = null,
}: TopicHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const [now] = useState(() => Date.now());
  const latestDone = topic.lastSearch;
  const selected = topic.searches.find((s) => s.id === selectedSearchId) ?? null;
  const viewingOlder = selected !== null && latestDone !== null && selected.id !== latestDone.id;
  const hasDone = latestDone !== null;
  const blocked = searchActive || starting;
  const daysSince = latestDone
    ? Math.max(0, (now - new Date(latestDone.startedAt ?? latestDone.createdAt).getTime()) / 86_400_000)
    : undefined;
  const refreshEstimate = hasDone
    ? estimate(latestDone.depth, { hasS2Key: hasS2Key ?? true, refresh: { daysSince: daysSince ?? 0 } })
    : null;
  const summary = topic.summary;
  const when = relativeTime(latestDone?.finishedAt ?? topic.lastSearchAt);

  return (
    <header className="flex flex-col gap-3">
      <Link
        href={withFixture("/landscape", fixture)}
        className="text-muted-foreground hover:text-foreground -ml-0.5 inline-flex w-fit items-center gap-1 text-xs transition-colors"
      >
        <ArrowLeftIcon className="size-3" aria-hidden />
        All topics
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-xl leading-7 font-semibold text-balance">{topic.name}</h1>
          {topic.description ? <p className="text-muted-foreground text-sm">{topic.description}</p> : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <SearchHistoryMenu
            searches={topic.searches}
            selectedId={selectedSearchId}
            latestDoneId={latestDone?.id ?? null}
            onSelect={onSelectSearch}
          />

          <div className="flex items-center">
            <Button
              size="sm"
              className="rounded-r-none text-xs"
              disabled={blocked}
              onClick={() =>
                onStartSearch(hasDone ? { mode: "refresh" } : { mode: "full", depth: topic.defaultDepth })
              }
              title={
                refreshEstimate
                  ? `About ${formatUsd(refreshEstimate.costUsd.expected)}, ${formatMinutesRange(refreshEstimate.minutes.low, refreshEstimate.minutes.high)}`
                  : undefined
              }
            >
              {starting ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {hasDone ? "Refresh" : "Run search"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="border-primary-foreground/15 rounded-l-none border-l px-1.5"
                  disabled={blocked}
                  aria-label="More search options"
                >
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {refreshEstimate && latestDone ? (
                  <>
                    <DropdownMenuItem onSelect={() => onStartSearch({ mode: "refresh" })} className="flex-col items-start gap-0">
                      <span className="text-xs font-medium">Refresh</span>
                      <span className="text-muted-foreground text-[11px]">
                        New papers since {relativeTime(latestDone.startedAt ?? latestDone.createdAt)} ·{" "}
                        ~{formatUsd(refreshEstimate.costUsd.expected)}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuLabel className="text-muted-foreground text-[11px] font-medium tracking-[0.06em] uppercase">
                  {hasDone ? "Re-run from scratch" : "Run at depth"}
                </DropdownMenuLabel>
                {DEPTHS.map((d) => (
                  <RerunItem
                    key={d}
                    depth={d}
                    hasS2Key={hasS2Key}
                    current={latestDone?.depth === d}
                    onSelect={() => onStartSearch({ mode: "full", depth: d })}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {summary ? (
        <div className="flex flex-col items-start gap-1">
          <p className={cn("text-foreground/85 max-w-[72ch] text-sm leading-6", !expanded && "line-clamp-3")}>{summary}</p>
          {summary.length > 280 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              aria-expanded={expanded}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
        {selected ? (
          <>
            <span>{DEPTH_LABELS[selected.depth]}</span>
            <Sep />
            <span className="tabular">{selected.paperCount} papers</span>
            <Sep />
            <span>{viewingOlder ? `Search from ${relativeTime(selected.finishedAt ?? selected.createdAt)}` : `Last search ${when ?? "—"}`}</span>
            <Sep />
            <span className="font-mono tracking-tight tabular-nums">{formatUsd(selected.costUsd)}</span>
          </>
        ) : (
          <span>Not searched yet</span>
        )}
        {viewingOlder && latestDone ? (
          <>
            <Sep />
            <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              Viewing an older search
              <button
                type="button"
                onClick={() => onSelectSearch(latestDone.id)}
                className="text-foreground underline-offset-2 hover:underline"
              >
                Show latest
              </button>
            </span>
          </>
        ) : null}
      </div>
    </header>
  );
}

function RerunItem({
  depth,
  hasS2Key,
  current,
  onSelect,
}: {
  depth: Depth;
  hasS2Key?: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  const e = estimate(depth, { hasS2Key: hasS2Key ?? true });
  return (
    <DropdownMenuItem onSelect={onSelect} className="justify-between gap-3">
      <span className="flex items-center gap-1.5 text-xs">
        {DEPTH_LABELS[depth]}
        {current ? <span className="text-muted-foreground text-[10px]">current</span> : null}
      </span>
      <span className="text-muted-foreground font-mono text-[11px] tracking-tight tabular-nums">
        ~{formatUsd(e.costUsd.expected)} · {formatMinutesRange(e.minutes.low, e.minutes.high)}
      </span>
    </DropdownMenuItem>
  );
}

function Sep() {
  return <span aria-hidden className="bg-border h-3 w-px" />;
}
