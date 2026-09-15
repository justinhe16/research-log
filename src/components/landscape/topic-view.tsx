"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FileQuestionIcon, Loader2Icon, RotateCwIcon, SearchXIcon, TriangleAlertIcon, WaypointsIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { landscapeApi } from "@/lib/landscape/api-client";
import { DEPTH_LABELS } from "@/lib/landscape/constants";
import {
  RESUMABLE_SEARCH_STATUSES,
  type DocumentKind,
  type LandscapeSnapshot,
  type SearchProgress as SearchProgressData,
  type SearchStatus,
  type StartSearchInput,
} from "@/lib/landscape/types";
import { withFixture } from "./fixture-mode";
import { errorMessage } from "./format";
import { MapTab } from "./map/map-tab";
import { OverviewTab } from "./overview/overview-tab";
import { PaperSheet } from "./paper-sheet";
import { PapersTab } from "./papers/papers-tab";
import { ReadingPathTab } from "./reading-path/reading-path-tab";
import { SearchProgress } from "./search-progress";
import { StateMessage } from "./state-message";
import { TimelineTab } from "./timeline/timeline-tab";
import { TopicHeader } from "./topic-header";
import { isActiveStatus, useSearchProgress } from "./use-search-progress";
import { useSnapshot } from "./use-snapshot";
import { useTopic } from "./use-topic";

export const TOPIC_TABS = [
  { id: "overview", label: "Overview" },
  { id: "map", label: "Map" },
  { id: "timeline", label: "Timeline" },
  { id: "reading-path", label: "Reading path" },
  { id: "papers", label: "Papers" },
] as const;
export type TopicTab = (typeof TOPIC_TABS)[number]["id"];
const DEFAULT_TAB: TopicTab = "overview";

const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  clusters: "cluster summaries",
  tensions: "tensions",
  gaps: "gaps",
  narrative: "eras and game-changers",
  reading_path: "reading path",
  diff: "what changed",
};

function isTab(value: string | null): value is TopicTab {
  return TOPIC_TABS.some((t) => t.id === value);
}

type TopicViewProps = {
  topicId: string;
  /** Whether the server has a Semantic Scholar key. Unknown until C2 exposes it. */
  hasS2Key?: boolean;
};

