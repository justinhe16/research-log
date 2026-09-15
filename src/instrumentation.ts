/*
 * Runs once per server instance before requests are served. On the Node.js
 * runtime: sweep searches orphaned by a previous process to `interrupted`
 * (resumable from the UI) and purge expired HTTP cache rows.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ db }, { markStaleSearches }, { isSearchRunning }, { purgeExpiredApiCache }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/landscape/pipeline/recovery"),
      import("@/lib/landscape/pipeline/runner"),
      import("@/lib/landscape/sources/http"),
    ]);
    const swept = markStaleSearches(db, { isRunning: isSearchRunning });
    if (swept.length > 0) console.log(`[landscape] marked ${swept.length} stale search(es) interrupted`);
    await purgeExpiredApiCache(db);
  } catch (err) {
    // Never block server startup on housekeeping.
    console.error("[landscape] startup recovery failed", err);
  }
}
