import { LibraryBigIcon } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader() {
  return (
    <header className="bg-background/80 sticky top-0 z-30 border-b backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <LibraryBigIcon className="text-muted-foreground size-4 shrink-0" />
        <h1 className="font-heading text-sm font-semibold tracking-tight">Research Log</h1>
        <p className="text-muted-foreground hidden truncate text-xs sm:block">
          Everything you meant to read — summarized, tagged, and searchable.
        </p>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
