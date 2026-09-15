"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { landscapeApi } from "@/lib/landscape/api-client";
import { SEARCH_POLL_INTERVAL_MS } from "@/lib/landscape/constants";
import { ACTIVE_SEARCH_STATUSES, type SearchProgress, type SearchStatus } from "@/lib/landscape/types";
import { useFixtureMode } from "./fixture-mode";
import { errorMessage } from "./format";

export function isActiveStatus(status: SearchStatus): boolean {
  return (ACTIVE_SEARCH_STATUSES as readonly SearchStatus[]).includes(status);
}

type State = { searchId: string; progress: SearchProgress | null; error: string | null };

/**
 * Live progress for one search. Polls every 2s while it is queued or running and
 * calls `onSettled` once when it leaves the active states.
 */
export function useSearchProgress(searchId: string | null, onSettled?: (progress: SearchProgress) => void) {
  const fixture = useFixtureMode();
  const [state, setState] = useState<State | null>(null);
  const [pollKey, setPollKey] = useState(0);

  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const fetchProgress = useCallback(
    async (id: string) => {
      if (fixture) {
        const { fixtureProgress } = await import("./dev-fixtures");
        return { ...fixtureProgress(), id };
      }
      return landscapeApi.getSearch(id);
    },
    [fixture],
  );

  useEffect(() => {
    if (!searchId) return;
    let cancelled = false;
    let timer: number | undefined;
    let wasActive = false;

    const tick = async () => {
      try {
        const next = await fetchProgress(searchId);
        if (cancelled) return;
        setState({ searchId, progress: next, error: null });
        if (isActiveStatus(next.status)) {
          wasActive = true;
          timer = window.setTimeout(tick, SEARCH_POLL_INTERVAL_MS);
        } else if (wasActive) {
          onSettledRef.current?.(next);
        }
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({
          searchId,
          progress: s?.searchId === searchId ? s.progress : null,
          error: errorMessage(err, "Could not load search progress."),
        }));
        // Keep trying: a dev server restart mid-run should recover on its own.
        timer = window.setTimeout(tick, SEARCH_POLL_INTERVAL_MS * 2);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchId, fetchProgress, pollKey]);

  /** Replace the local copy (e.g. with a cancel/resume response) and poll again if it is active. */
  const update = useCallback(
    (next: SearchProgress) => {
      setState({ searchId: next.id, progress: next, error: null });
      if (isActiveStatus(next.status)) setPollKey((k) => k + 1);
    },
    [],
  );

  const current = state && state.searchId === searchId ? state : null;
  return { progress: current?.progress ?? null, error: current?.error ?? null, update };
}
