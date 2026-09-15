/**
 * End-to-end Landscape smoke test against the real APIs.
 *
 *   DATABASE_PATH=/tmp/smoke.db npm run landscape:smoke -- "<topic name>" [quick|standard|deep]
 *   DATABASE_PATH=/tmp/smoke.db npm run landscape:smoke -- "<topic name>" --refresh
 *   DATABASE_PATH=/tmp/smoke.db npm run landscape:smoke -- --resume <searchId>
 *
 * Refuses to run against the default database (data/research.db).
 */
import fs from "node:fs";
import path from "node:path";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Next loads .env.local for us; a bare tsx process does not. */
function loadEnvLocal() {
  for (const name of [".env.local", ".env"]) {
    const file = path.resolve(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      process.env[key] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

function usage(): never {
  console.error(
    'usage: DATABASE_PATH=<path> npm run landscape:smoke -- "<topic name>" [quick|standard|deep] [--refresh]\n' +
      "       DATABASE_PATH=<path> npm run landscape:smoke -- --resume <searchId>",
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let refresh = false;
  let resume: string | null = null;
  let depth: "quick" | "standard" | "deep" = "quick";
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refresh") refresh = true;
    else if (a === "--resume") resume = argv[++i] ?? usage();
    else if (a === "quick" || a === "standard" || a === "deep") depth = a;
    else if (a.startsWith("--")) usage();
    else positional.push(a);
  }
  const name = positional.join(" ").trim();
  if (!resume && !name) usage();
  return { name, depth, refresh, resume };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const ts = (v: string | null | undefined) => (v ? Date.parse(v.includes("T") ? v : `${v.replace(" ", "T")}Z`) : NaN);

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  const dbPath = process.env.DATABASE_PATH?.trim();
  if (!dbPath) {
    console.error(`${RED}DATABASE_PATH must be set to a scratch database.${RESET}`);
    process.exit(1);
  }
  const resolved = path.resolve(process.cwd(), dbPath);
  if (resolved === path.resolve(process.cwd(), "data/research.db")) {
    console.error(`${RED}Refusing to run against the default database (data/research.db).${RESET}`);
    process.exit(1);
  }

  // Imported after the env is loaded: @/lib/db opens DATABASE_PATH at import time.
  const { db } = await import("../src/lib/db");
  const schema = await import("../src/lib/db/schema");
  const { and, asc, eq, sql } = await import("drizzle-orm");
  const { embed } = await import("../src/lib/embedding");
  const { createTopic } = await import("../src/lib/landscape/queries/topic-repo");
  const { topicEmbeddingText } = await import("../src/lib/landscape/topic-dedupe");
  const { getLatestDoneSearchId } = await import("../src/lib/landscape/queries/searches");
  const { markStaleSearches } = await import("../src/lib/landscape/pipeline/recovery");
  const runner = await import("../src/lib/landscape/pipeline/runner");
  const { estimate, refreshNewFraction } = await import("../src/lib/landscape/estimate");

  const hasS2Key = Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY?.trim());
  console.log(`${DIM}db=${resolved}  s2Key=${hasS2Key ? "yes" : "no"}  anthropicKey=${process.env.ANTHROPIC_API_KEY ? "yes" : "no"}${RESET}`);

  const warnings: string[] = [];
  const logger = (line: string) => {
    if (/warning:/.test(line)) warnings.push(line);
    console.log(`${DIM}${line}${RESET}`);
  };

  let searchId: string;
  const t0 = Date.now();

  if (args.resume) {
    searchId = args.resume;
    const swept = markStaleSearches(db, { isRunning: runner.isSearchRunning });
    if (swept.length) console.log(`marked interrupted: ${swept.join(", ")}`);
    const before = db.select({ n: sql<number>`count(*)` }).from(schema.llmCalls).where(eq(schema.llmCalls.searchId, searchId)).get()?.n ?? 0;
    console.log(`llm_calls before resume: ${before}`);
    const stages = db.select().from(schema.searchStages).where(eq(schema.searchStages.searchId, searchId)).all();
    console.log(`stages before resume: ${stages.map((s) => `${s.stage}=${s.status}`).join(" ")}`);
    const r = await runner.resumeSearch(searchId, { db, logger });
    if (!r.ok) {
      console.error(`${RED}resume failed: ${JSON.stringify(r)}${RESET}`);
      process.exit(1);
    }
  } else if (args.refresh) {
    const topic = db.select().from(schema.topics).where(eq(schema.topics.name, args.name)).get();
    if (!topic) {
      console.error(`${RED}No topic named "${args.name}".${RESET}`);
      process.exit(1);
    }
    const base = getLatestDoneSearchId(db, topic.id);
    if (!base) {
      console.error(`${RED}Topic has no done search to refresh.${RESET}`);
      process.exit(1);
    }
    const baseRow = db.select().from(schema.searches).where(eq(schema.searches.id, base)).get()!;
    const created = runner.createSearch(db, { topicId: topic.id, kind: "refresh", depth: baseRow.depth as typeof args.depth, baseSearchId: base });
    if (!created.ok) {
      console.error(`${RED}createSearch failed: ${JSON.stringify(created)}${RESET}`);
      process.exit(1);
    }
    searchId = created.search.id;
    console.log(`refresh search ${searchId} (base ${base}, since ${created.search.since})`);
    await runner.startSearch(searchId, { db, logger });
  } else {
    const vector = await embed(topicEmbeddingText(args.name, null)).catch(() => null);
    const topic = createTopic(db, { name: args.name, depth: args.depth, embedding: vector });
    const created = runner.createSearch(db, { topicId: topic.id, kind: "initial", depth: args.depth });
    if (!created.ok) {
      console.error(`${RED}createSearch failed: ${JSON.stringify(created)}${RESET}`);
      process.exit(1);
    }
    searchId = created.search.id;
    console.log(`topic ${topic.id} (${topic.slug})  search ${searchId}  depth=${args.depth}`);
    await runner.startSearch(searchId, { db, logger });
  }

  // ---- live progress --------------------------------------------------------
  let lastStage: string | null = null;
  const poll = setInterval(() => {
    const s = db.select().from(schema.searches).where(eq(schema.searches.id, searchId)).get();
    if (!s) return;
    if (s.stage !== lastStage) {
      lastStage = s.stage;
      console.log(`${CYAN}[${secs(Date.now() - t0)}] stage=${s.stage ?? "-"} status=${s.status} progress=${(s.progress * 100).toFixed(0)}%${RESET}`);
    }
  }, 500);
  await runner.waitForSearch(searchId);
  clearInterval(poll);
  const wall = Date.now() - t0;

  // ---- summary --------------------------------------------------------------
  const s = db.select().from(schema.searches).where(eq(schema.searches.id, searchId)).get()!;
  const statusColor = s.status === "done" ? GREEN : RED;
  console.log(`\n${BOLD}${"=".repeat(70)}\n  SUMMARY  ${searchId}\n${"=".repeat(70)}${RESET}`);
  console.log(`status: ${statusColor}${s.status}${RESET}${s.error ? `  error: ${s.error}` : ""}  kind=${s.kind} depth=${s.depth}`);

  const stages = db.select().from(schema.searchStages).where(eq(schema.searchStages.searchId, searchId)).all();
  const order = new Map((await import("../src/lib/landscape/types")).STAGES.map((st, i) => [st, i]));
  stages.sort((a, b) => (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0));
  console.log(`\n${BOLD}stages${RESET}`);
  for (const st of stages) {
    const d = ts(st.finishedAt) - ts(st.startedAt);
    const col = st.status === "done" ? GREEN : st.status === "skipped" ? DIM : st.status === "error" ? RED : YELLOW;
    console.log(`  ${st.stage.padEnd(12)} ${col}${st.status.padEnd(8)}${RESET} ${Number.isFinite(d) ? secs(d).padStart(7) : "      -"}${st.error ? `  ${RED}${st.error}${RESET}` : ""}`);
  }

  console.log(`\n${BOLD}counters${RESET} ${JSON.stringify(s.counters)}`);
  console.log(`queries: ${s.queries.map((q) => JSON.stringify(q)).join("\n         ")}`);

  const selected = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.searchPapers)
    .where(and(eq(schema.searchPapers.searchId, searchId), eq(schema.searchPapers.selected, true)))
    .get()?.n;
  console.log(`selected papers: ${selected}`);

  const clusters = db.select().from(schema.searchClusters).where(eq(schema.searchClusters.searchId, searchId)).orderBy(asc(schema.searchClusters.idx)).all();
  console.log(`clusters (${clusters.length}):`);
  for (const c of clusters) console.log(`  #${c.idx} [${c.size}] ${c.label}${c.change ? ` (${c.change})` : ""}  ${DIM}${c.keyTerms.join(", ")}${RESET}`);

  const docs = db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.searchId, searchId)).all();
  console.log(`documents: ${docs.map((d) => `${d.kind}=${d.status === "done" ? GREEN : RED}${d.status}${RESET}${d.error ? `(${d.error})` : ""}`).join("  ") || "(none)"}`);

  const calls = db.select().from(schema.llmCalls).where(eq(schema.llmCalls.searchId, searchId)).orderBy(asc(schema.llmCalls.createdAt)).all();
  console.log(`\n${BOLD}llm_calls (${calls.length})${RESET}`);
  for (const c of calls) {
    console.log(
      `  ${String(c.stage).padEnd(11)} ${c.purpose.padEnd(22)} ${c.model.padEnd(20)} in=${c.inputTokens} out=${c.outputTokens} cr=${c.cacheReadTokens} cw=${c.cacheWriteTokens} $${c.costUsd.toFixed(4)} ${secs(c.durationMs)}${c.ok ? "" : ` ${RED}FAIL ${c.error}${RESET}`}`,
    );
  }
  console.log(`tokens: in=${s.inputTokens} out=${s.outputTokens} cacheRead=${s.cacheReadTokens} cacheWrite=${s.cacheWriteTokens}`);

  let refreshOpt: { daysSince: number } | undefined;
  if (s.kind === "refresh" && s.baseSearchId) {
    const base = db.select().from(schema.searches).where(eq(schema.searches.id, s.baseSearchId)).get();
    const days = base ? Math.max(0, (Date.now() - ts(base.startedAt ?? base.createdAt)) / 86_400_000) : 0;
    refreshOpt = { daysSince: days };
    console.log(`${DIM}refresh newFraction=${refreshNewFraction(s.config, days).toFixed(2)}${RESET}`);
  }
  const est = estimate(s.config, { hasS2Key, refresh: refreshOpt });
  const inRange = s.costUsd >= est.costUsd.low && s.costUsd <= est.costUsd.high;
  console.log(
    `cost: $${s.costUsd.toFixed(4)}  estimate $${est.costUsd.expected} [${est.costUsd.low}–${est.costUsd.high}] ${inRange ? `${GREEN}in range${RESET}` : `${YELLOW}out of range${RESET}`}`,
  );
  console.log(`wall time: ${secs(wall)}  estimate ${est.minutes.expected}min [${est.minutes.low}–${est.minutes.high}]`);
  console.log(`warnings (${warnings.length}):${warnings.map((w) => `\n  ${YELLOW}${w}${RESET}`).join("")}`);

  process.exit(s.status === "done" ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
