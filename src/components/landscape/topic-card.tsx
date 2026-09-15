import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { DEPTH_LABELS, STAGE_LABELS } from "@/lib/landscape/constants";
import type { TopicCard as TopicCardData } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { withFixture, type FixtureMode } from "./fixture-mode";
import { relativeTime } from "./format";
import { ProgressRing } from "./progress-ring";

export function TopicCard({ topic, fixture = null }: { topic: TopicCardData; fixture?: FixtureMode | null }) {
  const active = topic.activeSearch;
  const blurb = topic.summary || topic.description;
  const last = relativeTime(topic.lastSearchAt);
  const lastStatus = topic.lastSearch?.status;

  return (
    <Link
      href={withFixture(`/landscape/${encodeURIComponent(topic.id)}`, fixture)}
      className={cn(
        "group bg-card border-border/70 flex h-full flex-col rounded-xl border shadow-sm transition-colors outline-none",
        "hover:border-border focus-visible:border-ring/50 focus-visible:ring-ring/20 hover:bg-muted/20 focus-visible:ring-[3px]",
      )}
    >
      <div className="flex flex-1 flex-col gap-2 px-4 pt-3.5 pb-3">
        <div className="flex items-start gap-3">
          <h2 className="text-foreground/90 group-hover:text-foreground line-clamp-2 flex-1 text-[15px] leading-5 font-medium tracking-tight transition-colors">
            {topic.name}
          </h2>
          {active ? (
            <ProgressRing
              value={active.status === "queued" ? null : active.progress}
              size={22}
              label={`Search ${Math.round(active.progress * 100)}% complete`}
              className="mt-px"
            />
          ) : (
            <Badge variant="outline" className="border-border/70 text-muted-foreground mt-px rounded-md px-1.5 text-[11px] font-normal">
              {DEPTH_LABELS[topic.defaultDepth]}
            </Badge>
          )}
        </div>
        {blurb ? (
          <p className="text-muted-foreground line-clamp-3 text-[13px] leading-5">{blurb}</p>
        ) : (
          <p className="text-muted-foreground/60 text-[13px] leading-5 italic">No description</p>
        )}
      </div>

      <div className="border-border/60 text-muted-foreground flex h-9 items-center gap-2 border-t px-4 text-[11px]">
        {active ? (
          <>
            <span aria-hidden className="bg-foreground/50 size-1.5 shrink-0 animate-pulse rounded-full" />
            <span className="text-foreground/80 truncate">
              {active.status === "queued" ? "Queued" : active.stage ? STAGE_LABELS[active.stage] : "Starting"}
            </span>
            <span className="ml-auto font-mono tracking-tight tabular-nums">{Math.round(active.progress * 100)}%</span>
          </>
        ) : (
          <>
            <span className="tabular">
              {topic.paperCount} {topic.paperCount === 1 ? "paper" : "papers"}
            </span>
            <span aria-hidden className="bg-border h-3 w-px" />
            {lastStatus && lastStatus !== "done" ? (
              <span className="text-destructive flex items-center gap-1">
                <TriangleAlertIcon className="size-3" aria-hidden />
                Last search {lastStatus === "error" ? "failed" : lastStatus}
              </span>
            ) : (
              <span className="truncate">{last ? `Last search ${last}` : "Not searched yet"}</span>
            )}
          </>
        )}
      </div>
    </Link>
  );
}
