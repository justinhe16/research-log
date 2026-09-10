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

export function Rating({ value, onChange, className, size = "md" }: RatingProps) {
  const readOnly = !onChange;
  const starSize = size === "sm" ? "size-3.5" : "size-4.5";

  if (readOnly && !value) {
    return <span className="text-muted-foreground/60 text-xs">—</span>;
  }

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
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
              className={cn(
                starSize,
                filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/25",
              )}
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
              "rounded-sm p-0.5 transition-transform outline-none",
              "hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50",
            )}
          >
            <StarIcon
              className={cn(
                starSize,
                "transition-colors",
                filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/35",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
