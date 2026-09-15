"use client";

import { useId, useMemo, useRef, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { PaperLite } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 7;

/** Find a paper on the map by title or author, then fly to it. */
export function MapSearch({
  papers,
  colorOf,
  onSelect,
  className,
}: {
  papers: PaperLite[];
  colorOf: (paper: PaperLite) => string;
  onSelect: (paperId: string) => void;
  className?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return papers
      .filter((p) => `${p.title} ${p.authors.join(" ")}`.toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS);
  }, [papers, query]);

  const showList = open && query.trim() !== "";
  const activeIndex = results.length === 0 ? -1 : Math.min(cursor, results.length - 1);

  function pick(id: string) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <div className={cn("relative", className)}>
      <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        ref={inputRef}
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-label="Find a paper on the map"
        placeholder="Find a paper"
        className="bg-popover h-8 pr-7 pl-8 text-xs shadow-xs"
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.max(0, Math.min(c + 1, results.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            pick(results[activeIndex].id);
          } else if (e.key === "Escape") {
            // Keep Escape from reaching the map (or a dialog) behind the search.
            e.stopPropagation();
            if (query) setQuery("");
            else (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="bg-popover text-popover-foreground ring-foreground/10 absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg p-1 shadow-md ring-1 sm:w-80 sm:right-auto"
        >
          {results.length === 0 ? (
            <li role="option" aria-disabled="true" aria-selected="false" className="text-muted-foreground px-2 py-2 text-xs">
              No paper on the map matches.
            </li>
          ) : (
            results.map((p, i) => (
              <li
                key={p.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p.id);
                }}
                onMouseEnter={() => setCursor(i)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5", i === activeIndex && "bg-muted")}
              >
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: colorOf(p) }} />
                <span className="min-w-0 flex-1 truncate text-xs">{p.title}</span>
                {p.year ? <span className="text-muted-foreground font-mono text-[11px] tabular-nums">{p.year}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
