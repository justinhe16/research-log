import type { Metadata } from "next";
import { Suspense } from "react";

import { TopicView, TopicViewSkeleton } from "@/components/landscape/topic-view";

type Props = { params: Promise<{ topicId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await params;
  // TODO(C2): read the topic from the DB and use its name as the title.
  return {
    title: "Topic",
    description: "Clusters, tensions, and a reading path for an ML research field.",
  };
}

export default async function TopicPage({ params }: Props) {
  const { topicId } = await params;
  return (
    <Suspense fallback={<TopicViewSkeleton />}>
      <TopicView topicId={topicId} />
    </Suspense>
  );
}
