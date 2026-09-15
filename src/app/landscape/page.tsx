import type { Metadata } from "next";
import { Suspense } from "react";

import { TopicsView, TopicsViewSkeleton } from "@/components/landscape/topics-view";

export const metadata: Metadata = {
  title: "Landscape",
  description: "Map an ML research field into clusters, tensions, and a reading path.",
};

export default function LandscapePage() {
  // TopicsView reads `?fixture=` via useSearchParams, which needs a Suspense
  // boundary so the rest of the route can still be prerendered.
  return (
    <Suspense fallback={<TopicsViewSkeleton />}>
      <TopicsView />
    </Suspense>
  );
}
