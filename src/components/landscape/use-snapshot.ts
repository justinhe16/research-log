"use client";

import { useCallback, useEffect, useState } from "react";

import { landscapeApi } from "@/lib/landscape/api-client";
import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { useFixtureMode } from "./fixture-mode";
import { errorMessage } from "./format";

type State = {
  searchId: string | null;
  snapshot: LandscapeSnapshot | null;
  error: string | null;
};

/** The rendered landscape for one search. Pass null when there is no finished search. */
export function useSnapshot(searchId: string | null) {
  const fixture = useFixtureMode();
  const [state, setState] = useState<State>({ searchId: null, snapshot: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!searchId) return;
    let cancelled = false;
    (async () => {
      try {
        const snapshot = fixture
          ? (await import("./dev-fixtures")).fixtureSnapshot(searchId)
          : await landscapeApi.getSnapshot(searchId);
        if (!cancelled) setState({ searchId, snapshot, error: null });
      } catch (err) {
        if (!cancelled) setState({ searchId, snapshot: null, error: errorMessage(err, "Could not load this landscape.") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchId, fixture, reloadKey]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, searchId: null }));
    setReloadKey((k) => k + 1);
  }, []);

  // Derive loading from whether the stored result belongs to the requested search,
  // so switching searches never flashes the previous landscape as current.
  const current = searchId !== null && state.searchId === searchId;
  return {
    snapshot: current ? state.snapshot : null,
    error: current ? state.error : null,
    isLoading: searchId !== null && !current,
    reload,
  };
}
