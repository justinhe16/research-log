import { cn } from "@/lib/utils";

/** Circular 0..1 progress. Indeterminate (spinning arc) when `value` is null. */
export function ProgressRing({
  value,
  size = 28,
  stroke = 2.5,
  className,
  label,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  className?: string;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const v = value === null ? 0.25 : Math.max(0, Math.min(1, value));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(v * 100)}
      className={cn("-rotate-90 shrink-0", value === null && "animate-spin", className)}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - v)}
        className="stroke-foreground/70 transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
      />
    </svg>
  );
}
