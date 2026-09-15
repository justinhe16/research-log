"use client";

import Link from "next/link";
import { ArrowUpRightIcon, CopyIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SimilarTopic } from "@/lib/landscape/types";
import { withFixture, type FixtureMode } from "./fixture-mode";
import { relativeTime } from "./format";

type SimilarTopicAlertProps = {
  name: string;
  similar: SimilarTopic[];
  /** Which action is in flight, to show a spinner and lock the others. */
  busy: { kind: "refresh"; topicId: string } | { kind: "create" } | null;
  onRefresh: (topic: SimilarTopic) => void;
  onCreateAnyway: () => void;
  onDismiss: () => void;
  fixture?: FixtureMode | null;
};

/** Shown when `POST /topics` returns 409: open an existing topic, refresh it, or create anyway. */
export function SimilarTopicAlert({
  name,
  similar,
  busy,
  onRefresh,
  onCreateAnyway,
  onDismiss,
  fixture = null,
}: SimilarTopicAlertProps) {
  const single = similar.length === 1;
  return (
    <Alert className="border-border/70 animate-in fade-in-0 slide-in-from-top-1 gap-2 rounded-xl px-4 py-3.5 shadow-sm duration-150">
      <CopyIcon className="text-muted-foreground" />
      <AlertTitle className="pr-8 text-sm">
        {single ? "A similar topic already exists" : `${similar.length} similar topics already exist`}
      </AlertTitle>
      <AlertDescription className="text-xs">
        Refreshing an existing topic reuses its papers and only reads what is new, so it is faster and cheaper than
        starting over.
      </AlertDescription>

      <ul className="col-start-2 mt-1.5 flex flex-col gap-1.5">
        {similar.map((topic) => {
          const refreshing = busy?.kind === "refresh" && busy.topicId === topic.id;
          const last = relativeTime(topic.lastSearchAt);
          return (
            <li
              key={topic.id}
              className="bg-muted/40 border-border/60 flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-foreground truncate text-sm font-medium tracking-tight">{topic.name}</span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-[11px]">
                  <span className="tabular">{Math.round(topic.similarity * 100)}% similar</span>
                  <span aria-hidden className="bg-border h-3 w-px" />
                  <span className="tabular">{topic.paperCount} papers</span>
                  {last ? (
                    <>
                      <span aria-hidden className="bg-border h-3 w-px" />
                      <span>searched {last}</span>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button asChild size="sm" variant="ghost" className="text-xs">
                  <Link href={withFixture(`/landscape/${encodeURIComponent(topic.id)}`, fixture)}>
                    Open
                    <ArrowUpRightIcon data-icon="inline-end" />
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  disabled={busy !== null}
                  onClick={() => onRefresh(topic)}
                >
                  {refreshing ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                  Refresh it
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="col-start-2 mt-1 flex items-center gap-2">
        <Button size="sm" variant="ghost" className="text-muted-foreground -ml-2.5 text-xs" disabled={busy !== null} onClick={onCreateAnyway}>
          {busy?.kind === "create" ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : null}
          Create “{name}” anyway
        </Button>
      </div>

      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-muted-foreground absolute top-2.5 right-2.5"
      >
        <XIcon />
      </Button>
    </Alert>
  );
}
