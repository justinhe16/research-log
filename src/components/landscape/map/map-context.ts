"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { Edge, Node } from "@xyflow/react";

import type { EdgeKind, PaperLite } from "@/lib/landscape/types";

export type PaperNodeData = {
  paper: PaperLite;
  /** CSS color for the paper's cluster (a --chart-N var), or a neutral fallback. */
  color: string;
  clusterLabel: string | null;
  isNew: boolean;
  /** Label visibility per zoom band, from the layout's collision culling. */
  labelBands: boolean[];
};
export type PaperNodeType = Node<PaperNodeData, "paper">;

export type PaperEdgeData = {
  kind: EdgeKind;
  /** Circle centers and radii from the static layout. */
  sx: number;
  sy: number;
  sr: number;
  tx: number;
  ty: number;
  tr: number;
};
export type PaperEdgeType = Edge<PaperEdgeData, "paper">;

type HighlightState = {
  /** Hovered, focused or searched-for paper. */
  activeId: string | null;
  /** Papers joined to the active one by a visible edge (includes the active one). */
  neighbors: ReadonlySet<string>;
};

/**
 * A tiny external store for the hover highlight. Nodes and edges subscribe
 * with selectors that return primitives, so a hover only re-renders the
 * elements whose state actually changes.
 */
export function createHighlightStore() {
  let state: HighlightState = { activeId: null, neighbors: new Set() };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: HighlightState) {
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type HighlightStore = ReturnType<typeof createHighlightStore>;

export const HighlightStoreContext = createContext<HighlightStore | null>(null);

function useHighlightSelector<T>(select: (s: HighlightState) => T): T {
  const store = useContext(HighlightStoreContext);
  if (!store) throw new Error("HighlightStoreContext missing");
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}

export type NodeEmphasis = "active" | "neighbor" | "dimmed" | "none";
export function useNodeEmphasis(id: string): NodeEmphasis {
  return useHighlightSelector((s) =>
    s.activeId === null ? "none" : s.activeId === id ? "active" : s.neighbors.has(id) ? "neighbor" : "dimmed",
  );
}

export type EdgeEmphasis = "incident" | "dimmed" | "none";
export function useEdgeEmphasis(source: string, target: string): EdgeEmphasis {
  return useHighlightSelector((s) =>
    s.activeId === null ? "none" : s.activeId === source || s.activeId === target ? "incident" : "dimmed",
  );
}

export function useActivePaperId(): string | null {
  return useHighlightSelector((s) => s.activeId);
}
