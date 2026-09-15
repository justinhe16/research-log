"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenIcon, WaypointsIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/logs", label: "Logs", icon: BookOpenIcon },
  { href: "/landscape", label: "Landscape", icon: WaypointsIcon },
] as const;

/** Segmented primary navigation. A tab is current for its route and everything under it. */
export function NavTabs({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Primary" className={cn("bg-muted/70 flex items-center rounded-lg p-[3px]", className)}>
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors outline-none",
              "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              active
                ? "bg-background text-foreground dark:bg-input/40 shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={cn("size-3.5", active ? "opacity-80" : "opacity-60")} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
