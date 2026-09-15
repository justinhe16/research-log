"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, WaypointsIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { landscapeApi, similarTopicsFrom } from "@/lib/landscape/api-client";
import { TOPIC_DESCRIPTION_MAX, TOPIC_NAME_MAX } from "@/lib/landscape/constants";
import type { Depth, SimilarTopic } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { DepthPicker } from "./depth-picker";
import { withFixture, type FixtureMode } from "./fixture-mode";
import { errorMessage } from "./format";
import { SimilarTopicAlert } from "./similar-topic-alert";
import { activeSearchIdFrom } from "./use-search-progress";

type NewTopicBarProps = {
  /** Whether the server has a Semantic Scholar key (read server-side). */
  hasS2Key?: boolean;
  fixture?: FixtureMode | null;
  /** Called after a topic is created or a refresh starts, before navigating. */
  onStarted?: () => void;
};

type Busy = { kind: "refresh"; topicId: string } | { kind: "create" } | null;

/** Same key as the server's exact-duplicate check (`normalizeTopicName`). */
function sameName(a: string, b: string): boolean {
  const norm = (x: string) => x.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export function NewTopicBar({ hasS2Key, fixture = null, onStarted }: NewTopicBarProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const [descFocused, setDescFocused] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [similar, setSimilar] = useState<SimilarTopic[] | null>(null);
  /** The 409 was an exact-name duplicate, which `force` cannot override. */
  const [exactDuplicate, setExactDuplicate] = useState(false);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && busy === null;
  const expanded = name !== "" || description !== "" || descFocused;

  function goTo(topicId: string) {
    onStarted?.();
    router.push(withFixture(`/landscape/${encodeURIComponent(topicId)}`, fixture));
  }

  async function create(force: boolean) {
    setBusy({ kind: "create" });
    try {
      if (fixture) {
        // No API in fixture mode: exercise the dedupe flow instead.
        const { fixtureTopics } = await import("./dev-fixtures");
        const [first] = fixtureTopics("done");
        if (!force) {
          setSimilar([{ ...first, similarity: 0.86 }]);
          setExactDuplicate(false);
          return;
        }
        toast.success("Fixture mode: pretending to start the search.");
        goTo(first.id);
        return;
      }
      const { topic } = await landscapeApi.createTopic({
        name: trimmed,
        description: description.trim() || undefined,
        depth,
        force,
      });
      toast.success("Search started", { description: topic.name });
      setSimilar(null);
      goTo(topic.id);
    } catch (err) {
      const conflicts = similarTopicsFrom(err);
      if (conflicts && conflicts.length > 0) {
        // Exact duplicates are refused even with force; put that topic first.
        const exact = conflicts.filter((c) => sameName(c.name, trimmed));
        setSimilar([...exact, ...conflicts.filter((c) => !exact.includes(c))]);
        // With force the server only refuses exact duplicates.
        setExactDuplicate(force || exact.length > 0);
      } else {
        toast.error(errorMessage(err, "Could not create that topic."));
      }
    } finally {
      setBusy(null);
    }
  }

  async function refreshExisting(topic: SimilarTopic) {
    setBusy({ kind: "refresh", topicId: topic.id });
    try {
      if (!fixture) await landscapeApi.startSearch(topic.id, { mode: "refresh" });
      toast.success("Refresh started", { description: topic.name });
      goTo(topic.id);
    } catch (err) {
      if (activeSearchIdFrom(err)) {
        // Already searching: open the topic, which shows the running search's progress.
        toast.message("A search is already running", { description: topic.name });
        goTo(topic.id);
        return;
      }
      toast.error(errorMessage(err, "Could not start a refresh."));
    } finally {
      setBusy(null);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSimilar(null);
    void create(false);
  }

  return (
    <div className="flex flex-col gap-2.5">
      <form onSubmit={handleSubmit}>
        <div
          className={cn(
            "bg-card border-border/70 rounded-xl border shadow-sm transition-all duration-150",
            "focus-within:border-ring/50 focus-within:ring-ring/20 focus-within:ring-[3px]",
          )}
        >
          <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:pl-3">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <WaypointsIcon className="text-muted-foreground/70 size-4 shrink-0" aria-hidden />
              <Label htmlFor="new-topic-name" className="sr-only">
                Research field
              </Label>
              <Input
                id="new-topic-name"
                autoComplete="off"
                maxLength={TOPIC_NAME_MAX}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (similar) setSimilar(null);
                }}
                placeholder="Name a research field, e.g. sparse autoencoders for interpretability"
                className="h-9 rounded-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 sm:text-sm dark:bg-transparent"
              />
            </div>
            <Button type="submit" size="sm" disabled={!canSubmit} className="h-8 shrink-0 px-3.5 text-xs">
              {busy?.kind === "create" ? <Loader2Icon className="animate-spin" /> : null}
              Map this field
            </Button>
          </div>

          <div
            className={cn(
              "grid transition-all duration-150",
              expanded ? "border-border/60 grid-rows-[1fr] border-t opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="overflow-hidden">
              <Textarea
                value={description}
                maxLength={TOPIC_DESCRIPTION_MAX}
                onChange={(e) => setDescription(e.target.value)}
                onFocus={() => setDescFocused(true)}
                onBlur={() => setDescFocused(false)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSubmit(e);
                }}
                placeholder="Scope it (optional): what to include, what to leave out"
                rows={2}
                aria-label="Description"
                tabIndex={expanded ? undefined : -1}
                className="min-h-14 resize-none rounded-none border-0 bg-transparent px-3.5 py-2.5 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
              />
            </div>
          </div>

          <div className="border-border/60 bg-muted/20 rounded-b-xl border-t px-2 py-2 sm:px-3">
            <DepthPicker value={depth} onChange={setDepth} hasS2Key={hasS2Key} disabled={busy !== null} />
          </div>
        </div>
      </form>

      {similar && similar.length > 0 ? (
        <SimilarTopicAlert
          name={trimmed}
          similar={similar}
          exactMatch={exactDuplicate}
          busy={busy}
          fixture={fixture}
          onRefresh={(t) => void refreshExisting(t)}
          onCreateAnyway={() => void create(true)}
          onDismiss={() => setSimilar(null)}
        />
      ) : null}
    </div>
  );
}
