"use client";

import { EyeIcon, EyeOffIcon, SparklesIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type LegendCluster = { idx: number; label: string; color: string; count: number };

export function ClusterLegend({
  clusters,
  hidden,
  onFocus,
  onToggle,
  onShowAll,
}: {
  clusters: LegendCluster[];
  hidden: ReadonlySet<number>;
  onFocus: (idx: number) => void;
  onToggle: (idx: number) => void;
  onShowAll: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {clusters.length > 0 ? (
        <div className="flex flex-col">
          <div className="flex h-6 items-center justify-between px-1">
            <span className="text-muted-foreground text-[11px] font-medium">Clusters</span>
            {hidden.size > 0 ? (
              <button
                type="button"
                onClick={onShowAll}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded text-[11px] outline-none focus-visible:ring-2"
              >
                Show all
              </button>
            ) : null}
          </div>
          <ul className="flex flex-col">
            {clusters.map((c) => {
              const isHidden = hidden.has(c.idx);
              return (
                <li key={c.idx} className="group/legend flex items-center rounded-md">
                  <button
                    type="button"
                    disabled={isHidden}
                    onClick={() => onFocus(c.idx)}
                    title={isHidden ? undefined : `Zoom to ${c.label}`}
                    className="hover:bg-muted/70 focus-visible:ring-ring/50 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-2 disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full transition-colors"
                      style={
                        isHidden
                          ? { boxShadow: `inset 0 0 0 1.5px ${c.color}` }
                          : { background: `color-mix(in oklab, ${c.color} 22%, var(--card))`, boxShadow: `inset 0 0 0 1.5px ${c.color}` }
                      }
                    />
                    <span className={cn("min-w-0 flex-1 truncate text-xs", isHidden ? "text-muted-foreground/60 line-through decoration-1" : "text-foreground/90")}>
                      {c.label}
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px] tabular-nums">{c.count}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggle(c.idx)}
                    aria-pressed={!isHidden}
                    aria-label={isHidden ? `Show ${c.label}` : `Hide ${c.label}`}
                    className={cn(
                      "text-muted-foreground hover:text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 [&_svg]:size-3.5",
                      !isHidden && "opacity-60 group-hover/legend:opacity-100 focus-visible:opacity-100",
                    )}
                  >
                    {isHidden ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="border-border/60 text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-2 border-t px-1 pt-3 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="flex items-end gap-0.5">
            <span className="bg-muted-foreground/25 ring-muted-foreground/60 size-1.5 rounded-full ring-1" />
            <span className="bg-muted-foreground/25 ring-muted-foreground/60 size-2.5 rounded-full ring-1" />
          </span>
          Size is influence
        </span>
        <span className="flex items-center gap-1.5">
          <SparklesIcon aria-hidden className="size-3" />
          Game-changer
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="border-muted-foreground/70 size-2.5 rounded-full border border-dashed" />
          In your log
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
          New
        </span>
        <span className="col-span-2 leading-4">
          <Kbd>Tab</Kbd> moves between papers, <Kbd>Enter</Kbd> opens one.
        </span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="border-border bg-muted/60 text-foreground/80 rounded border px-1 py-px font-sans text-[10px] leading-none">
      {children}
    </kbd>
  );
}
