"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";

import { DEFAULT_PALETTE, PALETTE_STORAGE_KEY, isPaletteId, type PaletteId } from "@/lib/palettes";

type PaletteContextValue = { palette: PaletteId; setPalette: (p: PaletteId) => void };

const PaletteContext = createContext<PaletteContextValue | null>(null);

function readStored(): PaletteId {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPaletteId(stored) ? stored : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

/** Nothing rendered depends on `palette` until the settings popover opens, so the lazy read can't mismatch hydration. */
export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [palette, setState] = useState<PaletteId>(() =>
    typeof window === "undefined" ? DEFAULT_PALETTE : readStored(),
  );

  // The inline <head> script sets the attribute on hard loads; this re-applies it after
  // Strict Mode's dev remount resets <html> attributes. A no-op in production.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-palette", palette);
  }, [palette]);

  const setPalette = useCallback((p: PaletteId) => {
    setState(p);
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, p);
    } catch {
      // Storage blocked: the choice still applies for this visit.
    }
  }, []);

  return <PaletteContext.Provider value={{ palette, setPalette }}>{children}</PaletteContext.Provider>;
}

export function usePalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error("usePalette must be used within PaletteProvider");
  return ctx;
}
