"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, landscapeApi } from "@/lib/landscape/api-client";
import type { TopicDetail } from "@/lib/landscape/types";
import { useFixtureMode } from "./fixture-mode";
import { errorMessage } from "./format";

type State = { topicId: string; topic: TopicDetail | null; error: string | null; notFound: boolean };

/** One topic with its full search history. `refresh` refetches without a loading flash. */
export function useTopic(topicId: string) {
  const fixture = useFixtureMode();
  const [state, setState] = useState<State | null>(null);

  const fetchTopic = useCallback(async () => {
    if (fixture) {
      const { fixtureTopicDetail } = await import("./dev-fixtures");
      if (fixture === "error") throw new ApiError("Could not reach the Landscape API (fixture).", 500);
      return fixtureTopicDetail(fixture);
    }
    return landscapeApi.getTopic(topicId);
  }, [fixture, topicId]);

  const refresh = useCallback(async () => {
    const next = await fetchTopic();
    setState({ topicId, topic: next, error: null, notFound: false });
    return next;
  }, [fetchTopic, topicId]);

  useEffect(() => {
    let cancelled = false;
    fetchTopic()
      .then((next) => {
        if (!cancelled) setState({ topicId, topic: next, error: null, notFound: false });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          topicId,
          topic: null,
          error: errorMessage(err, "Could not load this topic."),
          notFound: err instanceof ApiError && err.status === 404,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchTopic, topicId]);

  const current = state?.topicId === topicId ? state : null;
  return {
    topic: current?.topic ?? null,
    isLoading: current === null,
    loadError: current?.error ?? null,
    notFound: current?.notFound ?? false,
    refresh,
    fixture,
  };
}
