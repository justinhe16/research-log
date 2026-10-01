import Link from "next/link";
import { LibraryBigIcon } from "lucide-react";

import { NavTabs } from "@/components/nav-tabs";
import { SettingsMenu } from "@/components/settings-menu";
import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader() {
  return (
    <header className="site-header bg-background/95 text-foreground border-border/60 supports-[backdrop-filter]:bg-background/88 sticky top-0 z-30 border-b backdrop-blur-md">
      <div className="mx-auto flex h-13 w-full max-w-6xl items-center gap-2.5 px-4 sm:px-6">
        <Link
          href="/logs"
          className="focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px]"
        >
          <LibraryBigIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="font-heading hidden text-[13px] font-semibold tracking-[-0.018em] min-[420px]:inline">
            Research Log
          </span>
        </Link>
        <span aria-hidden className="bg-border mx-1 h-3.5 w-px" />
        <NavTabs />
        <div className="ml-auto flex items-center gap-0.5">
          <ThemeToggle />
          <SettingsMenu />
        </div>
      </div>
    </header>
  );
}
