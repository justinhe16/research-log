import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const LABEL_CLASS = "text-muted-foreground text-[11px] font-medium tracking-[0.06em] uppercase";

/** A labelled number: uppercase label on top, tabular value below. */
export function Metric({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className={cn(LABEL_CLASS, "truncate")}>{label}</span>
      <span className="text-foreground tabular truncate text-[15px] leading-5 font-medium tracking-tight">
        {value}
      </span>
      {hint ? <span className="text-muted-foreground truncate text-[11px] leading-4">{hint}</span> : null}
    </div>
  );
}

/** A thin 0..1 bar with the value beside it. Used for relevance and influence. */
export function ScoreBar({
  value,
  className,
  color,
  label,
}: {
  value: number | null | undefined;
  className?: string;
  color?: string;
  label?: string;
}) {
  const v = value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.min(1, value));
  return (
    <div className={cn("flex items-center gap-2", className)} aria-label={label} title={label}>
      <div className="bg-muted relative h-1 w-10 overflow-hidden rounded-full">
        {v !== null ? (
          <div
            className="bg-foreground/55 absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${v * 100}%`, background: color }}
          />
        ) : null}
      </div>
      <span className="text-muted-foreground w-6 text-right font-mono text-[11px] tracking-tight tabular-nums">
        {v === null ? "—" : Math.round(v * 100)}
      </span>
    </div>
  );
}

/** Small colored dot + label for a cluster. */
export function ClusterChip({
  color,
  label,
  className,
}: {
  color: string | null;
  label: string | null;
  className?: string;
}) {
  if (!label) return <span className="text-muted-foreground/50 text-xs">—</span>;
  return (
    <span className={cn("text-muted-foreground inline-flex min-w-0 items-center gap-1.5 text-xs", className)}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full ring-2 ring-[color-mix(in_oklch,currentColor,transparent_88%)]"
        style={{ background: color ?? "var(--muted-foreground)" }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
