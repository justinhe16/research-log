import { Skeleton } from "@/components/ui/skeleton";

export const MAP_FRAME_CLASS =
  "landscape-map border-border/70 bg-card relative h-[clamp(480px,calc(100svh-9rem),860px)] w-full overflow-hidden rounded-xl border";

export function MapSkeleton() {
  return (
    <div className={MAP_FRAME_CLASS} aria-busy="true">
      <div className="absolute top-3 left-3 flex gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="hidden h-7 w-56 sm:block" />
      </div>
      <Skeleton className="absolute top-3 right-3 hidden h-56 w-64 md:block" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-muted-foreground text-xs">Laying out the map</span>
      </div>
    </div>
  );
}
