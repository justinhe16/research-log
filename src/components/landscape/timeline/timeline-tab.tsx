"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { CalendarOffIcon, ChartGanttIcon } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { clusterColor } from "../cluster-colors";
import { LABEL_CLASS } from "../metric";
import { StateMessage } from "../state-message";
import { paperYearFraction } from "./layout";

export type TimelineTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

const ClusterLanes = dynamic(() => import("./cluster-lanes"), { ssr: false, loading: () => <TimelineSkeleton /> });

export function TimelineTab({ snapshot, onOpenPaper }: TimelineTabProps) {
  const undated = useMemo(() => snapshot.papers.filter((p) => paperYearFraction(p) === null), [snapshot.papers]);
  const narrativeFailed = snapshot.failedDocuments.includes("narrative");
  const hasEras = (snapshot.documents.narrative?.eras.length ?? 0) > 0;

  if (snapshot.papers.length === 0) {
    return (
      <StateMessage
        icon={<ChartGanttIcon />}
        title="Nothing to place on the timeline"
        body="This search selected no papers. Try a broader topic name or a deeper search."
      />
    );
  }

  if (undated.length === snapshot.papers.length) {
    return (
      <div className="flex flex-col gap-4">
        <StateMessage
          icon={<CalendarOffIcon />}
          title="No publication dates"
          body="None of these papers came with a date, so they can't be placed in time. They are listed below and in the Papers tab."
        />
        <UndatedList papers={undated} snapshot={snapshot} onOpenPaper={onOpenPaper} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ClusterLanes snapshot={snapshot} onOpenPaper={onOpenPaper} />
      {!hasEras ? (
        <p className="text-muted-foreground px-0.5 text-[11px]">
          {narrativeFailed
            ? "Eras are missing because the narrative failed to generate. Retry synthesis above to add them."
            : "No eras were written for this search, so the background is left plain."}
        </p>
      ) : null}
      {undated.length > 0 ? <UndatedList papers={undated} snapshot={snapshot} onOpenPaper={onOpenPaper} /> : null}
    </div>
  );
}

function UndatedList({
  papers,
  snapshot,
  onOpenPaper,
}: {
  papers: LandscapeSnapshot["papers"];
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
}) {
  return (
    <section className="flex flex-col gap-1.5" aria-label="Papers without a date">
      <h3 className={LABEL_CLASS}>
        Without a date <span className="text-muted-foreground/70 tabular">{papers.length}</span>
      </h3>
      <ul className="border-border/60 divide-border/60 flex flex-col divide-y overflow-hidden rounded-lg border">
        {papers.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onOpenPaper(p.id)}
              className="hover:bg-muted/50 focus-visible:bg-muted/60 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors outline-none"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: clusterColor(snapshot.clusters, p.clusterIdx) ?? "var(--border)" }}
              />
              <span className="text-foreground/90 min-w-0 flex-1 truncate text-[13px]">{p.title}</span>
              <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">#{p.rank}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TimelineSkeleton() {
  return (
    <div className="border-border/70 bg-card overflow-hidden rounded-xl border shadow-sm" aria-busy="true" aria-label="Loading timeline">
      <div className="border-border/60 flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-7 w-40" />
      </div>
      <div className="flex">
        <div className="border-border/60 flex w-[116px] shrink-0 flex-col gap-14 border-r px-4 py-12 sm:w-[188px]">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-3.5 w-3/4" />
          ))}
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-[260px] w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
