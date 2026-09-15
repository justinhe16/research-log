import { formatDistanceStrict } from "date-fns";

import { ApiError } from "@/lib/landscape/api-client";
import type { PaperLite, SearchKind, SearchStatus } from "@/lib/landscape/types";

/** "3 minutes ago" relative to `now` (pass `useNow()` so it ticks). Never reads as in the future. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatDistanceStrict(date, Math.max(now, date.getTime()), { addSuffix: true });
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`;
}

export function formatUsdRange(low: number, high: number): string {
  return `${formatUsd(low)}–${formatUsd(high).replace("$", "")}`;
}

export function formatMinutesRange(low: number, high: number): string {
  const lo = Math.max(1, Math.round(low));
  const hi = Math.max(lo, Math.round(high));
  return lo === hi ? `~${lo} min` : `${lo}–${hi} min`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value >= 10_000 ? compact.format(value) : Math.round(value).toLocaleString("en");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 2023", or the bare year, or an em dash. */
export function shortDate(paper: Pick<PaperLite, "publishedAt" | "year">): string {
  if (paper.publishedAt) {
    const [y, m] = paper.publishedAt.split("-");
    const mi = Number(m) - 1;
    if (y && mi >= 0 && mi < 12) return `${MONTHS[mi]} ${y}`;
  }
  return paper.year ? String(paper.year) : "—";
}

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  initial: "First search",
  refresh: "Refresh",
  full: "Full re-run",
};

export const SEARCH_STATUS_LABELS: Record<SearchStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 501) return "The Landscape API is not implemented yet. Add ?fixture=1 to preview with sample data.";
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
