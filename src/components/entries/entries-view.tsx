"use client";

import { useCallback, useMemo, useState } from "react";

import { AddEntryForm } from "./add-entry-form";
import { EntriesTable } from "./entries-table";
import { EntryDetailDialog } from "./entry-detail-dialog";
import { useEntries } from "./use-entries";
import type { Entry } from "@/lib/types";

export function EntriesView() {
  const {
    entries,
    isLoading,
    loadError,
    pendingCount,
    createEntry,
    updateEntry,
    deleteEntry,
    reingestEntry,
  } = useEntries();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => (selectedId ? (entries.find((e) => e.id === selectedId) ?? null) : null),
    [entries, selectedId],
  );

  const handleOpen = useCallback((entry: Entry) => setSelectedId(entry.id), []);
  const handleRetry = useCallback(
    (id: string) => {
      void reingestEntry(id);
    },
    [reingestEntry],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pb-24 sm:px-6">
      <div className="sticky top-14 z-20 -mx-4 bg-background/80 px-4 pt-4 pb-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <AddEntryForm onCreate={createEntry} />
      </div>

      <EntriesTable
        entries={entries}
        isLoading={isLoading}
        loadError={loadError}
        pendingCount={pendingCount}
        onOpen={handleOpen}
        onRetry={handleRetry}
      />

      <EntryDetailDialog
        entry={selected}
        open={selectedId !== null && selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onUpdate={updateEntry}
        onDelete={deleteEntry}
        onRetry={handleRetry}
        onOpenRelated={setSelectedId}
      />
    </div>
  );
}
