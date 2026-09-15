import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { TopicView, TopicViewSkeleton } from "@/components/landscape/topic-view";
import { db } from "@/lib/db";
import { getTopicByIdOrSlug } from "@/lib/landscape/queries/topic-repo";

export const runtime = "nodejs";

const DESCRIPTION = "Clusters, tensions, and a reading path for an ML research field.";

export async function generateMetadata({ params }: PageProps<"/landscape/[topicId]">): Promise<Metadata> {
  const { topicId } = await params;
  let topic: ReturnType<typeof getTopicByIdOrSlug> = null;
  try {
    topic = getTopicByIdOrSlug(db, topicId);
  } catch (err) {
    console.error("[landscape/[topicId] generateMetadata]", err);
  }
  return {
    title: topic?.name ?? "Topic",
    description: topic?.description?.trim() || DESCRIPTION,
  };
}

export default async function TopicPage({ params }: PageProps<"/landscape/[topicId]">) {
  const { topicId } = await params;
  return (
    <Suspense fallback={<TopicViewSkeleton />}>
      <TopicWithConfig topicId={topicId} />
    </Suspense>
  );
}

async function TopicWithConfig({ topicId }: { topicId: string }) {
  await connection();
  const hasS2Key = Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim());
  return <TopicView topicId={topicId} hasS2Key={hasS2Key} />;
}
