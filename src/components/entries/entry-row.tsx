"use client";

import { formatDistanceToNow } from "date-fns";
import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Entry } from "@/lib/types";
import { Rating } from "./rating";
import {
  displayTitle,
  domainOf,
  ingestLabel,
  isIngestError,
  isIngesting,
  statusLabel,
} from "./entry-utils";

type EntryRowProps = {
  entry: Entry;
  onOpen: (entry: Entry) => void;
  onRetry: (id: string) => void;
};

/** Every body cell shares this rhythm so the columns stay on one grid. */
const CELL = "px-4 py-2.5";

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDistanceToNow(date, { addSuffix: true });
}

export function EntryRow({ entry, onOpen, onRetry }: EntryRowProps) {
  const ingesting = isIngesting(entry);
  const errored = isIngestError(entry);
  const visibleTags = entry.tags.slice(0, 3);
  const extraTags = entry.tags.length - visibleTags.length;

  return (
    <TableRow
      tabIndex={0}
      role="button"
      aria-label={`Open ${displayTitle(entry)}`}
      onClick={() => onOpen(entry)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(entry);
        }
      }}
      className="group border-border/60 hover:bg-muted/40 focus-visible:bg-muted/60 cursor-pointer align-top transition-colors outline-none"
    >
      {/* Title + source */}
      <TableCell className={`${CELL} max-w-0`}>
        {ingesting ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-[min(22rem,80%)]" />
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="bg-foreground/45 size-1.5 shrink-0 animate-pulse rounded-full"
              />
              <span className="text-muted-foreground font-mono text-[11px] tracking-tight">
                {ingestLabel(entry.ingestStatus).toLowerCase()}…
              </span>
              <SourceLink url={entry.url} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-foreground/90 group-hover:text-foreground truncate text-sm leading-5 font-medium tracking-tight transition-colors">
              {displayTitle(entry)}
            </span>
            <div className="flex items-center gap-2">
              <SourceLink url={entry.url} />
              {errored ? (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="destructive"
                        className="rounded-md px-1.5 text-[11px] font-medium"
                      >
                        Ingest failed
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {entry.ingestError || "The background ingest did not finish."}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground -my-1 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry(entry.id);
                    }}
                  >
                    <RotateCwIcon data-icon="inline-start" />
                    Retry
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </TableCell>

      {/* Category — the one badge allowed to carry weight */}
      <TableCell className={CELL}>
        <Badge
          variant="secondary"
          className="rounded-md px-1.5 text-[11px] font-medium tracking-tight"
        >
          {entry.category}
        </Badge>
      </TableCell>

      {/* Tags — deliberately quieter than the category */}
      <TableCell className={`${CELL} hidden lg:table-cell`}>
        {entry.tags.length === 0 ? (
          <span className="text-muted-foreground/50 text-xs">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {visibleTags.map((tag, ti) => (
              <Badge
                key={`${ti}-${tag}`}
                variant="outline"
                className="border-border/60 text-muted-foreground max-w-32 rounded-md px-1.5 text-[11px] font-normal"
              >
                <span className="truncate">{tag}</span>
              </Badge>
            ))}
            {extraTags > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="ghost"
                    className="text-muted-foreground/70 rounded-md px-1 text-[11px] font-normal"
                  >
                    +{extraTags}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {entry.tags.slice(3).join(", ")}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        )}
      </TableCell>

      {/* Content type */}
      <TableCell className={`${CELL} text-muted-foreground hidden text-xs capitalize md:table-cell`}>
        {entry.contentType || "—"}
      </TableCell>

      {/* Status */}
      <TableCell className={`${CELL} hidden sm:table-cell`}>
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {statusLabel(entry.status)}
        </span>
      </TableCell>

      {/* Rating */}
      <TableCell className={CELL}>
        <Rating value={entry.rating} size="sm" />
      </TableCell>

      {/* Added */}
      <TableCell
        className={`${CELL} text-muted-foreground font-mono text-[11px] tracking-tight whitespace-nowrap tabular-nums`}
      >
        {relativeTime(entry.createdAt)}
      </TableCell>
    </TableRow>
  );
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-mono text-[11px] tracking-tight transition-colors hover:underline"
    >
      {domainOf(url)}
      <ExternalLinkIcon className="size-2.5 opacity-70" />
    </a>
  );
}
