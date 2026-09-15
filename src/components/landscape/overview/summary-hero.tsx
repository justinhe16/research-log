"use client";

import { format } from "date-fns";
import { HistoryIcon } from "lucide-react";

import type { ClusterChange, LandscapeSnapshot } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor, colorSlotVar } from "../cluster-colors";
import { formatCount, relativeTime } from "../format";
import { useNow } from "../use-now";
import { CARD_CLASS, PaperChip, PaperChips, resolvePapers, type PaperLookup } from "./primitives";

// ---------------------------------------------------------------------------
// At a glance
// ---------------------------------------------------------------------------

export function SummaryHero({ snapshot }: { snapshot: LandscapeSnapshot }) {
  const { papers, clusters, documents, topic, search } = snapshot;
  const years = papers.map((p) => p.year).filter((y): y is number => y !== null);
  const span = years.length ? (Math.min(...years) === Math.max(...years) ? `${years[0]}` : `${Math.min(...years)}–${Math.max(...years)}`) : "—";
  const now = useNow();
  const last = relativeTime(search.finishedAt ?? search.createdAt, now);
  const logged = papers.filter((p) => p.loggedEntryId).length;
  const synthSummary = documents.clusters?.topicSummary?.trim() || null;
  // The header already shows the topic summary; only repeat it here when this search says something different.
  const summary = synthSummary && synthSummary !== topic.summary?.trim() ? synthSummary : null;
  const eras = documents.narrative?.eras ?? [];
  const totalSize = clusters.reduce((n, c) => n + c.size, 0);

  const stats: { label: string; value: string; hint?: string }[] = [
    { label: "Papers", value: formatCount(papers.length), hint: logged ? `${logged} in your log` : undefined },
    { label: "Clusters", value: formatCount(clusters.length) },
    { label: "Published", value: span },
    { label: "Searched", value: last ?? "—", hint: search.finishedAt ? format(new Date(search.finishedAt), "MMM d, yyyy") : undefined },
  ];

  return (
    <div className={cn(CARD_CLASS, "flex flex-col")}>
      <div className="flex flex-col gap-4 px-4 pt-4 pb-4 sm:px-5">
        {eras.length > 1 ? <FieldArc eras={eras} /> : null}
        {summary ? <p className="text-foreground/85 max-w-[72ch] text-sm leading-6">{summary}</p> : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-muted-foreground text-[11px]">{s.label}</dt>
              <dd className="text-foreground tabular truncate text-lg leading-6 font-medium tracking-tight">{s.value}</dd>
              {s.hint ? <dd className="text-muted-foreground truncate text-[11px] leading-4">{s.hint}</dd> : null}
            </div>
          ))}
        </dl>
      </div>

      {clusters.length > 0 && totalSize > 0 ? (
        <div className="border-border/60 flex flex-col gap-2.5 border-t px-4 py-3 sm:px-5">
          <div
            className="flex h-2 w-full gap-1 overflow-hidden rounded-full"
            role="img"
            aria-label={`Papers per cluster: ${clusters.map((c) => `${c.label} ${c.size}`).join(", ")}`}
          >
            {clusters.map((c) => (
              <span key={c.idx} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: c.size, background: colorSlotVar(c.color) }} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {clusters.map((c) => (
              <li key={c.idx} className="min-w-0">
                <a
                  href={`#overview-cluster-${c.idx}`}
                  className="text-muted-foreground hover:text-foreground focus-visible:text-foreground inline-flex max-w-full items-center gap-1.5 rounded-sm text-xs transition-colors outline-none focus-visible:underline"
                >
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: colorSlotVar(c.color) }} />
                  <span className="truncate">{c.label}</span>
                  <span className="text-muted-foreground/70 font-mono text-[11px] tracking-tight tabular-nums">{c.size}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** One line reading the eras as a story: "Built on A, then B and C. Now: D." */
function FieldArc({ eras }: { eras: NonNullable<LandscapeSnapshot["documents"]["narrative"]>["eras"] }) {
  const past = eras.slice(0, -1);
  const now = eras[eras.length - 1];
  return (
    <p className="text-foreground max-w-[64ch] text-[17px] leading-7 font-medium tracking-tight text-balance">
      <span className="text-muted-foreground font-normal">Built on </span>
      {past.map((era, i) => (
        <span key={`${i}-${era.label}`}>
          {i > 0 ? <span className="text-muted-foreground font-normal">{i === past.length - 1 ? ", then " : ", "}</span> : null}
          {lowerFirst(era.label)}
        </span>
      ))}
      <span className="text-muted-foreground font-normal">. Now </span>
      {lowerFirst(now.label).replace(/[.?!]$/, "")}
      <span className="text-muted-foreground font-normal">{/\?$/.test(now.label) ? "?" : "."}</span>
    </p>
  );
}

function lowerFirst(s: string): string {
  // Keep acronyms ("SAE", "RLHF") and proper nouns with an inner capital intact.
  const first = s.split(/\s/)[0] ?? "";
  if (first.length > 1 && (first === first.toUpperCase() || /[A-Z]/.test(first.slice(1)))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

const CHANGE_LABELS: Record<ClusterChange, string> = {
  new: "New",
  gone: "Gone",
  grew: "Grew",
  shrank: "Shrank",
  split: "Split",
  merged: "Merged",
  stable: "Stable",
};

export function changeTone(change: ClusterChange): string {
  switch (change) {
    case "new":
    case "grew":
      return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400";
    case "gone":
    case "shrank":
      return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
    case "split":
    case "merged":
      return "bg-sky-500/12 text-sky-700 dark:text-sky-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function ChangeBadge({ change, className }: { change: ClusterChange; className?: string }) {
  return (
    <span className={cn("inline-flex h-4.5 shrink-0 items-center rounded px-1.5 text-[10px] font-medium", changeTone(change), className)}>
      {CHANGE_LABELS[change]}
    </span>
  );
}

export function WhatChanged({ snapshot, lookup }: { snapshot: LandscapeSnapshot; lookup: PaperLookup }) {
  const diff = snapshot.documents.diff;
  const prose = snapshot.documents.narrative?.whatChanged?.trim() || null;
  if (!diff && !prose) return null;

  const since = diff?.since ?? snapshot.search.since;
  const sinceDate = since ? parseDay(since) : null;
  const sinceLabel = sinceDate ? format(sinceDate, "MMM d, yyyy") : null;
  const newPapers = diff ? resolvePapers(diff.newPaperIds, lookup.byId) : [];
  const rising = (diff?.rising ?? [])
    .map((r) => ({ ...r, paper: lookup.byId.get(r.paperId) }))
    .filter((r) => r.paper && r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 4);
  const changes = (diff?.clusterChanges ?? []).filter((c) => c.change !== "stable");
  const dropped = diff?.droppedPaperIds.length ?? 0;

  const columns = [newPapers.length > 0, rising.length > 0, changes.length > 0].filter(Boolean).length;

  return (
    <section
      aria-labelledby="overview-what-changed"
      className="flex flex-col gap-3 rounded-xl border border-emerald-600/15 bg-emerald-500/[0.045] px-4 py-3.5 sm:px-5 dark:border-emerald-400/15 dark:bg-emerald-400/[0.05]"
    >
      <div className="flex flex-col gap-1">
        <h2 id="overview-what-changed" className="flex items-center gap-2 text-[13px] font-semibold">
          <HistoryIcon className="size-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden />
          What changed{sinceLabel ? <span className="text-muted-foreground font-normal">since {sinceLabel}</span> : null}
        </h2>
        {prose ? <p className="text-foreground/85 max-w-[72ch] text-sm leading-6">{prose}</p> : null}
      </div>

      {columns > 0 ? (
        <div className={cn("grid grid-cols-1 gap-x-6 gap-y-3", columns >= 2 && "md:grid-cols-2", columns >= 3 && "lg:grid-cols-3")}>
          {newPapers.length > 0 ? (
            <DiffColumn title="New papers" count={newPapers.length} hint={dropped ? `${dropped} dropped` : undefined}>
              <PaperChips ids={newPapers.map((p) => p.id)} lookup={lookup} limit={6} />
            </DiffColumn>
          ) : null}
          {rising.length > 0 ? (
            <DiffColumn title="Rising citations">
              <ul className="flex min-w-0 flex-col gap-1.5">
                {rising.map((r) => (
                  <li key={r.paperId} className="flex min-w-0 items-center gap-2">
                    <PaperChip paper={r.paper!} clusters={lookup.clusters} onOpenPaper={lookup.onOpenPaper} className="min-w-0 shrink" />
                    <span
                      className="shrink-0 font-mono text-[11px] tracking-tight text-emerald-700 tabular-nums dark:text-emerald-400"
                      title={`${formatCount(r.citationsBefore)} → ${formatCount(r.citationsAfter)} citations`}
                    >
                      +{formatCount(r.delta)}
                    </span>
                  </li>
                ))}
              </ul>
            </DiffColumn>
          ) : null}
          {changes.length > 0 ? (
            <DiffColumn title="Clusters">
              <ul className="flex min-w-0 flex-col gap-1.5">
                {changes.map((c, i) => (
                  <li key={`${c.idx ?? "gone"}-${i}`} className="flex min-w-0 items-center gap-2 text-xs">
                    <ChangeBadge change={c.change} />
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: (c.idx !== null ? clusterColor(lookup.clusters, c.idx) : null) ?? "var(--muted-foreground)" }}
                    />
                    <span className={cn("min-w-0 truncate", c.change === "gone" ? "text-muted-foreground line-through" : "text-foreground/85")}>
                      {c.label}
                    </span>
                    <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px] tracking-tight tabular-nums">
                      {c.change === "new" ? c.sizeAfter : c.change === "gone" ? c.sizeBefore : `${c.sizeBefore}→${c.sizeAfter}`}
                    </span>
                  </li>
                ))}
              </ul>
            </DiffColumn>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** "YYYY-MM-DD" as a local date (new Date() would read it as UTC midnight and shift the day). */
function parseDay(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function DiffColumn({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-muted-foreground flex items-baseline gap-1.5 text-[11px]">
        <span className="text-foreground/80 font-medium">{title}</span>
        {count !== undefined ? <span className="font-mono tracking-tight tabular-nums">{count}</span> : null}
        {hint ? <span>· {hint}</span> : null}
      </h3>
      {children}
    </div>
  );
}
