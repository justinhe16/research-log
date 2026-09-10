"use client";

import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Icon swap is done in CSS off the `.dark` class next-themes writes on <html>,
 * so there is nothing to hydrate and no first-paint flash of the wrong icon.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Toggle light and dark theme"
      title="Toggle theme"
      className="text-muted-foreground hover:text-foreground transition-colors duration-150"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <SunIcon className="dark:hidden" />
      <MoonIcon className="hidden dark:block" />
    </Button>
  );
}
