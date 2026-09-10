"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ApiError, api } from "@/lib/api-client";
import type { CreateEntryInput, Entry, UpdateEntryInput } from "@/lib/types";
import { isIngesting } from "./entry-utils";

const POLL_INTERVAL_MS = 2500;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * Owns the entry list: initial load, background polling while anything is still
 * ingesting, and the mutations that keep the list in sync with the server.
 */
export function useEntries() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Merge a fresh server list in, keeping any local-only rows we optimistically added. */
  const mergeServerEntries = useCallback((incoming: Entry[]) => {
    setEntries((current) => {
      const incomingIds = new Set(incoming.map((e) => e.id));
      const localOnly = current.filter((e) => !incomingIds.has(e.id));
      return [...localOnly, ...incoming];
    });
  }, []);

  const refresh = useCallback(async () => {
    const next = await api.listEntries();
    mergeServerEntries(next);
    return next;
  }, [mergeServerEntries]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await api.listEntries();
        if (!cancelled) {
          setEntries(next);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load entries."));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingCount = useMemo(() => entries.filter(isIngesting).length, [entries]);

  // Poll only while something is actually in flight. `refresh` is referentially
  // stable, so this effect only re-runs when the in-flight count crosses zero.
  useEffect(() => {
    if (pendingCount === 0) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      if (cancelled) return;
      refresh().catch(() => {
        /* transient poll failures are not worth a toast */
      });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pendingCount, refresh]);

  const upsertEntry = useCallback((entry: Entry) => {
    setEntries((current) => {
      const idx = current.findIndex((e) => e.id === entry.id);
      if (idx === -1) return [entry, ...current];
      const next = [...current];
      next[idx] = entry;
      return next;
    });
  }, []);

  const createEntry = useCallback(
    async (input: CreateEntryInput) => {
      const entry = await api.createEntry(input);
      setEntries((current) => [entry, ...current.filter((e) => e.id !== entry.id)]);
      return entry;
    },
    [],
  );

  const updateEntry = useCallback(
    async (id: string, input: UpdateEntryInput) => {
      const previous = entries.find((e) => e.id === id);
      // Optimistic: the fields we patch are all plain scalars.
      if (previous) upsertEntry({ ...previous, ...input } as Entry);
      try {
        const entry = await api.updateEntry(id, input);
        upsertEntry(entry);
        return entry;
      } catch (err) {
        if (previous) upsertEntry(previous);
        toast.error(errorMessage(err, "Could not save changes."));
        throw err;
      }
    },
    [entries, upsertEntry],
  );

  const deleteEntry = useCallback(
    async (id: string) => {
      const previous = entries;
      setEntries((current) => current.filter((e) => e.id !== id));
      try {
        await api.deleteEntry(id);
        toast.success("Entry deleted.");
      } catch (err) {
        setEntries(previous);
        toast.error(errorMessage(err, "Could not delete entry."));
        throw err;
      }
    },
    [entries],
  );

  const reingestEntry = useCallback(
    async (id: string) => {
      try {
        const entry = await api.reingestEntry(id);
        upsertEntry(entry);
        toast.success("Retrying ingest…");
        return entry;
      } catch (err) {
        toast.error(errorMessage(err, "Could not retry ingest."));
        throw err;
      }
    },
    [upsertEntry],
  );

  return {
    entries,
    isLoading,
    loadError,
    pendingCount,
    refresh,
    createEntry,
    updateEntry,
    deleteEntry,
    reingestEntry,
    upsertEntry,
  };
}

export type EntriesApi = ReturnType<typeof useEntries>;
