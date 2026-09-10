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
      className="cursor-pointer align-top outline-none focus-visible:bg-muted/60"
    >
      {/* Title + source */}
      <TableCell className="max-w-0 py-3">
        {ingesting ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-[min(22rem,80%)]" />
            <div className="flex items-center gap-1.5">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500/70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-sky-500" />
              </span>
              <span className="text-muted-foreground animate-pulse text-xs">
                {ingestLabel(entry.ingestStatus)}…
              </span>
              <SourceLink url={entry.url} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="truncate text-sm leading-5 font-medium">{displayTitle(entry)}</span>
            <div className="flex items-center gap-2">
              <SourceLink url={entry.url} />
              {errored ? (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="destructive">Ingest failed</Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {entry.ingestError || "The background ingest did not finish."}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    size="xs"
                    variant="ghost"
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

      {/* Category */}
      <TableCell className="py-3">
        <Badge variant="secondary" className="font-normal">
          {entry.category}
        </Badge>
      </TableCell>

      {/* Tags */}
      <TableCell className="hidden py-3 lg:table-cell">
        {entry.tags.length === 0 ? (
          <span className="text-muted-foreground/60 text-xs">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <Badge key={tag} variant="outline" className="max-w-32 font-normal">
                <span className="truncate">{tag}</span>
              </Badge>
            ))}
            {extraTags > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="ghost" className="text-muted-foreground font-normal">
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
      <TableCell className="text-muted-foreground hidden py-3 text-xs capitalize md:table-cell">
        {entry.contentType || "—"}
      </TableCell>

      {/* Status */}
      <TableCell className="hidden py-3 sm:table-cell">
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {statusLabel(entry.status)}
        </span>
      </TableCell>

      {/* Rating */}
      <TableCell className="py-3">
        <Rating value={entry.rating} size="sm" />
      </TableCell>

      {/* Added */}
      <TableCell className="text-muted-foreground py-3 text-xs whitespace-nowrap">
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
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors hover:underline"
    >
      {domainOf(url)}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}
