import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Dashed empty / error panel, shared by the Landscape views. */
export function StateMessage({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border/70 flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center",
        className,
      )}
    >
      <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-lg [&_svg]:size-4">
        {icon}
      </span>
      <p className="text-sm font-medium">{title}</p>
      {body ? <div className="text-muted-foreground max-w-sm text-xs leading-5">{body}</div> : null}
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
