import { LibraryBigIcon } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader() {
  return (
    <header className="bg-background/70 border-border/60 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 border-b backdrop-blur-md">
      <div className="mx-auto flex h-13 w-full max-w-6xl items-center gap-2.5 px-4 sm:px-6">
        <LibraryBigIcon className="text-muted-foreground size-4 shrink-0" />
        <h1 className="font-heading text-[13px] font-semibold">Research Log</h1>
        <span aria-hidden className="bg-border hidden h-3.5 w-px sm:block" />
        <p className="text-muted-foreground hidden truncate text-xs sm:block">
          Everything you meant to read — summarized, tagged, and searchable.
        </p>
        <div className="ml-auto flex items-center">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
