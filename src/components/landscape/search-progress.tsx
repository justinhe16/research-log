"use client";

import { differenceInSeconds } from "date-fns";
import { CheckIcon, Loader2Icon, PlayIcon, SquareIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { DEPTH_LABELS, STAGE_LABELS, STAGE_PHASES } from "@/lib/landscape/constants";
import {
  RESUMABLE_SEARCH_STATUSES,
  type SearchCounters,
  type SearchProgress as SearchProgressData,
  type SearchStatus,
  type StageState,
  type StageStatus,
} from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "./animated-number";
import { formatUsd, relativeTime, SEARCH_KIND_LABELS, SEARCH_STATUS_LABELS } from "./format";
import { LABEL_CLASS } from "./metric";

type SearchProgressProps = {
  progress: SearchProgressData;
  onCancel?: () => void;
  onResume?: () => void;
  onDismiss?: () => void;
  /** Which action is in flight. */
  busy?: "cancel" | "resume" | null;
  /** Poll failure, shown quietly while the last known state stays on screen. */
  pollError?: string | null;
  className?: string;
};

type PhaseStatus = "pending" | "running" | "done" | "error";

function phaseStatus(stages: StageState[]): PhaseStatus {
  if (stages.some((s) => s.status === "error")) return "error";
  if (stages.some((s) => s.status === "running")) return "running";
  if (stages.length > 0 && stages.every((s) => s.status === "done" || s.status === "skipped")) return "done";
  if (stages.some((s) => s.status === "done")) return "running";
  return "pending";
}

function isResumable(status: SearchStatus) {
  return (RESUMABLE_SEARCH_STATUSES as readonly SearchStatus[]).includes(status);
}

const COUNTERS: { key: keyof SearchCounters; label: string; of?: keyof SearchCounters }[] = [
  { key: "candidates", label: "Candidates" },
  { key: "reranked", label: "Reranked" },
  { key: "selected", label: "Selected" },
  { key: "clusters", label: "Clusters" },
  { key: "extracted", label: "Read", of: "selected" },
  { key: "llmCalls", label: "LLM calls" },
];

/** Five-phase stepper for a queued, running, or resumable search. */
export function SearchProgress({ progress, onCancel, onResume, onDismiss, busy = null, pollError, className }: SearchProgressProps) {
  const byStage = new Map(progress.stages.map((s) => [s.stage, s]));
  const phases = STAGE_PHASES.map((phase) => {
    const stages = phase.stages.map(
      (stage) => byStage.get(stage) ?? { stage, status: "pending" as StageStatus, startedAt: null, finishedAt: null, error: null },
    );
    return { ...phase, stageStates: stages, status: phaseStatus(stages) };
  });

  const active = progress.status === "queued" || progress.status === "running";
  const resumable = isResumable(progress.status);
  const failed = progress.status === "error" || progress.status === "interrupted";
  const started = relativeTime(progress.startedAt ?? progress.createdAt);
  const pct = Math.round(progress.progress * 100);

  const headline =
    progress.status === "queued"
      ? "Waiting for a free slot"
      : progress.status === "running"
        ? progress.cancelRequested
          ? "Cancelling…"
          : progress.stage
            ? STAGE_LABELS[progress.stage]
            : "Starting"
        : progress.status === "done"
          ? "Search complete"
          : `Search ${SEARCH_STATUS_LABELS[progress.status].toLowerCase()}`;

  const counters = COUNTERS.filter((c) => typeof progress.counters[c.key] === "number");

  return (
    <section
      aria-label="Search progress"
      className={cn("bg-card border-border/70 relative overflow-hidden rounded-xl border shadow-sm", className)}
    >
      {/* Header */}
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              failed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
            )}
          >
            {active ? (
              <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
            ) : failed ? (
              <TriangleAlertIcon className="size-4" />
            ) : progress.status === "cancelled" ? (
              <SquareIcon className="size-3.5" />
            ) : (
              <CheckIcon className="size-4" />
            )}
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="text-foreground truncate text-sm font-medium tracking-tight" aria-live="polite">
              {headline}
            </p>
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-[11px]">
              <span>
                {SEARCH_KIND_LABELS[progress.kind]} · {DEPTH_LABELS[progress.depth]}
              </span>
              {started ? (
                <>
                  <span aria-hidden className="bg-border h-3 w-px" />
                  <span>started {started}</span>
                </>
              ) : null}
              {pollError ? (
                <>
                  <span aria-hidden className="bg-border h-3 w-px" />
                  <span className="text-amber-700 dark:text-amber-400">Reconnecting…</span>
                </>
              ) : null}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="flex flex-col items-end">
            <span className={LABEL_CLASS}>Cost so far</span>
            <AnimatedNumber
              value={progress.costUsd}
              format={formatUsd}
              className="font-mono text-[13px] tracking-tight tabular-nums"
            />
          </div>
          <span aria-hidden className="bg-border h-7 w-px" />
          {active && onCancel ? (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={onCancel}
              disabled={busy !== null || progress.cancelRequested}
            >
              {busy === "cancel" ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}
              Cancel
            </Button>
          ) : null}
          {resumable && onResume ? (
            <Button size="sm" className="text-xs" onClick={onResume} disabled={busy !== null}>
              {busy === "resume" ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              Resume
            </Button>
          ) : null}
          {!active && onDismiss ? (
            <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss" className="text-muted-foreground">
              <XIcon />
            </Button>
          ) : null}
        </div>
      </div>

      {progress.error && !active ? (
        <p className="text-destructive border-border/60 border-t px-4 py-2 text-xs">{progress.error}</p>
      ) : null}

      {/* Stepper */}
      <ol className="border-border/60 grid grid-cols-5 border-t">
        {phases.map((phase, i) => (
          <li key={phase.id} className={cn("min-w-0", i > 0 && "border-border/60 border-l")}>
            <HoverCard openDelay={120} closeDelay={80}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  className="hover:bg-muted/40 focus-visible:bg-muted/60 flex w-full flex-col items-start gap-1.5 px-3 py-2.5 text-left transition-colors outline-none sm:px-4"
                  aria-label={`${phase.label}: ${phase.status}`}
                >
                  <span className="flex w-full items-center gap-2">
                    <PhaseDot status={phase.status} />
                    <span
                      className={cn(
                        "hidden truncate text-xs font-medium sm:inline",
                        phase.status === "pending" ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {phase.label}
                    </span>
                  </span>
                  <PhaseBar stages={phase.stageStates} />
                </button>
              </HoverCardTrigger>
              <HoverCardContent align="start" className="w-64 p-0">
                <p className={cn(LABEL_CLASS, "border-border/60 border-b px-3 py-2")}>{phase.label}</p>
                <ul className="flex flex-col gap-0.5 p-1.5">
                  {phase.stageStates.map((s) => (
                    <li key={s.stage} className="flex items-start gap-2 rounded-md px-1.5 py-1">
                      <StageIcon status={s.status} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className={cn("text-xs", s.status === "skipped" || s.status === "pending" ? "text-muted-foreground" : "text-foreground")}>
                          {STAGE_LABELS[s.stage]}
                        </span>
                        {s.error ? <span className="text-destructive text-[11px] leading-4">{s.error}</span> : null}
                      </div>
                      <span className="text-muted-foreground font-mono text-[11px] tracking-tight tabular-nums">
                        {stageDuration(s)}
                      </span>
                    </li>
                  ))}
                </ul>
              </HoverCardContent>
            </HoverCard>
          </li>
        ))}
      </ol>

      {/* Live counters */}
      {counters.length > 0 ? (
        <dl className="border-border/60 flex flex-wrap gap-x-6 gap-y-2 border-t px-4 py-2.5">
          {counters.map((c) => {
            const denom = c.of ? progress.counters[c.of] : undefined;
            return (
              <div key={c.key} className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground text-[11px]">{c.label}</dt>
                <dd className="text-foreground font-mono text-xs tracking-tight tabular-nums">
                  <AnimatedNumber value={progress.counters[c.key] ?? 0} />
                  {typeof denom === "number" ? <span className="text-muted-foreground">/{denom.toLocaleString("en")}</span> : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}

      <Progress
        value={pct}
        aria-label={`${pct}% complete`}
        className={cn("absolute inset-x-0 bottom-0 h-0.5 rounded-none bg-transparent", !active && "opacity-0")}
      />
    </section>
  );
}

function stageDuration(s: StageState): string {
  if (s.status === "skipped") return "skipped";
  if (!s.startedAt) return "";
  const end = s.finishedAt ? new Date(s.finishedAt) : new Date();
  const secs = Math.max(0, differenceInSeconds(end, new Date(s.startedAt)));
  if (Number.isNaN(secs)) return "";
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

function PhaseDot({ status }: { status: PhaseStatus }) {
  if (status === "done") {
    return (
      <span className="bg-foreground text-background flex size-3.5 shrink-0 items-center justify-center rounded-full">
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="bg-destructive flex size-3.5 shrink-0 items-center justify-center rounded-full text-white">
        <XIcon className="size-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span className="bg-foreground/25 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none" />
        <span className="border-foreground bg-background relative size-3.5 rounded-full border-[3px]" />
      </span>
    );
  }
  return <span className="border-border size-3.5 shrink-0 rounded-full border-2" />;
}

/** One segment per stage inside a phase. */
function PhaseBar({ stages }: { stages: StageState[] }) {
  return (
    <span className="flex w-full gap-0.5" aria-hidden>
      {stages.map((s) => (
        <span
          key={s.stage}
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-500",
            s.status === "done" && "bg-foreground/70",
            s.status === "skipped" && "bg-foreground/20",
            s.status === "running" && "bg-foreground/45 animate-pulse motion-reduce:animate-none",
            s.status === "error" && "bg-destructive",
            s.status === "pending" && "bg-muted",
          )}
        />
      ))}
    </span>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  const base = "mt-0.5 size-3 shrink-0";
  if (status === "done") return <CheckIcon className={cn(base, "text-foreground")} />;
  if (status === "running") return <Loader2Icon className={cn(base, "text-foreground animate-spin")} />;
  if (status === "error") return <XIcon className={cn(base, "text-destructive")} />;
  if (status === "skipped") return <span className={cn(base, "flex items-center justify-center")}><span className="bg-muted-foreground/50 h-px w-2" /></span>;
  return <span className={cn(base, "flex items-center justify-center")}><span className="border-border size-2 rounded-full border" /></span>;
}
