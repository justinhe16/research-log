import { z } from "zod";
import { db } from "@/lib/db";
import { TOPIC_DESCRIPTION_MAX, TOPIC_NAME_MAX } from "@/lib/landscape/constants";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { markStaleSearches } from "@/lib/landscape/pipeline/recovery";
import { createSearch, isSearchRunning, startSearch } from "@/lib/landscape/pipeline/runner";
import { createTopic, deleteTopic, getTopicByIdOrSlug, listTopicCards } from "@/lib/landscape/queries/topic-repo";
import { checkSearchSpendCap } from "@/lib/landscape/spend-cap";
import { findSimilarTopics, findSimilarTopicsFor } from "@/lib/landscape/topic-dedupe";
import { DEPTHS, type CreateTopicResponse, type SimilarTopic, type SimilarTopicsConflict } from "@/lib/landscape/types";
import { fail, parseBody } from "../_lib/http";
import { exactNameMatches, withLock } from "../_lib/lock";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1, "A topic name is required.").max(TOPIC_NAME_MAX),
  description: z.string().trim().max(TOPIC_DESCRIPTION_MAX).optional(),
  depth: z.enum(DEPTHS),
  force: z.boolean().optional(),
});

/**
 * GET /api/landscape/topics
 * List topics, newest activity first. Also lazily sweeps stale running searches.
 * Responds: 200 { topics: TopicCard[] }
 */
export async function GET() {
  try {
    try {
      markStaleSearches(db, { isRunning: isSearchRunning });
    } catch (err) {
      console.error("[GET /api/landscape/topics] stale sweep failed", err);
    }
    return Response.json({ topics: listTopicCards(db) });
  } catch (err) {
    console.error("[GET /api/landscape/topics]", err);
    return fail("Could not load topics.", 500);
  }
}

/**
 * POST /api/landscape/topics
 * Create a topic and queue its initial search.
 * Body: CreateTopicInput
 * Responds: 201 CreateTopicResponse | 409 SimilarTopicsConflict (unless force) | 400 { error }
 *   | 429 { error } (LANDSCAPE_MAX_SEARCHES_PER_HOUR reached)
 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, createSchema);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    // Checked before the (slow) embedding, and again under the lock just before inserting.
    const cap = checkSearchSpendCap(db);
    if (!cap.ok) return fail(cap.error, 429);

    const conflict = (similar: SimilarTopic[], error = "Similar topics already exist.") => {
      const body: SimilarTopicsConflict = { error, similar };
      return Response.json(body, { status: 409 });
    };

    // Embedding is slow and pure, so it runs outside the lock.
    const { similar, embedding } = await findSimilarTopicsFor(db, input);
    if (similar.length > 0 && !input.force) return conflict(similar);

    // Serialize check-then-create so a double submit can't create two topics. The
    // re-checks below are synchronous with createTopic: nothing can interleave.
    const outcome = await withLock("topics:create", async () => {
      const exact = exactNameMatches(db, input.name);
      if (exact.length > 0) {
        return { response: conflict(exact, "A topic with this name already exists.") } as const;
      }
      if (!input.force) {
        const again = findSimilarTopics(db, embedding, { queryName: input.name });
        if (again.length > 0) return { response: conflict(again) } as const;
      }

      const capNow = checkSearchSpendCap(db);
      if (!capNow.ok) return { response: fail(capNow.error, 429) } as const;

      const topic = createTopic(db, { ...input, embedding });
      const created = createSearch(db, { topicId: topic.id, kind: "initial", depth: input.depth });
      if (!created.ok) {
        // A brand-new topic cannot have an active search; undo rather than leave an empty topic.
        deleteTopic(db, topic.id);
        return { response: fail("Could not start the search.", 500) } as const;
      }
      // Register the job before releasing the lock so a stale sweep can't see an orphaned queued row.
      await startSearch(created.search.id, { db });
      return { topicId: topic.id, searchId: created.search.id } as const;
    });
    if ("response" in outcome) return outcome.response;

    const search = toSearchProgress(db, outcome.searchId);
    const card = getTopicByIdOrSlug(db, outcome.topicId);
    if (!search || !card) return fail("The topic was created but could not be read back.", 500);

    const body: CreateTopicResponse = { topic: card, search };
    return Response.json(body, { status: 201 });
  } catch (err) {
    console.error("[POST /api/landscape/topics]", err);
    return fail("Could not create the topic.", 500);
  }
}
