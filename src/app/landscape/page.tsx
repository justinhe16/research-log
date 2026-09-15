import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { TopicsView, TopicsViewSkeleton } from "@/components/landscape/topics-view";

export const metadata: Metadata = {
  title: "Landscape",
  description: "Map an ML research field into clusters, tensions, and a reading path.",
};

export default function LandscapePage() {
  // TopicsView reads `?fixture=` via useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={<TopicsViewSkeleton />}>
      <TopicsWithConfig />
    </Suspense>
  );
}

async function TopicsWithConfig() {
  // Read the env at request time (not baked in at build) and pass only a boolean.
  await connection();
  const hasS2Key = Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim());
  return <TopicsView hasS2Key={hasS2Key} />;
}
