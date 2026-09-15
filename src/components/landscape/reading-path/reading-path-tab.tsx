"use client";

import { useMemo } from "react";
import { BookmarkCheckIcon, BookmarkPlusIcon, CheckIcon, ListOrderedIcon, TriangleAlertIcon } from "lucide-react";

import type { ReadingPhase } from "@/lib/landscape/llm/synthesize/schemas";
import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor } from "../cluster-colors";
import { ClusterChip } from "../metric";
import { StateMessage } from "../state-message";
import { groupReadingPath, type ReadingStep as Step } from "./group";

export type ReadingPathTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

const PHASES: Record<ReadingPhase, { label: string; body: string }> = {
  foundations: { label: "Foundations", body: "The ideas the rest of the field builds on." },
  core: { label: "Core methods", body: "The techniques most current work starts from." },
  frontier: { label: "Frontier", body: "Where the open questions are being worked on now." },
};


export function ReadingPathTab({ snapshot, onOpenPaper }: ReadingPathTabProps) {
  const doc = snapshot.documents.readingPath;
  const failed = snapshot.failedDocuments.includes("reading_path");

  const groups = useMemo(() => groupReadingPath(doc, snapshot.papers), [doc, snapshot.papers]);

  const steps = groups.flatMap((g) => g.steps);

  if (!doc || steps.length === 0) {
    return failed ? (
      <StateMessage
        icon={<TriangleAlertIcon />}
        title="The reading path could not be written"
        body="Synthesis failed for this part of the landscape. Retry synthesis above; papers and clusters are unaffected."
      />
    ) : (
      <StateMessage
        icon={<ListOrderedIcon />}
        title="No reading path for this search"
        body="Start from the top of the Papers tab instead: it is ordered by relevance to the topic."
      />
    );
  }

  const logged = steps.filter((s) => s.paper.loggedEntryId).length;
  const next = steps.find((s) => !s.paper.loggedEntryId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-foreground/90 text-sm">
            A route through <span className="tabular font-medium">{steps.length}</span> papers, from foundations to the frontier.
          </p>
          <p className="text-muted-foreground tabular text-xs">
            {logged === steps.length ? (
              "Every paper here is in your log"
            ) : (
              <>
                <span className="text-foreground font-medium">{logged}</span> of {steps.length} already in your log
              </>
            )}
          </p>
        </div>
        <ProgressSegments steps={steps} />
        {next && logged > 0 ? (
          <button
            type="button"
            onClick={() => onOpenPaper(next.paper.id)}
            className="text-muted-foreground hover:text-foreground focus-visible:text-foreground self-start rounded text-left text-xs underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            Pick up at step {next.n}: <span className="text-foreground/90">{next.paper.title}</span>
          </button>
        ) : null}
      </header>

      <ol className="flex flex-col" aria-label="Reading path">
        {groups.map((group, gi) => (
          <li key={group.phase} className="flex flex-col">
            <PhaseHeader phase={group.phase} steps={group.steps} first={gi === 0} />
            <ol className="flex flex-col">
              {group.steps.map((step) => (
                <StepRow
                  key={step.paper.id}
                  step={step}
                  last={gi === groups.length - 1 && step === group.steps[group.steps.length - 1]}
                  color={clusterColor(snapshot.clusters, step.paper.clusterIdx)}
                  clusterLabel={snapshot.clusters.find((c) => c.idx === step.paper.clusterIdx)?.label ?? null}
                  onOpen={() => onOpenPaper(step.paper.id)}
                />
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProgressSegments({ steps }: { steps: Step[] }) {
  return (
    <div className="flex gap-1" role="presentation">
      {steps.map((s, i) => {
        const phaseStart = i > 0 && steps[i - 1].phase !== s.phase;
        return (
          <span
            key={s.paper.id}
            title={`Step ${s.n}: ${s.paper.title}${s.paper.loggedEntryId ? " (in your log)" : ""}`}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              s.paper.loggedEntryId ? "bg-foreground/70" : "bg-muted",
              phaseStart && "ml-2",
            )}
          />
        );
      })}
    </div>
  );
}

/** The rail column: fixed width so number circles and connectors line up. */
const RAIL = "relative flex w-8 shrink-0 justify-center";

function PhaseHeader({ phase, steps, first }: { phase: ReadingPhase; steps: Step[]; first: boolean }) {
  const logged = steps.filter((s) => s.paper.loggedEntryId).length;
  return (
    <div className="flex gap-4">
      <div className={RAIL} aria-hidden>
        {!first ? <span className="border-border absolute top-0 h-7 border-l border-dashed" /> : null}
        <span className="border-border absolute top-7 bottom-0 border-l" />
        <span className="bg-background border-foreground/40 relative mt-7 size-2.5 rotate-45 border" />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pt-5.5 pb-2">
        <h3 className="text-[15px] font-medium tracking-tight">{PHASES[phase].label}</h3>
        <p className="text-muted-foreground tabular text-[11px]">
          {steps.length} {steps.length === 1 ? "paper" : "papers"}
          {logged > 0 ? `, ${logged} logged` : ""}
        </p>
        <p className="text-muted-foreground basis-full text-xs">{PHASES[phase].body}</p>
      </div>
    </div>
  );
}

function StepRow({
  step,
  last,
  color,
  clusterLabel,
  onOpen,
}: {
  step: Step;
  last: boolean;
  color: string | null;
  clusterLabel: string | null;
  onOpen: () => void;
}) {
  const { paper } = step;
  const isLogged = paper.loggedEntryId !== null;
  return (
    <li className="group/step flex gap-4">
      <div className={RAIL} aria-hidden>
        <span className={cn("border-border absolute top-0 border-l", last ? "h-5" : "bottom-0")} />
        <span
          className={cn(
            "tabular relative mt-2.5 flex size-7 items-center justify-center rounded-full border text-[12px] font-medium transition-colors",
            isLogged
              ? "bg-foreground text-background border-foreground"
              : "bg-card text-foreground/80 border-border group-hover/step:border-foreground/40",
          )}
        >
          {step.n}
          {isLogged ? (
            <span className="bg-background text-foreground border-border absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full border">
              <CheckIcon className="size-2.5" strokeWidth={3} />
            </span>
          ) : null}
        </span>
      </div>

      <button
        type="button"
        onClick={onOpen}
        aria-label={`Step ${step.n}: ${paper.title}${isLogged ? ", in your log" : ""}`}
        className="hover:bg-muted/45 focus-visible:bg-muted/55 focus-visible:ring-ring/50 -mx-1 mb-1 flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-[3px] sm:flex-row sm:items-start sm:gap-4"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-foreground text-[14px] leading-5 font-medium text-pretty">{paper.title}</span>
          <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            {paper.year ? <span className="tabular">{paper.year}</span> : null}
            {paper.venue ? (
              <>
                {paper.year ? <span className="bg-border h-3 w-px" /> : null}
                <span className="max-w-[16rem] truncate">{paper.venue}</span>
              </>
            ) : null}
            {clusterLabel ? (
              <>
                {paper.year || paper.venue ? <span className="bg-border h-3 w-px" /> : null}
                <ClusterChip color={color} label={clusterLabel} className="text-[11px]" />
              </>
            ) : null}
          </span>
          <span className="text-foreground/75 text-[13px] leading-5 text-pretty">{step.reason}</span>
        </span>

        <span
          className={cn(
            "-ml-2.5 inline-flex h-7 shrink-0 items-center gap-1.5 self-start rounded-md border border-transparent px-2.5 text-xs sm:ml-0 whitespace-nowrap transition-colors",
            isLogged
              ? "text-muted-foreground"
              : "text-muted-foreground group-hover/step:border-border group-hover/step:bg-card group-hover/step:text-foreground",
          )}
        >
          {isLogged ? <BookmarkCheckIcon className="size-3.5" /> : <BookmarkPlusIcon className="size-3.5" />}
          {isLogged ? "In your log" : "Open to log"}
        </span>
      </button>
    </li>
  );
}
