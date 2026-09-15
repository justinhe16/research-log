"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type MiniMapNodeProps,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { CheckIcon, ListIcon, MoveIcon } from "lucide-react";
import "@xyflow/react/dist/style.css";
import "./landscape-map.css";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { EdgeKind, LandscapeSnapshot, PaperLite } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor } from "../cluster-colors";
import { computeLayout, type LayoutResult } from "./layout";
import {
  createHighlightStore,
  HighlightStoreContext,
  type PaperEdgeType,
  type PaperNodeData,
  type PaperNodeType,
} from "./map-context";
import { ClusterLegend, type LegendCluster } from "./map-legend";
import { MapSearch } from "./map-search";
import { MAP_FRAME_CLASS, MapSkeleton } from "./map-skeleton";
import { MapTooltip } from "./map-tooltip";
import { PaperEdge } from "./paper-edge";
import { PaperNode } from "./paper-node";

export type LandscapeMapProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

const NODE_TYPES = { paper: PaperNode };
const EDGE_TYPES = { paper: PaperEdge };
const NEUTRAL = "var(--muted-foreground)";
const MAX_ZOOM_FIT = 1.1;
/** Fit padding keeps papers clear of the toolbar, legend and minimap. */
const FIT_WIDE = { maxZoom: MAX_ZOOM_FIT, padding: { top: "84px", right: "344px", bottom: "48px", left: "72px" } } as const;
const FIT_NARROW = { maxZoom: MAX_ZOOM_FIT, padding: { top: "128px", right: "60px", bottom: "72px", left: "60px" } } as const;
/** Above this many papers, only elements inside the viewport are rendered. */
const VIRTUALIZE_AFTER = 150;
const EDGE_ORDER: Record<EdgeKind, number> = { similar: 0, cites: 1, builds_on: 2 };

