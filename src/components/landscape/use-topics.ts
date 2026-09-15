"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, landscapeApi } from "@/lib/landscape/api-client";
import type { TopicCard } from "@/lib/landscape/types";
import { useFixtureMode } from "./fixture-mode";
import { errorMessage } from "./format";

const POLL_INTERVAL_MS = 2500;

/**
 * The topic list: initial load, plus background polling while any topic has a
 * queued or running search (mirrors `useEntries`).
 */
export function useTopics() {
  const fixture = useFixtureMode();
  const [topics, setTopics] = useState<TopicCard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchTopics = useCallback(async (): Promise<TopicCard[]> => {
    if (fixture) {
      const { fixtureTopics } = await import("./dev-fixtures");
      if (fixture === "error") throw new ApiError("Could not reach the Landscape API (fixture).", 500);
      return fixtureTopics(fixture);
    }
    return landscapeApi.listTopics();
  }, [fixture]);

  const refresh = useCallback(async () => {
    const next = await fetchTopics();
    setTopics(next);
    setLoadError(null);
    return next;
  }, [fetchTopics]);

  useEffect(() => {
    let cancelled = false;
    fetchTopics()
      .then((next) => {
        if (cancelled) return;
        setTopics(next);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load topics."));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchTopics]);

  const activeCount = useMemo(() => topics.filter((t) => t.activeSearch !== null).length, [topics]);

  useEffect(() => {
    if (activeCount === 0) return;
    const id = window.setInterval(() => {
      refresh().catch(() => {
        /* transient poll failures are not worth surfacing */
      });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [activeCount, refresh]);

  return { topics, isLoading, loadError, activeCount, refresh, fixture };
}
