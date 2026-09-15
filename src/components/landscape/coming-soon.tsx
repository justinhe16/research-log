import type { LucideIcon } from "lucide-react";

/** Placeholder body for tabs that land in a later wave. */
export function ComingSoon({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="border-border/70 bg-muted/15 relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border border-dashed px-6 py-20 text-center">
      <span className="bg-card border-border/70 text-muted-foreground flex size-9 items-center justify-center rounded-lg border shadow-sm">
        <Icon className="size-4" aria-hidden />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-sm text-xs leading-5">{body}</p>
      <span className="text-muted-foreground/80 mt-1 text-[11px] font-medium tracking-[0.06em] uppercase">In progress</span>
    </div>
  );
}
