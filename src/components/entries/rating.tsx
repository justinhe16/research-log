"use client";

import { StarIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type RatingProps = {
  value: number | null;
  /** Omit to render a read-only display. Clicking the current value clears it (passes null). */
  onChange?: (value: number | null) => void;
  className?: string;
  size?: "sm" | "md";
};

const MAX = 5;

const FILLED = "fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400";

export function Rating({ value, onChange, className, size = "md" }: RatingProps) {
  const readOnly = !onChange;
  const starSize = size === "sm" ? "size-3" : "size-4";

  if (readOnly && !value) {
    return <span className="text-muted-foreground/50 text-xs">—</span>;
  }

  return (
    <div
      className={cn("flex items-center", readOnly ? "gap-0.5" : "-ml-1", className)}
      role={readOnly ? "img" : "radiogroup"}
      aria-label={value ? `Rated ${value} of ${MAX}` : "Not rated"}
    >
      {Array.from({ length: MAX }, (_, i) => i + 1).map((star) => {
        const filled = value !== null && star <= value;
        if (readOnly) {
          return (
            <StarIcon
              key={star}
              aria-hidden
              className={cn(starSize, filled ? FILLED : "text-muted-foreground/25")}
            />
          );
        }
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} star${star === 1 ? "" : "s"}`}
            title={value === star ? "Click again to clear" : `Rate ${star}/${MAX}`}
            onClick={() => onChange(value === star ? null : star)}
            className={cn(
              "hover:bg-muted focus-visible:ring-ring/50 rounded-md p-1 transition-colors outline-none",
              "focus-visible:ring-3",
            )}
          >
            <StarIcon
              className={cn(
                starSize,
                "transition-colors",
                filled ? FILLED : "text-muted-foreground/30",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
