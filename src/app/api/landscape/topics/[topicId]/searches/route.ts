import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { searches } from "@/lib/db/schema";
import { toSearchProgress } from "@/lib/landscape/pipeline/progress";
import { createSearch, startSearch } from "@/lib/landscape/pipeline/runner";
import { getLatestDoneSearchId, toDepth } from "@/lib/landscape/queries/searches";
import { checkSearchSpendCap } from "@/lib/landscape/spend-cap";
import { getTopicRow } from "@/lib/landscape/queries/topic-repo";
import { DEPTHS } from "@/lib/landscape/types";
import { fail, parseBody } from "../../../_lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ topicId: string }> };

const startSchema = z.object({
  mode: z.enum(["refresh", "full"]),
  depth: z.enum(DEPTHS).optional(),
});

/**
 * POST /api/landscape/topics/[topicId]/searches  (id or slug)
 * Start a refresh (incremental from the latest done search) or a full re-run.
 * Depth defaults to the base search's depth for a refresh, else the topic default.
 * Body: StartSearchInput
 * Responds: 201 { search: SearchProgress } | 400 | 404 | 409 { error } (a search is already active, or nothing to refresh)
 *   | 429 { error } (LANDSCAPE_MAX_SEARCHES_PER_HOUR reached)
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { topicId } = await params;
    const parsed = await parseBody(request, startSchema);
    if (!parsed.ok) return parsed.response;
    const { mode } = parsed.data;

    const topic = getTopicRow(db, topicId);
    if (!topic) return fail("Topic not found.", 404);

    // Everything from here to createSearch is synchronous (better-sqlite3), so the
    // base read, the depth default and the insert see one consistent DB state; no
    // other request can finish a search in between. createSearch also re-validates
    // the base and the one-active-search rule itself.
    const baseId = getLatestDoneSearchId(db, topic.id);
    if (mode === "refresh" && !baseId) {
      return fail("This topic has no completed search to refresh from.", 409);
    }
    const baseDepth = baseId
      ? db.select({ depth: searches.depth }).from(searches).where(eq(searches.id, baseId)).get()?.depth
      : undefined;
    const depth =
      parsed.data.depth ?? (mode === "refresh" && baseDepth ? toDepth(baseDepth) : toDepth(topic.defaultDepth));

    const cap = checkSearchSpendCap(db);
    if (!cap.ok) return fail(cap.error, 429);

    const created = createSearch(db, { topicId: topic.id, kind: mode, depth, baseSearchId: baseId });
    if (!created.ok) {
      switch (created.reason) {
        case "topic_not_found":
          return fail("Topic not found.", 404);
        case "base_not_found":
          return fail("This topic has no completed search to refresh from.", 409);
        case "active_search":
          return fail("This topic already has a search in progress.", 409, {
            activeSearchId: created.activeSearchId,
          });
      }
    }
    await startSearch(created.search.id, { db });

    const search = toSearchProgress(db, created.search.id);
    if (!search) return fail("The search was created but could not be read back.", 500);
    return Response.json({ search }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/landscape/topics/:id/searches]", err);
    return fail("Could not start the search.", 500);
  }
}
