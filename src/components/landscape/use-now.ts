"use client";

import { useCallback, useSyncExternalStore } from "react";

/*
 * A clock for relative times ("3 minutes ago") that actually ticks. One shared
 * value: every subscriber re-reads it on its own interval, and `bumpNow()` moves
 * it forward immediately (e.g. when a search completes, so its "finished" time
 * doesn't read as in the future).
 */

let current = Date.now();
const listeners = new Set<() => void>();

const getNow = () => current;

/** Advance the shared clock now and re-render every `useNow` consumer. */
export function bumpNow(): void {
  current = Date.now();
  for (const l of listeners) l();
}

export function useNow(intervalMs = 30_000): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      listeners.add(onChange);
      // The shared value may be stale if nothing was subscribed for a while;
      // React re-reads the snapshot after subscribing and re-renders if it moved.
      current = Date.now();
      const id = window.setInterval(() => {
        current = Date.now();
        onChange();
      }, intervalMs);
      return () => {
        listeners.delete(onChange);
        window.clearInterval(id);
      };
    },
    [intervalMs],
  );
  return useSyncExternalStore(subscribe, getNow, getNow);
}