const EDGE_TOGGLES: { kind: EdgeKind; label: string; glyph: React.ReactNode }[] = [
  {
    kind: "builds_on",
    label: "Builds on",
    glyph: (
      <svg viewBox="0 0 16 8" className="h-2 w-4" aria-hidden>
        <path d="M1 4h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M15 4l-4.5 3V1z" fill="currentColor" />
      </svg>
    ),
  },
  {
    kind: "cites",
    label: "Cites",
    glyph: (
      <svg viewBox="0 0 16 8" className="h-2 w-4" aria-hidden>
        <path d="M1 4h14" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    kind: "similar",
    label: "Similar",
    glyph: (
      <svg viewBox="0 0 16 8" className="h-2 w-4" aria-hidden>
        <path d="M1.5 4h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="0.1 3.4" />
      </svg>
    ),
  },
];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// --- layout: computed once per search, after first paint --------------------------

const layoutCache = new Map<string, LayoutResult>();
const layoutKey = (s: LandscapeSnapshot) => `${s.search.id}:${s.papers.length}:${s.edges.length}:${s.clusters?.length ?? 0}`;

function useSnapshotLayout(snapshot: LandscapeSnapshot): LayoutResult | null {
  const key = layoutKey(snapshot);
  const [state, setState] = useState<{ key: string; layout: LayoutResult } | null>(() => {
    const cached = layoutCache.get(key);
    return cached ? { key, layout: cached } : null;
  });

  useEffect(() => {
    if (layoutCache.has(key)) {
      const cached = layoutCache.get(key)!;
      startTransition(() => setState((s) => (s?.key === key ? s : { key, layout: cached })));
      return;
    }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const layout = computeLayout(snapshot.papers, snapshot.clusters ?? [], snapshot.edges);
      layoutCache.set(key, layout);
      startTransition(() => setState({ key, layout }));
    };
    const idle = typeof window.requestIdleCallback === "function";
    const handle = idle ? window.requestIdleCallback(run, { timeout: 300 }) : window.setTimeout(run, 16);
    return () => {
      cancelled = true;
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [key, snapshot]);

  return state?.key === key ? state.layout : null;
}

export default function LandscapeMap(props: LandscapeMapProps) {
  const layout = useSnapshotLayout(props.snapshot);
  if (!layout) return <MapSkeleton />;
  return (
    <ReactFlowProvider>
      <MapCanvas {...props} layout={layout} />
    </ReactFlowProvider>
  );
}

function MiniMapCircle({ x, y, width, color }: MiniMapNodeProps) {
  return <circle cx={x + width / 2} cy={y + width / 2} r={Math.max(width / 2, 6)} style={{ fill: color }} />;
}

// --- canvas ---------------------------------------------------------------------------

function MapCanvas({ snapshot, onOpenPaper, layout }: LandscapeMapProps & { layout: LayoutResult }) {
  const { resolvedTheme } = useTheme();
  const rf = useReactFlow<PaperNodeType, PaperEdgeType>();
  const small = useMediaQuery("(max-width: 639px)");
  const wide = useMediaQuery("(min-width: 768px)");
  const fitOptions = wide ? FIT_WIDE : FIT_NARROW;
  const containerRef = useRef<HTMLDivElement>(null);
  const clusters = useMemo(() => snapshot.clusters ?? [], [snapshot.clusters]);
  const { papers, edges: rawEdges } = snapshot;

  const [edgeKinds, setEdgeKinds] = useState<EdgeKind[]>(["builds_on"]);
  const [hiddenClusters, setHiddenClusters] = useState<ReadonlySet<number>>(new Set());
  const [exploring, setExploring] = useState(false);
  const [wheelHint, setWheelHint] = useState(false);
  const wheelTimer = useRef<number | null>(null);

  const newPaperIds = useMemo(() => new Set(snapshot.documents.diff?.newPaperIds ?? []), [snapshot.documents.diff]);
  const clusterByIdx = useMemo(() => new Map(clusters.map((c) => [c.idx, c])), [clusters]);
  const colorOf = useCallback((p: PaperLite) => clusterColor(clusters, p.clusterIdx) ?? NEUTRAL, [clusters]);
  const groupOf = useCallback(
    (p: PaperLite) => (p.clusterIdx !== null && clusterByIdx.has(p.clusterIdx) ? p.clusterIdx : -1),
    [clusterByIdx],
  );

  // --- nodes + edges ----------------------------------------------------------------
  const dataById = useMemo(() => {
    const map = new Map<string, PaperNodeData>();
    for (const p of papers) {
      map.set(p.id, {
        paper: p,
        color: colorOf(p),
        clusterLabel: p.clusterIdx !== null ? (clusterByIdx.get(p.clusterIdx)?.label ?? null) : null,
        isNew: newPaperIds.has(p.id),
        labelBands: layout.labels.map((set) => set.has(p.id)),
      });
    }
    return map;
  }, [papers, colorOf, clusterByIdx, newPaperIds, layout]);

  const nodes = useMemo<PaperNodeType[]>(
    () =>
      papers.map((p) => {
        const pos = layout.positions.get(p.id)!;
        return {
          id: p.id,
          type: "paper",
          position: { x: pos.x, y: pos.y },
          width: pos.size,
          height: pos.size,
          hidden: hiddenClusters.has(groupOf(p)),
          ariaLabel: p.year ? `${p.title}, ${p.year}` : p.title,
          data: dataById.get(p.id)!,
        };
      }),
    [papers, layout, hiddenClusters, groupOf, dataById],
  );

  const edges = useMemo<PaperEdgeType[]>(() => {
    const kinds = new Set(edgeKinds);
    const seen = new Set<string>();
    const out: PaperEdgeType[] = [];
    for (const e of rawEdges) {
      if (!kinds.has(e.kind) || e.source === e.target) continue;
      const s = layout.positions.get(e.source);
      const t = layout.positions.get(e.target);
      if (!s || !t) continue;
      const id = `${e.kind}:${e.source}->${e.target}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        type: "paper",
        source: e.source,
        target: e.target,
        focusable: false,
        selectable: false,
        zIndex: EDGE_ORDER[e.kind],
        data: { kind: e.kind, sx: s.x, sy: s.y, sr: s.size / 2, tx: t.x, ty: t.y, tr: t.size / 2 },
      });
    }
    return out.sort((a, b) => EDGE_ORDER[a.data!.kind] - EDGE_ORDER[b.data!.kind]);
  }, [rawEdges, edgeKinds, layout]);

  // --- highlight store (no React state, so hovering never re-renders the canvas) ------
  const [store] = useState(createHighlightStore);
  const hoverRef = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const edgesRef = useRef(edges);

  const syncHighlight = useCallback(() => {
    const activeId = hoverRef.current ?? focusRef.current;
    const neighbors = new Set<string>();
    if (activeId) {
      neighbors.add(activeId);
      for (const e of edgesRef.current) {
        if (e.source === activeId) neighbors.add(e.target);
        else if (e.target === activeId) neighbors.add(e.source);
      }
    }
    const prev = store.get();
    if (prev.activeId === activeId && prev.neighbors.size === neighbors.size && [...neighbors].every((id) => prev.neighbors.has(id))) return;
    store.set({ activeId, neighbors });
  }, [store]);

  useEffect(() => {
    edgesRef.current = edges;
    syncHighlight();
  }, [edges, syncHighlight]);

  const setHover = useCallback((id: string | null) => {
    hoverRef.current = id;
    syncHighlight();
  }, [syncHighlight]);
  const setFocus = useCallback((id: string | null) => {
    focusRef.current = id;
    syncHighlight();
  }, [syncHighlight]);

  // --- zoom var for constant-size labels -----------------------------------------------
  const setZoomVar = useCallback((zoom: number) => {
    containerRef.current?.style.setProperty("--zoom", String(zoom));
  }, []);

  // --- legend + focus -----------------------------------------------------------------
  const legend = useMemo<LegendCluster[]>(() => {
    const counts = new Map<number, number>();
    for (const p of papers) counts.set(groupOf(p), (counts.get(groupOf(p)) ?? 0) + 1);
    const items: LegendCluster[] = clusters
      .filter((c) => counts.has(c.idx))
      .map((c) => ({ idx: c.idx, label: c.label, color: clusterColor(clusters, c.idx) ?? NEUTRAL, count: counts.get(c.idx)! }));
    if (counts.has(-1) && items.length > 0) items.push({ idx: -1, label: "Unclustered", color: NEUTRAL, count: counts.get(-1)! });
    return items;
  }, [papers, clusters, groupOf]);

  const fly = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: fitOptions.padding, maxZoom: MAX_ZOOM_FIT, duration: prefersReducedMotion() ? 0 : 450 });
    },
    [rf, fitOptions],
  );

  const focusCluster = useCallback(
    (idx: number) => {
      setFocus(null);
      fly(papers.filter((p) => groupOf(p) === idx).map((p) => p.id));
    },
    [fly, papers, groupOf, setFocus],
  );

  const toggleCluster = useCallback((idx: number) => {
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const focusPaper = useCallback(
    (id: string) => {
      const paper = papers.find((p) => p.id === id);
      if (!paper) return;
      const g = groupOf(paper);
      const wasHidden = hiddenClusters.has(g);
      if (wasHidden) toggleCluster(g);
      setFocus(id);
      // An un-hidden cluster needs a commit and a paint before fitView can see it.
      if (wasHidden) requestAnimationFrame(() => requestAnimationFrame(() => fly([id])));
      else fly([id]);
    },
    [papers, groupOf, hiddenClusters, toggleCluster, setFocus, fly],
  );

  const legendProps = {
    clusters: legend,
    hidden: hiddenClusters,
    onFocus: focusCluster,
    onToggle: toggleCluster,
    onShowAll: () => setHiddenClusters(new Set()),
  };

  const halos = useMemo(
    () =>
      legend.length > 1
        ? layout.halos
            .filter((h) => h.group !== -1 && !hiddenClusters.has(h.group))
            .map((h) => ({ ...h, label: clusterByIdx.get(h.group)?.label ?? "", color: clusterColor(clusters, h.group) ?? NEUTRAL }))
        : [],
    [legend.length, layout.halos, hiddenClusters, clusterByIdx, clusters],
  );

  const nodeIdFromEvent = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>(".react-flow__node") : null;
    return el?.dataset.id ?? null;
  };

  const canPan = !small || exploring;

  return (
    <HighlightStoreContext.Provider value={store}>
      <div
        ref={containerRef}
        className={MAP_FRAME_CLASS}
        onKeyDown={(e) => {
          const id = nodeIdFromEvent(e.target);
          if (id && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.stopPropagation();
            onOpenPaper(id);
          } else if (e.key === "Escape" && focusRef.current) {
            setFocus(null);
          }
        }}
        onFocus={(e) => {
          const id = nodeIdFromEvent(e.target);
          if (id && e.target.matches(":focus-visible")) setFocus(id);
        }}
        onBlur={(e) => {
          if (nodeIdFromEvent(e.target) && focusRef.current === nodeIdFromEvent(e.target)) setFocus(null);
        }}
        onWheel={(e) => {
          if (small || e.ctrlKey || e.metaKey) return;
          if (!(e.target instanceof Element) || e.target.closest(".react-flow__panel")) return;
          setWheelHint(true);
          if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
          wheelTimer.current = window.setTimeout(() => setWheelHint(false), 1400);
        }}
      >
        <ReactFlow<PaperNodeType, PaperEdgeType>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode={resolvedTheme === "dark" ? "dark" : "light"}
          nodeOrigin={[0.5, 0.5]}
          fitView
          fitViewOptions={fitOptions}
          minZoom={0.2}
          maxZoom={3}
          onInit={(instance) => setZoomVar(instance.getZoom())}
          onMove={(_, viewport) => setZoomVar(viewport.zoom)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          autoPanOnNodeFocus
          onlyRenderVisibleElements={papers.length > VIRTUALIZE_AFTER}
          zoomOnScroll={false}
          panOnScroll={false}
          preventScrolling={false}
          zoomOnPinch={canPan}
          panOnDrag={canPan}
          zoomOnDoubleClick={false}
          attributionPosition="bottom-center"
          onNodeClick={(_, node) => onOpenPaper(node.id)}
          onNodeMouseEnter={(_, node) => setHover(node.id)}
          onNodeMouseLeave={() => setHover(null)}
          onPaneClick={() => setFocus(null)}
          ariaLabelConfig={{ "node.a11yDescription.default": "Press Enter to open the paper. Tab moves between papers." }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />

          <ViewportPortal>
            {halos.map((h) => (
              <div
                key={h.group}
                aria-hidden
                className="pointer-events-none absolute rounded-full"
                style={{
                  left: h.x - h.r,
                  top: h.y - h.r,
                  width: h.r * 2,
                  height: h.r * 2,
                  background: `color-mix(in oklab, ${h.color} 5%, transparent)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${h.color} 14%, transparent)`,
                }}
              >
                <span
                  className="absolute top-0 left-1/2 text-[12px] leading-4 font-medium tracking-[0.02em] whitespace-nowrap"
                  style={{
                    fontVariantCaps: "all-small-caps",
                    color: `color-mix(in oklab, ${h.color} 70%, var(--muted-foreground))`,
                    transform: "scale(calc(1 / var(--zoom, 1))) translate(-50%, calc(-100% - 4px))",
                    transformOrigin: "0 0",
                  }}
                >
                  {h.label}
                </span>
              </div>
            ))}
          </ViewportPortal>

          <Panel position="top-left" className="!m-3 flex max-w-[calc(100%-4.5rem)] flex-wrap items-center gap-2 md:max-w-[calc(100%-18rem)]">
            <MapSearch papers={papers} colorOf={colorOf} onSelect={focusPaper} className="w-full sm:w-56" />
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              spacing={0}
              value={edgeKinds}
              onValueChange={(v) => setEdgeKinds(v as EdgeKind[])}
              aria-label="Edges to show"
              className="bg-popover shadow-xs"
            >
              {EDGE_TOGGLES.map((t) => (
                <ToggleGroupItem
                  key={t.kind}
                  value={t.kind}
                  aria-label={`${t.label} edges`}
                  title={t.label}
                  className="text-muted-foreground data-[state=on]:text-foreground gap-1.5 text-xs"
                >
                  {t.glyph}
                  <span className="hidden sm:inline">{t.label}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Panel>

          <Panel position="top-right" className="!m-3 hidden max-h-[calc(100%-11rem)] w-64 flex-col md:flex">
            <div className="bg-popover/95 ring-foreground/10 min-h-0 overflow-y-auto rounded-lg p-2 shadow-sm ring-1 backdrop-blur-sm">
              <ClusterLegend {...legendProps} />
            </div>
          </Panel>

          <Panel position="top-right" className="!m-3 md:hidden">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Clusters and key" className="bg-popover shadow-xs">
                  <ListIcon />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="max-h-[60svh] w-64 overflow-y-auto p-2">
                <ClusterLegend {...legendProps} />
              </PopoverContent>
            </Popover>
          </Panel>

          {small ? (
            <Panel position="bottom-right" className="!m-3">
              <Button
                variant={exploring ? "default" : "outline"}
                size="sm"
                className={cn("text-xs shadow-xs", !exploring && "bg-popover")}
                onClick={() => setExploring((v) => !v)}
              >
                {exploring ? <CheckIcon data-icon="inline-start" /> : <MoveIcon data-icon="inline-start" />}
                {exploring ? "Done" : "Explore map"}
              </Button>
            </Panel>
          ) : null}

          <Controls showInteractive={false} position="bottom-left" className="!m-3" fitViewOptions={{ ...fitOptions, duration: 300 }} />
          <MiniMap<PaperNodeType>
            position="bottom-right"
            className="!m-3 hidden sm:block"
            pannable
            ariaLabel="Map overview"
            nodeColor={(n) => n.data.color}
            nodeComponent={MiniMapCircle}
            maskStrokeWidth={1}
          />

          <MapTooltip positions={layout.positions} dataById={dataById} />
        </ReactFlow>

        <div
          aria-hidden={!wheelHint}
          className={cn(
            "bg-foreground/80 text-background pointer-events-none absolute top-1/2 left-1/2 z-40 -translate-1/2 rounded-md px-3 py-1.5 text-xs transition-opacity duration-200 motion-reduce:transition-none",
            wheelHint ? "opacity-100" : "opacity-0",
          )}
        >
          Pinch, or hold Ctrl and scroll, to zoom
        </div>
      </div>
    </HighlightStoreContext.Provider>
  );
}

