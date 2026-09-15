"use client";

import { useSearchParams } from "next/navigation";

/**
 * Dev-only sample-data mode, for building the UI before the API exists.
 *  ?fixture=1        a finished topic with a full snapshot
 *  ?fixture=running  the same topic with a Deep re-run in progress
 *  ?fixture=empty    no topics / no searches
 *  ?fixture=error    every request fails
 * Always null in production builds.
 */
export type FixtureMode = "done" | "running" | "empty" | "error";

export function useFixtureMode(): FixtureMode | null {
  const params = useSearchParams();
  if (process.env.NODE_ENV === "production") return null;
  const value = params.get("fixture");
  if (!value || value === "0") return null;
  if (value === "running" || value === "empty" || value === "error") return value;
  return "done";
}

/** Keep `?fixture=` on internal links so navigating stays inside fixture mode. */
export function withFixture(href: string, mode: FixtureMode | null): string {
  if (!mode) return href;
  const value = mode === "done" ? "1" : mode;
  return `${href}${href.includes("?") ? "&" : "?"}fixture=${value}`;
}

export function fixtureDelay<T>(value: T, ms = 350): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
