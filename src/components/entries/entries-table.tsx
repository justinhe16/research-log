"use client";

import { useMemo, useState } from "react";
import { FilterXIcon, InboxIcon, SearchIcon, SearchXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CATEGORIES, STATUSES } from "@/lib/constants";
import type { Entry } from "@/lib/types";
import { EntryRow } from "./entry-row";
import { searchHaystack, statusLabel } from "./entry-utils";

const ALL = "all";

type EntriesTableProps = {
  entries: Entry[];
  isLoading: boolean;
  loadError: string | null;
  pendingCount: number;
  onOpen: (entry: Entry) => void;
  onRetry: (id: string) => void;
};

export function EntriesTable({
  entries,
  isLoading,
  loadError,
  pendingCount,
  onOpen,
  onRetry,
}: EntriesTableProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);

  const hasFilters = query.trim() !== "" || category !== ALL || status !== ALL;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (category !== ALL && entry.category !== category) return false;
      if (status !== ALL && entry.status !== status) return false;
      if (needle && !searchHaystack(entry).includes(needle)) return false;
      return true;
    });
  }, [entries, query, category, status]);

  function clearFilters() {
    setQuery("");
    setCategory(ALL);
    setStatus(ALL);
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, summaries, tags, notes…"
            className="pl-8"
            aria-label="Search entries"
          />
        </div>

        <div className="flex items-center gap-2">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full sm:w-[150px]" aria-label="Filter by category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full sm:w-[140px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasFilters ? (
            <Button variant="ghost" size="icon" onClick={clearFilters} aria-label="Clear filters">
              <FilterXIcon />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="text-muted-foreground flex items-center gap-2 px-0.5 text-xs">
        <span>
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
          {hasFilters && entries.length !== filtered.length ? ` of ${entries.length}` : ""}
        </span>
        {pendingCount > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground/40">·</span>
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500/70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-sky-500" />
            </span>
            {pendingCount} still ingesting
          </span>
        ) : null}
      </div>

      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[45%]">Title</TableHead>
              <TableHead className="w-[110px]">Category</TableHead>
              <TableHead className="hidden lg:table-cell">Tags</TableHead>
              <TableHead className="hidden w-[80px] md:table-cell">Type</TableHead>
              <TableHead className="hidden w-[90px] sm:table-cell">Status</TableHead>
              <TableHead className="w-[110px]">Rating</TableHead>
              <TableHead className="w-[110px]">Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <LoadingRows />
            ) : loadError ? (
              <MessageRow
                icon={<SearchXIcon className="size-5" />}
                title="Could not load your log"
                body={loadError}
              />
            ) : entries.length === 0 ? (
              <MessageRow
                icon={<InboxIcon className="size-5" />}
                title="Nothing logged yet"
                body="Paste a link above and it will show up here with a summary, tags, and key claims."
              />
            ) : filtered.length === 0 ? (
              <MessageRow
                icon={<SearchXIcon className="size-5" />}
                title="No entries match your filters"
                body="Try a different search term or widen the category and status filters."
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              filtered.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onOpen={onOpen} onRetry={onRetry} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <TableRow key={i} className="hover:bg-transparent">
          <TableCell className="py-3">
            <Skeleton className="h-4 w-[min(20rem,70%)]" />
          </TableCell>
          <TableCell className="py-3">
            <Skeleton className="h-4 w-16" />
          </TableCell>
          <TableCell className="hidden py-3 lg:table-cell">
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell className="hidden py-3 md:table-cell">
            <Skeleton className="h-4 w-10" />
          </TableCell>
          <TableCell className="hidden py-3 sm:table-cell">
            <Skeleton className="h-4 w-12" />
          </TableCell>
          <TableCell className="py-3">
            <Skeleton className="h-4 w-16" />
          </TableCell>
          <TableCell className="py-3">
            <Skeleton className="h-4 w-14" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function MessageRow({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={7} className="py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-2 text-center">
          <div className="text-muted-foreground bg-muted flex size-10 items-center justify-center rounded-full">
            {icon}
          </div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs leading-5">{body}</p>
          {action ? <div className="mt-1">{action}</div> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
