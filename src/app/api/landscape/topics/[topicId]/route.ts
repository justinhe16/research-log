import { z } from "zod";
import { db } from "@/lib/db";
import { embed } from "@/lib/embedding";
import { TOPIC_DESCRIPTION_MAX, TOPIC_NAME_MAX } from "@/lib/landscape/constants";
import { markStaleSearches } from "@/lib/landscape/pipeline/recovery";
import { isSearchRunning } from "@/lib/landscape/pipeline/runner";
import { listSearchesForTopic } from "@/lib/landscape/queries/searches";
import { deleteTopic, getTopicByIdOrSlug, updateTopic } from "@/lib/landscape/queries/topic-repo";
import { DEPTHS, type TopicDetail } from "@/lib/landscape/types";
import { fail, parseBody } from "../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ topicId: string }> };

const updateSchema = z
  .object({
    name: z.string().trim().min(1, "A topic name is required.").max(TOPIC_NAME_MAX),
    description: z.string().trim().max(TOPIC_DESCRIPTION_MAX),
    defaultDepth: z.enum(DEPTHS),
  })
  .partial();

/**
 * GET /api/landscape/topics/[topicId]  (id or slug)
 * Topic header + full search history.
 * Responds: 200 { topic: TopicDetail } | 404
 */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { topicId } = await params;
    try {
      markStaleSearches(db, { isRunning: isSearchRunning });
    } catch (err) {
      console.error("[GET /api/landscape/topics/:id] stale sweep failed", err);
    }
    const card = getTopicByIdOrSlug(db, topicId);
    if (!card) return fail("Topic not found.", 404);
    const topic: TopicDetail = { ...card, searches: listSearchesForTopic(db, card.id) };
    return Response.json({ topic });
  } catch (err) {
    console.error("[GET /api/landscape/topics/:id]", err);
    return fail("Could not load the topic.", 500);
  }
}

/**
 * PATCH /api/landscape/topics/[topicId]
 * Rename / edit description / change default depth.
 * Body: UpdateTopicInput
 * Responds: 200 { topic: TopicCard } | 400 | 404
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { topicId } = await params;
    const parsed = await parseBody(request, updateSchema);
    if (!parsed.ok) return parsed.response;
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) return fail("No updatable fields were provided.", 400);

    const topic = await updateTopic(db, topicId, patch, { reembed: embed });
    if (!topic) return fail("Topic not found.", 404);
    return Response.json({ topic });
  } catch (err) {
    console.error("[PATCH /api/landscape/topics/:id]", err);
    return fail("Could not update the topic.", 500);
  }
}

/**
 * DELETE /api/landscape/topics/[topicId]
 * Delete a topic and all its searches (papers are global and kept).
 * Responds: 200 { ok: true } | 404 | 409 { error, activeSearchId } (cancel the running search first)
 */
export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const { topicId } = await params;
    const result = deleteTopic(db, topicId);
    if (result.ok) return Response.json({ ok: true });
    if (result.reason === "not_found") return fail("Topic not found.", 404);
    return fail("Cancel the running search before deleting this topic.", 409, { activeSearchId: result.searchId });
  } catch (err) {
    console.error("[DELETE /api/landscape/topics/:id]", err);
    return fail("Could not delete the topic.", 500);
  }
}
