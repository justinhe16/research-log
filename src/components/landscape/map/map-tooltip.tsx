"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useStore, type ReactFlowState } from "@xyflow/react";
import { BookmarkCheckIcon, SparklesIcon } from "lucide-react";

import { formatCount } from "../format";
import type { LayoutPoint } from "./layout";
import { useActivePaperId, type PaperNodeData } from "./map-context";

const EDGE_PAD = 12;
const OFFSET = 12;

const viewportSelector = (s: ReactFlowState) => `${s.transform[0]},${s.transform[1]},${s.transform[2]},${s.width},${s.height}`;

/**
 * One hover card for the whole map, positioned in the container's screen
 * space: it flips below the paper near the top edge and stays inside the map.
 */
export function MapTooltip({
  positions,
  dataById,
}: {
  positions: Map<string, LayoutPoint>;
  dataById: Map<string, PaperNodeData>;
}) {
  const activeId = useActivePaperId();
  const viewport = useStore(viewportSelector);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 288, h: 140 });

  const data = activeId ? dataById.get(activeId) : undefined;
  const point = activeId ? positions.get(activeId) : undefined;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
  }, [activeId]);

  if (!data || !point) return null;
  const [tx, ty, zoom, width, height] = viewport.split(",").map(Number);
  const sx = point.x * zoom + tx;
  const sy = point.y * zoom + ty;
  const r = (point.size / 2) * zoom + 6;

  const above = sy - r - OFFSET - box.h >= EDGE_PAD;
  const fitsBelow = sy + r + OFFSET + box.h <= height - EDGE_PAD;
  const top = above || !fitsBelow ? Math.max(EDGE_PAD, sy - r - OFFSET - box.h) : sy + r + OFFSET;
  const left = Math.min(Math.max(EDGE_PAD, sx - box.w / 2), Math.max(EDGE_PAD, width - box.w - EDGE_PAD));
  const { paper, color, clusterLabel, isNew } = data;

  return (
    <div
      ref={ref}
      role="tooltip"
      className="bg-popover text-popover-foreground ring-foreground/10 pointer-events-none absolute z-30 w-72 max-w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-lg shadow-lg ring-1"
      style={{ left, top }}
    >
      <div className="border-l-2 py-2.5 pr-3 pl-3" style={{ borderLeftColor: color }}>
        {clusterLabel ? <p className="text-muted-foreground truncate text-[11px] leading-4">{clusterLabel}</p> : null}
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-[18px] font-medium tracking-tight">{paper.title}</p>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
          {paper.year ? <span>{paper.year}</span> : null}
          <span>{formatCount(paper.citationCount)} citations</span>
          <span>Influence {Math.round(paper.influence * 100)}</span>
        </div>
        {paper.tldr ? <p className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-[17px]">{paper.tldr}</p> : null}
        {paper.gameChanger || paper.loggedEntryId || isNew ? (
          <div className="text-foreground/75 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {paper.gameChanger ? (
              <span className="inline-flex items-center gap-1">
                <SparklesIcon className="size-3" aria-hidden />
                Game-changer
              </span>
            ) : null}
            {paper.loggedEntryId ? (
              <span className="inline-flex items-center gap-1">
                <BookmarkCheckIcon className="size-3" aria-hidden />
                In your log
              </span>
            ) : null}
            {isNew ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                New
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
