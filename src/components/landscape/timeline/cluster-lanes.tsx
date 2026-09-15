"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AxisBottom } from "@visx/axis";
import { useParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { colorSlotVar } from "../cluster-colors";
import { formatCount, shortDate } from "../format";
import { ClusterChip } from "../metric";
import { computeTimelineLayout, LAYOUT, type OverflowMarker, type PlacedPaper } from "./layout";

export type ClusterLanesProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

type LineageMode = "hover" | "all";

const MIN_PLOT_WIDTH = 560;

/** Four-point star, centred on 0,0. */
const STAR = "M0,-5 L1.3,-1.3 L5,0 L1.3,1.3 L0,5 L-1.3,1.3 L-5,0 L-1.3,-1.3 Z";
const STAR_Y = LAYOUT.top - LAYOUT.starOffset;
/** The guide line starts just below the star. */
const GUIDE_Y = STAR_Y + 4;

export default function ClusterLanes({
  snapshot,
  onOpenPaper,
}: ClusterLanesProps) {
  const { parentRef, width } = useParentSize({
    debounceTime: 60,
    ignoreDimensions: ["height", "top", "left"],
  });
  const [mode, setMode] = useState<LineageMode>("hover");
  const [activeId, setActiveId] = useState<string | null>(null);
  const { tooltipData, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<PlacedPaper>();
  // Portal the tooltip so the horizontal scroll container does not clip it.
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
    zIndex: 40,
  });

  const labelWidth = width > 0 && width < 640 ? 124 : 188;
  const plotWidth = Math.max(MIN_PLOT_WIDTH, Math.floor(width - labelWidth));

  const gameChangerIds = useMemo(() => {
    const ids = new Set(
      snapshot.papers.filter((p) => p.gameChanger).map((p) => p.id),
    );
    for (const g of snapshot.documents.narrative?.gameChangers ?? [])
      ids.add(g.paperId);
    return ids;
  }, [snapshot.papers, snapshot.documents.narrative]);

  const layout = useMemo(
    () =>
      computeTimelineLayout({
        papers: snapshot.papers,
        clusters: snapshot.clusters,
        edges: snapshot.edges,
        eras: snapshot.documents.narrative?.eras ?? [],
        width: plotWidth,
        colorOf: (c) => colorSlotVar(c.color),
      }),
    [
      snapshot.papers,
      snapshot.clusters,
      snapshot.edges,
      snapshot.documents.narrative,
      plotWidth,
    ],
  );

  const laneColor = useMemo(
    () => new Map(layout.lanes.map((l) => [l.idx, l.color])),
    [layout.lanes],
  );
  const laneLabel = useMemo(
    () => new Map(layout.lanes.map((l) => [l.idx, l.label])),
    [layout.lanes],
  );

  const connected = useMemo(() => {
    if (!activeId) return null;
    const ids = new Set<string>([activeId]);
    for (const e of layout.edges) {
      if (e.source === activeId) ids.add(e.target);
      if (e.target === activeId) ids.add(e.source);
    }
    return ids;
  }, [activeId, layout.edges]);

  const xScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: layout.domain,
        range: [LAYOUT.padX, plotWidth - LAYOUT.padX],
      }),
    [layout.domain, plotWidth],
  );

  // Paint big circles first so small ones sit on top...
  const drawOrder = useMemo(
    () =>
      [...layout.placed].sort(
        (a, b) => b.r - a.r || a.paper.rank - b.paper.rank,
      ),
    [layout.placed],
  );
  // ...but tab through papers lane by lane, oldest first.
  const focusOrder = useMemo(() => {
    const laneRank = new Map(layout.lanes.map((l, i) => [l.idx, i]));
    return [...layout.placed].sort(
      (a, b) => (laneRank.get(a.laneIdx) ?? 0) - (laneRank.get(b.laneIdx) ?? 0) || a.t - b.t || a.paper.rank - b.paper.rank,
    );
  }, [layout.placed, layout.lanes]);
  const visibleEdges =
    mode === "all"
      ? layout.edges
      : activeId
        ? layout.edges.filter(
            (e) => e.source === activeId || e.target === activeId,
          )
        : [];

  const activate = useCallback(
    (p: PlacedPaper) => {
      setActiveId(p.paper.id);
      showTooltip({ tooltipData: p, tooltipLeft: p.x, tooltipTop: p.y });
    },
    [showTooltip],
  );
  const deactivate = useCallback(() => {
    setActiveId(null);
    hideTooltip();
  }, [hideTooltip]);

  const yearSpan = layout.years.length - 1;
  const labelStride = Math.max(
    1,
    Math.ceil((yearSpan * 44) / Math.max(1, plotWidth - 2 * LAYOUT.padX)),
  );
  const tickYears = layout.years
    .slice(0, -1)
    .filter((_, i) => i % labelStride === 0);
  const years = `${layout.domain[0]}–${layout.domain[1] - 1}`;

  return (
    <section
      className="border-border/70 bg-card overflow-hidden rounded-xl border shadow-sm"
      aria-label="Timeline"
    >
      <header className="border-border/60 flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-xs">
          <span className="text-foreground tabular font-medium">
            {layout.lanes.reduce((sum, l) => sum + l.size, 0)}
          </span>{" "}
          papers across{" "}
          <span className="text-foreground tabular font-medium">
            {layout.lanes.length}
          </span>{" "}
          {layout.lanes.length === 1 ? "cluster" : "clusters"},{" "}
          <span className="tabular">{years}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Legend />
          {layout.edges.length > 0 ? (
            <div className="flex items-center gap-2">
              <span
                className="text-muted-foreground text-xs"
                id="lineage-mode-label"
              >
                Lineage
              </span>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                value={mode}
                onValueChange={(v) => v && setMode(v as LineageMode)}
                aria-labelledby="lineage-mode-label"
              >
                <ToggleGroupItem value="hover" className="h-7 px-2.5 text-xs">
                  On hover
                </ToggleGroupItem>
                <ToggleGroupItem value="all" className="h-7 px-2.5 text-xs">
                  All
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          ) : null}
        </div>
      </header>

      <div
        ref={parentRef}
        className="relative overflow-x-auto overscroll-x-contain"
      >
        {width > 0 ? (
          <div
            className="relative flex"
            style={{ width: labelWidth + plotWidth, height: layout.height }}
          >
            {/* Lane labels stay pinned while the plot scrolls on small screens. */}
            <div
              className="bg-card border-border/60 sticky left-0 z-10 shrink-0 border-r"
              style={{ width: labelWidth }}
            >
              {layout.lanes.map((lane, i) => (
                <div
                  key={lane.idx}
                  className={cn(
                    "absolute inset-x-0 flex flex-col justify-center gap-1 px-2.5 sm:px-4",
                    i > 0 && "border-border/60 border-t",
                  )}
                  style={{ top: lane.y, height: lane.height }}
                >
                  <span className="flex min-w-0 items-start gap-1.5 sm:gap-2">
                    <span
                      aria-hidden
                      className="mt-[5px] size-2 shrink-0 rounded-full ring-2 ring-[color-mix(in_oklch,currentColor,transparent_88%)]"
                      style={{ background: lane.color }}
                    />
                    <span
                      className="text-foreground/90 line-clamp-3 text-[11.5px] leading-4 font-medium break-words sm:line-clamp-2 sm:text-[12px]"
                      title={lane.label}
                    >
                      {lane.label}
                    </span>
                  </span>
                  <span className="text-muted-foreground tabular pl-3.5 text-[11px] leading-4 sm:pl-4">
                    {lane.size === lane.total
                      ? `${lane.size} ${lane.size === 1 ? "paper" : "papers"}`
                      : `${lane.size} of ${lane.total} dated`}
                  </span>
                </div>
              ))}
            </div>

            <div
              ref={containerRef}
              className="relative shrink-0"
              style={{ width: plotWidth }}
              onMouseLeave={deactivate}
            >
              <svg
                width={plotWidth}
                height={layout.height}
                className="block overflow-visible"
                role="group"
                aria-label="Papers over time by cluster"
              >
                {/* Era bands */}
                {layout.eras.map((era, i) => (
                  <g key={`${era.label}-${era.startYear}`}>
                    <rect
                      x={era.x0}
                      y={0}
                      width={era.x1 - era.x0}
                      height={layout.plotBottom}
                      fill="var(--muted)"
                      fillOpacity={i % 2 === 0 ? 0.55 : 0.2}
                    >
                      <title>{`${era.label} (${era.startYear}–${era.endYear ?? "now"}): ${era.summary}`}</title>
                    </rect>
                    <line
                      x1={era.x0}
                      x2={era.x0}
                      y1={0}
                      y2={layout.plotBottom}
                      stroke="var(--border)"
                    />
                    {era.shortLabel ? (
                      <text
                        x={era.x0 + 8}
                        y={17}
                        className="fill-muted-foreground text-[11px] font-medium"
                        pointerEvents="none"
                      >
                        {era.shortLabel}
                      </text>
                    ) : null}
                  </g>
                ))}

                {/* Year grid */}
                {layout.years.map((y) => (
                  <line
                    key={y}
                    x1={xScale(y)}
                    x2={xScale(y)}
                    y1={layout.plotTop - 6}
                    y2={layout.plotBottom}
                    stroke="var(--border)"
                    strokeDasharray="2 4"
                  />
                ))}

                {/* Lane separators */}
                {layout.lanes.map((lane, i) =>
                  i > 0 ? (
                    <line
                      key={lane.idx}
                      x1={0}
                      x2={plotWidth}
                      y1={lane.y}
                      y2={lane.y}
                      stroke="var(--border)"
                    />
                  ) : null,
                )}
                <line
                  x1={0}
                  x2={plotWidth}
                  y1={layout.plotTop}
                  y2={layout.plotTop}
                  stroke="var(--border)"
                />

                {/* Game-changer guides */}
                {layout.placed
                  .filter((p) => gameChangerIds.has(p.paper.id))
                  .map((p) => {
                    const color =
                      laneColor.get(p.laneIdx) ?? "var(--muted-foreground)";
                    const dim =
                      connected !== null && !connected.has(p.paper.id);
                    return (
                      <g
                        key={`gc-${p.paper.id}`}
                        className="transition-opacity duration-150 motion-reduce:transition-none"
                        opacity={dim ? 0.3 : 1}
                      >
                        <line
                          x1={p.x}
                          x2={p.x}
                          y1={GUIDE_Y}
                          y2={p.y - p.r - 4}
                          stroke={color}
                          strokeOpacity={0.45}
                          strokeDasharray="1.5 3"
                        />
                        <path
                          d={STAR}
                          transform={`translate(${p.x},${STAR_Y})`}
                          fill={color}
                        />
                      </g>
                    );
                  })}

                {/* Lineage */}
                <g fill="none" pointerEvents="none">
                  {visibleEdges.map((e) => {
                    const source = layout.byId.get(e.source);
                    const color = source
                      ? laneColor.get(source.laneIdx)
                      : undefined;
                    const lit =
                      activeId !== null &&
                      (e.source === activeId || e.target === activeId);
                    return (
                      <path
                        key={e.id}
                        d={e.path}
                        stroke={color ?? "var(--muted-foreground)"}
                        strokeWidth={lit ? 1.5 : 1.1}
                        strokeOpacity={lit ? 0.9 : activeId ? 0.12 : 0.38}
                        strokeLinecap="round"
                        className="transition-[stroke-opacity] duration-150 motion-reduce:transition-none"
                      />
                    );
                  })}
                </g>

                {/* Papers: paint layer, in draw order. */}
                <g aria-hidden pointerEvents="none">
                  {drawOrder.map((p) => {
                    const color = laneColor.get(p.laneIdx) ?? "var(--muted-foreground)";
                    const gc = gameChangerIds.has(p.paper.id);
                    const dim = connected !== null && !connected.has(p.paper.id);
                    const active = activeId === p.paper.id;
                    return (
                      <g
                        key={p.paper.id}
                        transform={`translate(${p.x},${p.y})`}
                        className="transition-opacity duration-150 motion-reduce:transition-none"
                        opacity={dim ? 0.22 : 1}
                      >
                        {gc ? <circle r={p.r + 3} fill="none" stroke={color} strokeWidth={1.25} /> : null}
                        <circle
                          r={p.r}
                          fill={color}
                          fillOpacity={active ? 1 : 0.82}
                          stroke="var(--card)"
                          strokeWidth={active ? 2 : 1.25}
                        />
                        {p.paper.loggedEntryId ? <circle r={Math.max(1.4, p.r * 0.3)} fill="var(--card)" /> : null}
                      </g>
                    );
                  })}
                </g>

                {/* Papers: hit and focus layer, lane by lane in time order. */}
                <g>
                  {focusOrder.map((p) => {
                    const gc = gameChangerIds.has(p.paper.id);
                    const label = `${p.paper.title}. ${shortDate(p.paper)}. ${formatCount(p.paper.citationCount)} citations.${gc ? " Game-changer." : ""}${p.paper.loggedEntryId ? " In your log." : ""}`;
                    return (
                      <g
                        key={p.paper.id}
                        transform={`translate(${p.x},${p.y})`}
                        tabIndex={0}
                        role="button"
                        aria-label={label}
                        className="group cursor-pointer outline-none"
                        onMouseEnter={() => activate(p)}
                        onFocus={() => activate(p)}
                        onBlur={deactivate}
                        onClick={() => onOpenPaper(p.paper.id)}
                        onKeyDown={(e: KeyboardEvent<SVGGElement>) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenPaper(p.paper.id);
                          } else if (e.key === "Escape") {
                            deactivate();
                          }
                        }}
                      >
                        {/* Packing keeps circles apart, so a hit area of r + gap/2 never overlaps a neighbour. */}
                        <circle r={p.r + LAYOUT.gap / 2} fill="transparent" />
                        <circle
                          r={p.r + 5}
                          fill="none"
                          stroke="var(--ring)"
                          strokeWidth={2}
                          pointerEvents="none"
                          className="opacity-0 group-focus-visible:opacity-100"
                        />
                      </g>
                    );
                  })}
                </g>

                <AxisBottom
                  top={layout.plotBottom}
                  scale={xScale}
                  tickValues={tickYears.map((y) => y + 0.5)}
                  tickFormat={(v) => String(Math.floor(Number(v)))}
                  hideTicks
                  stroke="var(--border)"
                  tickLabelProps={() => ({
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                    textAnchor: "middle",
                    dy: "0.9em",
                    className: "tabular-nums",
                  })}
                />
              </svg>

              {layout.overflow.map((marker) => (
                <OverflowButton
                  key={marker.id}
                  marker={marker}
                  color={laneColor.get(marker.laneIdx) ?? "var(--muted-foreground)"}
                  onOpenPaper={onOpenPaper}
                />
              ))}

              {tooltipOpen && tooltipData ? (
                <TooltipInPortal
                  key={tooltipData.paper.id}
                  left={tooltipData.x}
                  top={tooltipData.y}
                  offsetLeft={tooltipData.r + 8}
                  offsetTop={tooltipData.r + 8}
                  unstyled
                  applyPositionStyle
                  className="bg-popover text-popover-foreground border-border/70 pointer-events-none flex w-[264px] max-w-[calc(100vw-24px)] flex-col gap-1.5 rounded-lg border px-3 py-2.5 shadow-md"
                >
                  <PaperTooltip
                    placed={tooltipData}
                    color={laneColor.get(tooltipData.laneIdx) ?? null}
                    clusterLabel={
                      tooltipData.laneIdx >= 0
                        ? (laneLabel.get(tooltipData.laneIdx) ?? null)
                        : null
                    }
                    gameChanger={gameChangerIds.has(tooltipData.paper.id)}
                  />
                </TooltipInPortal>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="h-[320px]" />
        )}
      </div>
    </section>
  );
}

