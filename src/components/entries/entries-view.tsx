"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pb-24 sm:px-6">
      <div className="bg-background/75 supports-[backdrop-filter]:bg-background/60 sticky top-13 z-20 -mx-4 px-4 pt-5 pb-3 backdrop-blur-md sm:-mx-6 sm:px-6">
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

      {/* Deep link from elsewhere (e.g. Landscape's "In your log"): /logs?entry=<id>. Its
          own Suspense boundary keeps the rest of the page prerenderable. */}
      <Suspense fallback={null}>
        <OpenEntryFromQuery onOpen={setSelectedId} />
      </Suspense>

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

/** Opens the entry named by `?entry=` once, then drops the param so closing the dialog sticks. */
function OpenEntryFromQuery({ onOpen }: { onOpen: (id: string) => void }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const entryId = searchParams.get("entry");

  useEffect(() => {
    if (!entryId) return;
    onOpen(entryId);
    const next = new URLSearchParams(searchParams.toString());
    next.delete("entry");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [entryId, onOpen, pathname, router, searchParams]);

  return null;
}
