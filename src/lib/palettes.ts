/**
 * Color palettes, orthogonal to light/dark mode. Each id maps to a pair of
 * `[data-palette="<id>"]` token blocks in globals.css; next-themes keeps owning
 * the `.dark` class, this owns the `data-palette` attribute on <html>.
 */
export const PALETTES = [
  { id: "graphite", label: "Classic", description: "The original cool neutrals" },
  { id: "ultraviolet", label: "Ultraviolet", description: "Lavender and electric violet" },
  { id: "ember", label: "Ember", description: "Warm peach and burnt orange" },
  { id: "forest", label: "Forest", description: "Moss and deep emerald" },
  { id: "lagoon", label: "Lagoon", description: "Sea-glass teal and deep ocean" },
  { id: "neon", label: "Neon", description: "Hot magenta with cyan" },
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];

export const DEFAULT_PALETTE: PaletteId = "graphite";
export const PALETTE_STORAGE_KEY = "palette";

export function isPaletteId(value: unknown): value is PaletteId {
  return PALETTES.some((p) => p.id === value);
}

/** Runs in <head> before first paint so a stored palette never flashes the default. */
export const PALETTE_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  PALETTE_STORAGE_KEY,
)});if(${JSON.stringify(PALETTES.map((p) => p.id))}.indexOf(p)>-1)document.documentElement.setAttribute("data-palette",p)}catch(e){}})()`;
