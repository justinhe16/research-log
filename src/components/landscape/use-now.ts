"use client";

import { useSyncExternalStore } from "react";

/*
 * A clock for relative times ("3 minutes ago") that actually ticks. One shared
 * value and one module-level interval, started by the first subscriber and
 * cleared when the last unsubscribes. `bumpNow()` moves it forward immediately
 * (e.g. when a search completes, so its "finished" time doesn't lag).
 */

const TICK_MS = 30_000;

let current = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const getNow = () => current;
const getServerNow = () => Date.now();

function emit(): void {
  current = Date.now();
  for (const l of listeners) l();
}

/** Advance the shared clock now and re-render every `useNow` consumer. */
export function bumpNow(): void {
  emit();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === null) {
    // The shared value is stale if nothing was subscribed for a while; React
    // re-reads the snapshot after subscribing and re-renders if it moved.
    current = Date.now();
    timer = setInterval(emit, TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time in ms, refreshed every 30s (shared across all consumers). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getServerNow);
}
