"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import {
  ArrowUpRightIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RotateCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { CATEGORIES, STATUSES } from "@/lib/constants";
import type { Entry, RelatedEntry, UpdateEntryInput } from "@/lib/types";
import { Rating } from "./rating";
import {
  displayTitle,
  domainOf,
  formatScore,
  ingestLabel,
  isIngestError,
  isIngesting,
  parseSummary,
  statusLabel,
} from "./entry-utils";

type EntryDetailDialogProps = {
  entry: Entry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (id: string, input: UpdateEntryInput) => Promise<Entry>;
  onDelete: (id: string) => Promise<void>;
  onRetry: (id: string) => void;
  /** Jump the dialog to another entry (used by the Related list). */
  onOpenRelated: (id: string) => void;
};

export function EntryDetailDialog({
  entry,
  open,
  onOpenChange,
  onUpdate,
  onDelete,
  onRetry,
  onOpenRelated,
}: EntryDetailDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[86vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        {entry ? (
          <EntryDetailBody
            key={entry.id}
            entry={entry}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onRetry={onRetry}
            onOpenRelated={onOpenRelated}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <div className="p-6">
            <DialogTitle className="sr-only">Entry</DialogTitle>
            <Skeleton className="h-5 w-64" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EntryDetailBody({
  entry,
  onUpdate,
  onDelete,
  onRetry,
  onOpenRelated,
  onClose,
}: {
  entry: Entry;
  onUpdate: (id: string, input: UpdateEntryInput) => Promise<Entry>;
  onDelete: (id: string) => Promise<void>;
  onRetry: (id: string) => void;
  onOpenRelated: (id: string) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [whySaved, setWhySaved] = useState(entry.whySaved ?? "");
  const [isSavingText, setIsSavingText] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // The body is keyed by entry id, so it remounts (and re-seeds these) per entry.

  const textDirty = notes !== (entry.notes ?? "") || whySaved !== (entry.whySaved ?? "");

  const saveText = useCallback(async () => {
    const patch: UpdateEntryInput = {};
    if (notes !== (entry.notes ?? "")) patch.notes = notes;
    if (whySaved !== (entry.whySaved ?? "")) patch.whySaved = whySaved;
    if (Object.keys(patch).length === 0) return;

    setIsSavingText(true);
    try {
      await onUpdate(entry.id, patch);
      toast.success("Notes saved.");
    } catch {
      /* the hook already toasted and rolled back */
    } finally {
      setIsSavingText(false);
    }
  }, [entry.id, entry.notes, entry.whySaved, notes, whySaved, onUpdate]);

  const patchField = useCallback(
    async (input: UpdateEntryInput) => {
      try {
        await onUpdate(entry.id, input);
      } catch {
        /* handled upstream */
      }
    },
    [entry.id, onUpdate],
  );

  const summaryBlocks = parseSummary(entry.summary ?? "");
  const ingesting = isIngesting(entry);
  const errored = isIngestError(entry);

  const meta: { label: string; value: string }[] = [];
  if (entry.contentType) meta.push({ label: "Type", value: entry.contentType });
  if (entry.authors?.length) meta.push({ label: "Authors", value: entry.authors.join(", ") });
  if (entry.org) meta.push({ label: "Org", value: entry.org });
  if (entry.venue) meta.push({ label: "Venue", value: entry.venue });
  if (entry.publishedAt) {
    const date = new Date(entry.publishedAt);
    meta.push({
      label: "Published",
      value: Number.isNaN(date.getTime()) ? entry.publishedAt : format(date, "d MMM yyyy"),
    });
  }

  return (
    <>
      <DialogHeader className="gap-1.5 border-b p-5 pr-12">
        <DialogTitle className="text-lg leading-6">
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            className="decoration-muted-foreground/40 underline-offset-4 hover:underline"
          >
            {displayTitle(entry)}
            <ExternalLinkIcon className="text-muted-foreground ml-1.5 inline size-3.5 align-baseline" />
          </a>
        </DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-muted-foreground">{domainOf(entry.url)}</span>
          {entry.contentType ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="capitalize">{entry.contentType}</span>
            </>
          ) : null}
          {ingesting ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="animate-pulse text-sky-600 dark:text-sky-400">
                {ingestLabel(entry.ingestStatus)}…
              </span>
            </>
          ) : null}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 p-5">
          {errored ? (
            <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2.5 rounded-lg border p-3">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <div className="flex-1 text-xs leading-5">
                <p className="font-medium">Ingest failed</p>
                <p className="opacity-90">
                  {entry.ingestError || "The background ingest did not finish."}
                </p>
              </div>
              <Button size="xs" variant="outline" onClick={() => onRetry(entry.id)}>
                <RotateCwIcon data-icon="inline-start" />
                Retry
              </Button>
            </div>
          ) : null}

          {meta.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {meta.map((item) => (
                <div key={item.label} className="contents">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <Section title="Summary">
            {ingesting ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-[92%]" />
                <Skeleton className="h-3.5 w-[70%]" />
              </div>
            ) : summaryBlocks.length === 0 ? (
              <p className="text-muted-foreground text-sm">No summary yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {summaryBlocks.map((block, i) =>
                  block.kind === "list" ? (
                    <ul key={i} className="flex list-none flex-col gap-1.5">
                      {block.items.map((item, j) => (
                        <li key={j} className="flex gap-2.5 text-sm leading-6">
                          <span className="bg-muted-foreground/40 mt-2.5 size-1 shrink-0 rounded-full" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p key={i} className="text-sm leading-6">
                      {block.text}
                    </p>
                  ),
                )}
              </div>
            )}
          </Section>

          {entry.keyClaims?.length ? (
            <Section title="Key claims">
              <ol className="flex flex-col gap-2">
                {entry.keyClaims.map((claim, i) => (
                  <li key={i} className="flex gap-2.5 text-sm leading-6">
                    <span className="text-muted-foreground bg-muted mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium">
                      {i + 1}
                    </span>
                    <span>{claim}</span>
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          {entry.tags?.length ? (
            <Section title="Tags">
              <div className="flex flex-wrap gap-1.5">
                {entry.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}

          <Separator />

          {/* --- Editable fields --- */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-xs">Category</Label>
              <Select value={entry.category} onValueChange={(v) => patchField({ category: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-xs">Status</Label>
              <Select value={entry.status} onValueChange={(v) => patchField({ status: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-xs">Rating</Label>
              <div className="flex h-8 items-center">
                <Rating value={entry.rating} onChange={(v) => patchField({ rating: v })} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="detail-notes" className="text-muted-foreground text-xs">
                Notes
              </Label>
              <Textarea
                id="detail-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveText}
                rows={4}
                placeholder="What you took away from it…"
                className="resize-y"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="detail-why" className="text-muted-foreground text-xs">
                Why I saved this
              </Label>
              <Textarea
                id="detail-why"
                value={whySaved}
                onChange={(e) => setWhySaved(e.target.value)}
                onBlur={saveText}
                rows={4}
                placeholder="The thread of thought that led you here…"
                className="resize-y"
              />
            </div>
          </div>

          <Separator />

          <RelatedSection entryId={entry.id} onOpenRelated={onOpenRelated} />
        </div>
      </div>

      {/* --- Footer --- */}
      <div className="bg-muted/40 flex items-center justify-between gap-2 border-t p-3">
        <div className="flex items-center gap-2">
          {confirmDelete ? (
            <>
              <span className="text-muted-foreground text-xs">Delete this entry?</span>
              <Button
                size="sm"
                variant="destructive"
                disabled={isDeleting}
                onClick={async () => {
                  setIsDeleting(true);
                  try {
                    await onDelete(entry.id);
                    onClose();
                  } catch {
                    setIsDeleting(false);
                    setConfirmDelete(false);
                  }
                }}
              >
                {isDeleting ? <Loader2Icon className="animate-spin" /> : null}
                Yes, delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon data-icon="inline-start" />
              Delete
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {textDirty ? (
            <span className="text-muted-foreground text-xs">Unsaved notes</span>
          ) : null}
          <Button size="sm" variant="outline" disabled={!textDirty || isSavingText} onClick={saveText}>
            {isSavingText ? <Loader2Icon className="animate-spin" /> : null}
            Save notes
          </Button>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h3>
      {children}
    </section>
  );
}

function RelatedSection({
  entryId,
  onOpenRelated,
}: {
  entryId: string;
  onOpenRelated: (id: string) => void;
}) {
  const [related, setRelated] = useState<RelatedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .relatedEntries(entryId)
      .then((r) => {
        if (!cancelled) setRelated(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load related.");
      });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  return (
    <Section title="Related">
      {error ? (
        <p className="text-muted-foreground text-sm">{error}</p>
      ) : related === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : related.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing similar in the log yet — related links appear once a few more entries are embedded.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {related.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpenRelated(item.id)}
                className="hover:bg-muted focus-visible:ring-ring/50 group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm leading-5">{item.title || domainOf(item.url)}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {item.category}
                    {item.tags?.length ? ` · ${item.tags.slice(0, 3).join(", ")}` : ""}
                  </p>
                </div>
                <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                  {formatScore(item.score)}
                </span>
                <ArrowUpRightIcon className="text-muted-foreground/50 group-hover:text-foreground size-3.5 shrink-0 transition-colors" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
