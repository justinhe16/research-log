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

/** Shared column rhythm — keeps header cells and body cells on the same grid. */
const HEAD_CLASS =
  "text-muted-foreground h-9 px-4 text-[11px] font-medium tracking-[0.06em] uppercase";

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
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground/70 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, summaries, tags, notes…"
            className="h-8 pl-8 text-sm transition-colors"
            aria-label="Search entries"
          />
        </div>

        <div className="flex items-center gap-2">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger
              className="text-muted-foreground data-[state=open]:text-foreground w-full text-xs sm:w-[150px]"
              aria-label="Filter by category"
            >
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
            <SelectTrigger
              className="text-muted-foreground data-[state=open]:text-foreground w-full text-xs sm:w-[140px]"
              aria-label="Filter by status"
            >
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
            <Button
              variant="ghost"
              size="icon"
              onClick={clearFilters}
              aria-label="Clear filters"
              className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
            >
              <FilterXIcon />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="text-muted-foreground flex items-center gap-2 px-0.5 text-[11px]">
        <span className="tabular">
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
          {hasFilters && entries.length !== filtered.length ? ` of ${entries.length}` : ""}
        </span>
        {pendingCount > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="bg-border h-3 w-px" aria-hidden />
            <span
              aria-hidden
              className="bg-foreground/45 size-1.5 animate-pulse rounded-full"
            />
            <span className="font-mono tracking-tight">{pendingCount} ingesting</span>
          </span>
        ) : null}
      </div>

      <div className="bg-card border-border/70 overflow-hidden rounded-xl border shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="border-border/60 bg-muted/30 hover:bg-transparent">
              <TableHead className={`${HEAD_CLASS} w-[45%]`}>Title</TableHead>
              <TableHead className={`${HEAD_CLASS} w-[110px]`}>Category</TableHead>
              <TableHead className={`${HEAD_CLASS} hidden lg:table-cell`}>Tags</TableHead>
              <TableHead className={`${HEAD_CLASS} hidden w-[80px] md:table-cell`}>Type</TableHead>
              <TableHead className={`${HEAD_CLASS} hidden w-[90px] sm:table-cell`}>Status</TableHead>
              <TableHead className={`${HEAD_CLASS} w-[110px]`}>Rating</TableHead>
              <TableHead className={`${HEAD_CLASS} w-[110px]`}>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <LoadingRows />
            ) : loadError ? (
              <MessageRow
                icon={<SearchXIcon className="size-4" />}
                title="Could not load your log"
                body={loadError}
              />
            ) : entries.length === 0 ? (
              <MessageRow
                icon={<InboxIcon className="size-4" />}
                title="Nothing logged yet"
                body="Paste a link above and it will show up here with a summary, tags, and key claims."
              />
            ) : filtered.length === 0 ? (
              <MessageRow
                icon={<SearchXIcon className="size-4" />}
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
        <TableRow key={i} className="border-border/60 hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-[min(20rem,70%)]" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 lg:table-cell">
            <Skeleton className="h-3.5 w-24" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 md:table-cell">
            <Skeleton className="h-3.5 w-10" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 sm:table-cell">
            <Skeleton className="h-3.5 w-12" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-14" />
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
      <TableCell colSpan={7} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-2 text-center">
          <div className="text-muted-foreground bg-muted/70 ring-border/60 flex size-9 items-center justify-center rounded-full ring-1">
            {icon}
          </div>
          <p className="text-sm font-medium tracking-tight">{title}</p>
          <p className="text-muted-foreground text-xs leading-5 text-balance">{body}</p>
          {action ? <div className="mt-1.5">{action}</div> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