/** "+N" for papers that did not fit a dense lane. Opens on hover or click. */
function OverflowButton({
  marker,
  color,
  onOpenPaper,
}: {
  marker: OverflowMarker;
  color: string;
  onOpenPaper: (paperId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };
  useEffect(() => cancelClose, []);
  const n = marker.papers.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${n} more ${n === 1 ? "paper" : "papers"} here`}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          className="bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:text-foreground absolute z-[1] flex h-4 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border px-1.5 text-[10px] leading-none font-medium tabular-nums shadow-xs outline-none focus-visible:ring-[3px]"
          style={{ left: marker.x, top: marker.y, borderColor: `color-mix(in oklch, ${color}, transparent 45%)` }}
        >
          +{n}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-72 gap-0 p-1"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-[11px]">
          {n} more {n === 1 ? "paper" : "papers"} with less influence
        </p>
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {marker.papers.map((paper) => (
            <li key={paper.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenPaper(paper.id);
                }}
                className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none"
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className="min-w-0 flex-1 truncate text-[12px]">{paper.title}</span>
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{shortDate(paper)}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function PaperTooltip({
  placed,
  color,
  clusterLabel,
  gameChanger,
}: {
  placed: PlacedPaper;
  color: string | null;
  clusterLabel: string | null;
  gameChanger: boolean;
}) {
  const { paper } = placed;
  const extras = [
    gameChanger ? "Game-changer" : null,
    paper.loggedEntryId ? "In your log" : null,
  ].filter(Boolean) as string[];
  return (
    <>
      {clusterLabel ? (
        <ClusterChip
          color={color}
          label={clusterLabel}
          className="text-[11px]"
        />
      ) : null}
      <p className="line-clamp-3 text-[13px] leading-[18px] font-medium">
        {paper.title}
      </p>
      <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
        <span className="tabular">{shortDate(paper)}</span>
        <span className="bg-border h-3 w-px" aria-hidden />
        <span className="tabular">
          {formatCount(paper.citationCount)} citations
        </span>
        {paper.venue ? (
          <>
            <span className="bg-border h-3 w-px" aria-hidden />
            <span className="truncate">{paper.venue}</span>
          </>
        ) : null}
      </div>
      {extras.length > 0 ? (
        <p className="text-foreground/70 text-[11px]">{extras.join(", ")}</p>
      ) : null}
    </>
  );
}

function Legend() {
  return (
    <ul
      className="text-muted-foreground flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px]"
      aria-label="Legend"
    >
      <li className="flex items-center gap-1.5">
        <svg width="20" height="12" aria-hidden>
          <circle
            cx="4"
            cy="6"
            r="2.5"
            fill="currentColor"
            fillOpacity={0.55}
          />
          <circle cx="14" cy="6" r="5" fill="currentColor" fillOpacity={0.55} />
        </svg>
        Influence
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <circle
            cx="7"
            cy="7"
            r="3.5"
            fill="currentColor"
            fillOpacity={0.55}
          />
          <circle
            cx="7"
            cy="7"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.1}
          />
        </svg>
        Game-changer
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden>
          <circle cx="6" cy="6" r="5" fill="currentColor" fillOpacity={0.55} />
          <circle cx="6" cy="6" r="1.6" fill="var(--card)" />
        </svg>
        In your log
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="18" height="12" aria-hidden>
          <path
            d="M1,10 C1,2 17,2 17,10"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
          />
        </svg>
        Builds on
      </li>
    </ul>
  );
}