export function TopicView({ topicId, hasS2Key }: TopicViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { topic, isLoading, loadError, notFound, refresh, fixture } = useTopic(topicId);

  const tabParam = searchParams.get("tab");
  const tab: TopicTab = isTab(tabParam) ? tabParam : DEFAULT_TAB;
  const searchParam = searchParams.get("search");

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // --- which search to show -------------------------------------------------
  const latestDoneId = topic?.lastSearch?.id ?? topic?.searches.find((s) => s.status === "done")?.id ?? null;
  const selectedSearchId = useMemo(() => {
    if (!topic) return null;
    const requested = searchParam ? topic.searches.find((s) => s.id === searchParam && s.status === "done") : null;
    return requested?.id ?? latestDoneId;
  }, [topic, searchParam, latestDoneId]);

  // --- live / resumable search ---------------------------------------------
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const latest = topic?.searches[0] ?? null;
  const resumableLatest =
    latest && (RESUMABLE_SEARCH_STATUSES as readonly SearchStatus[]).includes(latest.status) && latest.id !== dismissedId
      ? latest
      : null;
  const trackedSearchId = topic?.activeSearch?.id ?? resumableLatest?.id ?? null;

  const handleSettled = useCallback(
    (p: SearchProgressData) => {
      void refresh().catch(() => undefined);
      if (p.status === "done") {
        toast.success("Landscape updated", { description: `${p.paperCount} papers` });
        setParams({ search: null });
      }
    },
    [refresh, setParams],
  );
  const { progress, error: pollError, update: updateProgress } = useSearchProgress(trackedSearchId, handleSettled);
  const searchActive = progress ? isActiveStatus(progress.status) : topic?.activeSearch !== null && topic !== null;

  const [busy, setBusy] = useState<"cancel" | "resume" | "start" | "retry" | null>(null);

  const startSearch = useCallback(
    async (input: StartSearchInput) => {
      setBusy("start");
      try {
        if (fixture) {
          toast.message("Fixture mode: searches are not started.", {
            description: input.mode === "refresh" ? "Refresh" : `Full re-run at ${DEPTH_LABELS[input.depth ?? "standard"]}`,
          });
          return;
        }
        const search = await landscapeApi.startSearch(topicId, input);
        updateProgress(search);
        await refresh();
      } catch (err) {
        toast.error(errorMessage(err, "Could not start a search."));
      } finally {
        setBusy(null);
      }
    },
    [fixture, refresh, topicId, updateProgress],
  );

  const cancelSearch = useCallback(async () => {
    if (!progress) return;
    setBusy("cancel");
    try {
      if (fixture) {
        toast.message("Fixture mode: nothing to cancel.");
        return;
      }
      updateProgress(await landscapeApi.cancelSearch(progress.id));
    } catch (err) {
      toast.error(errorMessage(err, "Could not cancel the search."));
    } finally {
      setBusy(null);
    }
  }, [fixture, progress, updateProgress]);

  const resumeSearch = useCallback(async () => {
    if (!progress) return;
    setBusy("resume");
    try {
      if (fixture) {
        toast.message("Fixture mode: nothing to resume.");
        return;
      }
      updateProgress(await landscapeApi.resumeSearch(progress.id));
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, "Could not resume the search."));
    } finally {
      setBusy(null);
    }
  }, [fixture, progress, refresh, updateProgress]);

  // --- snapshot ---------------------------------------------------------------
  const { snapshot: rawSnapshot, error: snapshotError, isLoading: snapshotLoading, reload } = useSnapshot(selectedSearchId);

  // Papers logged from the sheet during this visit, applied on top of the snapshot.
  const [loggedOverrides, setLoggedOverrides] = useState<Record<string, string>>({});
  const snapshot = useMemo<LandscapeSnapshot | null>(() => {
    if (!rawSnapshot) return null;
    if (Object.keys(loggedOverrides).length === 0) return rawSnapshot;
    return {
      ...rawSnapshot,
      papers: rawSnapshot.papers.map((p) =>
        loggedOverrides[p.id] && !p.loggedEntryId ? { ...p, loggedEntryId: loggedOverrides[p.id] } : p,
      ),
    };
  }, [rawSnapshot, loggedOverrides]);

  const retryDocuments = useCallback(async () => {
    if (!snapshot) return;
    setBusy("retry");
    try {
      if (fixture) {
        toast.message("Fixture mode: synthesis is not retried.");
        return;
      }
      const search = await landscapeApi.retryDocuments(snapshot.search.id);
      updateProgress(search);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, "Could not retry synthesis."));
    } finally {
      setBusy(null);
    }
  }, [fixture, refresh, snapshot, updateProgress]);

  // --- paper sheet --------------------------------------------------------------
  const [openPaperId, setOpenPaperId] = useState<string | null>(null);
  const openPaper = useMemo(
    () => (openPaperId && snapshot ? (snapshot.papers.find((p) => p.id === openPaperId) ?? null) : null),
    [openPaperId, snapshot],
  );
  const handleOpenPaper = useCallback((id: string) => setOpenPaperId(id), []);
  const newPaperIds = useMemo(() => new Set(snapshot?.documents.diff?.newPaperIds ?? []), [snapshot]);

  // --- render -------------------------------------------------------------------
  if (isLoading) return <TopicViewSkeleton />;

  if (!topic) {
    return (
      <Shell>
        <StateMessage
          icon={notFound ? <FileQuestionIcon /> : <SearchXIcon />}
          title={notFound ? "Topic not found" : "Could not load this topic"}
          body={notFound ? "It may have been deleted." : loadError}
          action={
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={withFixture("/landscape", fixture)}>All topics</Link>
              </Button>
              {!notFound ? (
                <Button size="sm" onClick={() => void refresh().catch(() => undefined)}>
                  Try again
                </Button>
              ) : null}
            </>
          }
        />
      </Shell>
    );
  }

  const showProgress = progress !== null && (isActiveStatus(progress.status) || progress.id === resumableLatest?.id);

  return (
    <Shell>
      <TopicHeader
        topic={topic}
        selectedSearchId={selectedSearchId}
        onSelectSearch={(id) => setParams({ search: id === latestDoneId ? null : id })}
        onStartSearch={(input) => void startSearch(input)}
        searchActive={searchActive}
        starting={busy === "start"}
        hasS2Key={hasS2Key}
        fixture={fixture}
      />

      {showProgress && progress ? (
        <SearchProgress
          progress={progress}
          pollError={pollError}
          busy={busy === "cancel" || busy === "resume" ? busy : null}
          onCancel={() => void cancelSearch()}
          onResume={() => void resumeSearch()}
          onDismiss={isActiveStatus(progress.status) ? undefined : () => setDismissedId(progress.id)}
        />
      ) : trackedSearchId && !progress && !pollError ? (
        <Skeleton className="h-[132px] w-full rounded-xl" />
      ) : null}

      {!selectedSearchId ? (
        searchActive ? (
          <StateMessage
            icon={<Loader2Icon className="animate-spin motion-reduce:animate-none" />}
            title="Building your first landscape"
            body="Clusters, the map and the reading path appear here when the search finishes. You can leave this page; it keeps running."
          />
        ) : (
          <StateMessage
            icon={<WaypointsIcon />}
            title="No landscape yet"
            body={
              resumableLatest
                ? "The last search did not finish. Resume it above, or start over."
                : `Run a ${DEPTH_LABELS[topic.defaultDepth]} search to collect, read and map this field.`
            }
            action={
              <Button size="sm" disabled={busy === "start"} onClick={() => void startSearch({ mode: "full", depth: topic.defaultDepth })}>
                {busy === "start" ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : null}
                {resumableLatest ? "Start over" : "Run search"}
              </Button>
            }
          />
        )
      ) : snapshotError ? (
        <StateMessage
          icon={<SearchXIcon />}
          title="Could not load this landscape"
          body={snapshotError}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          }
        />
      ) : snapshotLoading || !snapshot ? (
        <TabsSkeleton />
      ) : (
        <>
          {snapshot.failedDocuments.length > 0 ? (
            <Alert className="border-border/70 rounded-xl px-4 py-3">
              <TriangleAlertIcon className="text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-sm">Part of this landscape is missing</AlertTitle>
              <AlertDescription className="text-xs">
                Synthesis failed for {snapshot.failedDocuments.map((k) => DOCUMENT_LABELS[k]).join(", ")}. Papers and
                clusters are complete.
              </AlertDescription>
              <div className="col-start-2 mt-1.5">
                <Button size="sm" variant="outline" className="text-xs" disabled={busy === "retry" || searchActive} onClick={() => void retryDocuments()}>
                  {busy === "retry" ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
                  Retry synthesis
                </Button>
              </div>
            </Alert>
          ) : null}

          <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === DEFAULT_TAB ? null : v })} className="gap-4">
            <div className="border-border/60 overflow-x-auto border-b">
              <TabsList variant="line" className="h-10 gap-4 p-0">
                {TOPIC_TABS.map((t) => (
                  <TabsTrigger key={t.id} value={t.id} className="flex-none px-0 text-[13px]">
                    {t.label}
                    {t.id === "papers" ? (
                      <span className="text-muted-foreground font-mono text-[11px] tabular-nums">{snapshot.papers.length}</span>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="overview">
              <OverviewTab snapshot={snapshot} onOpenPaper={handleOpenPaper} />
            </TabsContent>
            <TabsContent value="map">
              <MapTab snapshot={snapshot} onOpenPaper={handleOpenPaper} />
            </TabsContent>
            <TabsContent value="timeline">
              <TimelineTab snapshot={snapshot} onOpenPaper={handleOpenPaper} />
            </TabsContent>
            <TabsContent value="reading-path">
              <ReadingPathTab snapshot={snapshot} onOpenPaper={handleOpenPaper} />
            </TabsContent>
            <TabsContent value="papers">
              <PapersTab snapshot={snapshot} onOpenPaper={handleOpenPaper} />
            </TabsContent>
          </Tabs>

          <PaperSheet
            paper={openPaper}
            searchId={snapshot.search.id}
            topicName={topic.name}
            clusters={snapshot.clusters}
            isNew={openPaper ? newPaperIds.has(openPaper.id) : false}
            onOpenChange={(open) => {
              if (!open) setOpenPaperId(null);
            }}
            onOpenPaper={handleOpenPaper}
            onLogged={(paperId, entryId) => setLoggedOverrides((m) => ({ ...m, [paperId]: entryId }))}
          />
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-5 pb-24 sm:px-6">{children}</div>;
}

function TabsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="border-border/60 flex h-10 items-center gap-5 border-b">
        {[64, 36, 60, 88, 52].map((w, i) => (
          <Skeleton key={i} className="h-3.5" style={{ width: w }} />
        ))}
      </div>
      <Skeleton className="h-[320px] w-full rounded-xl" />
    </div>
  );
}

export function TopicViewSkeleton() {
  return (
    <Shell>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-6 w-[min(28rem,80%)]" />
        <Skeleton className="h-4 w-[min(36rem,90%)]" />
        <div className="flex flex-col gap-2 pt-1">
          <Skeleton className="h-3.5 w-full max-w-[72ch]" />
          <Skeleton className="h-3.5 w-4/5 max-w-[60ch]" />
        </div>
      </div>
      <TabsSkeleton />
    </Shell>
  );
}
