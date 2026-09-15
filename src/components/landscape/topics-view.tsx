"use client";

import { SearchXIcon, WaypointsIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NewTopicBar } from "./new-topic-bar";
import { StateMessage } from "./state-message";
import { TopicCard } from "./topic-card";
import { useTopics } from "./use-topics";

type TopicsViewProps = {
  /** Whether the server has a Semantic Scholar key (read server-side; never the key itself). */
  hasS2Key?: boolean;
};

export function TopicsView({ hasS2Key }: TopicsViewProps) {
  const { topics, isLoading, loadError, activeCount, refresh, fixture } = useTopics();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-7 pb-24 sm:px-6">
      <PageIntro />

      <NewTopicBar hasS2Key={hasS2Key} fixture={fixture} />

      <section className="flex flex-col gap-2.5" aria-labelledby="topics-heading">
        <div className="text-muted-foreground flex items-center gap-2 px-0.5 text-[11px]">
          <h2 id="topics-heading" className="font-medium tracking-[0.06em] uppercase">
            Topics
          </h2>
          {!isLoading && !loadError ? <span className="tabular">{topics.length}</span> : null}
          {activeCount > 0 ? (
            <span className="flex items-center gap-1.5">
              <span className="bg-border h-3 w-px" aria-hidden />
              <span aria-hidden className="bg-foreground/45 size-1.5 animate-pulse rounded-full" />
              <span className="font-mono tracking-tight">{activeCount} searching</span>
            </span>
          ) : null}
        </div>

        {isLoading ? (
          <CardGridSkeleton />
        ) : loadError ? (
          <StateMessage
            icon={<SearchXIcon />}
            title="Could not load topics"
            body={loadError}
            action={
              <Button variant="outline" size="sm" onClick={() => void refresh().catch(() => undefined)}>
                Try again
              </Button>
            }
          />
        ) : topics.length === 0 ? (
          <StateMessage
            icon={<WaypointsIcon />}
            title="No topics yet"
            body="Name a field above. A Standard search reads about 40 papers and takes a few minutes."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {topics.map((topic) => (
              <li key={topic.id}>
                <TopicCard topic={topic} fixture={fixture} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PageIntro() {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">Landscape</h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        Map an ML research field into clusters, tensions, and a reading path.
      </p>
    </div>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="bg-card border-border/70 flex h-[150px] flex-col rounded-xl border shadow-sm">
          <div className="flex flex-1 flex-col gap-2.5 px-4 pt-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
          <div className="border-border/60 flex h-9 items-center border-t px-4">
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TopicsViewSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-7 pb-24 sm:px-6">
      <PageIntro />
      <Skeleton className="h-[98px] w-full rounded-xl" />
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-16" />
        <CardGridSkeleton />
      </div>
    </div>
  );
}
