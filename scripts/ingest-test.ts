/**
 * Dry-run the ingest pipeline against a real URL without touching the database.
 *
 *   npx tsx scripts/ingest-test.ts https://arxiv.org/abs/2310.01405
 *
 * Extraction needs no credentials; summarization needs ANTHROPIC_API_KEY.
 */
import fs from "node:fs";
import path from "node:path";

import { extractContent, type ExtractedContent } from "../src/lib/ingest/extract";
import { summarize } from "../src/lib/ingest/summarize";
import { embed } from "../src/lib/embedding";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function header(step: string) {
  console.log(`\n${CYAN}${BOLD}${"=".repeat(70)}\n  ${step}\n${"=".repeat(70)}${RESET}`);
}

function field(label: string, value: unknown) {
  const rendered =
    value === null || value === undefined || (Array.isArray(value) && value.length === 0)
      ? `${DIM}(none)${RESET}`
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  console.log(`  ${BOLD}${label.padEnd(14)}${RESET} ${rendered}`);
}

function block(label: string, text: string) {
  console.log(`\n  ${BOLD}${label}${RESET}`);
  for (const line of text.split("\n")) console.log(`    ${line}`);
}

function preview(text: string, chars = 800): string {
  const head = text.slice(0, chars);
  return head + (text.length > chars ? `\n${DIM}... [${text.length - chars} more chars]${RESET}` : "");
}

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

async function main() {
  loadEnvLocal();
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npx tsx scripts/ingest-test.ts <url>");
    process.exit(1);
  }

  // ---- 1. extract ---------------------------------------------------------
  header("1/3  EXTRACT");
  const t0 = Date.now();
  let content: ExtractedContent;
  try {
    content = await extractContent(url);
  } catch (err) {
    console.error(`${RED}extract failed:${RESET} ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`${DIM}  (${Date.now() - t0} ms)${RESET}\n`);
  field("url", content.url);
  field("title", content.title);
  field("contentType", content.contentType);
  field("authors", content.authors);
  field("publishedAt", content.publishedAt);
  field("venue", content.venue);
  field("org", content.org);
  field("text length", `${content.text.length} chars`);
  block("text preview", preview(content.text));

  // ---- 2. summarize -------------------------------------------------------
  header("2/3  SUMMARIZE");
  const t1 = Date.now();
  let analysis: Awaited<ReturnType<typeof summarize>> | null = null;
  try {
    analysis = await summarize(content);
    console.log(`${DIM}  (${Date.now() - t1} ms)${RESET}\n`);
    field("title", analysis.title);
    field("category", analysis.category);
    field("contentType", analysis.contentType);
    field("authors", analysis.authors);
    field("org", analysis.org);
    field("venue", analysis.venue);
    field("publishedAt", analysis.publishedAt);
    field("tags", analysis.tags);
    block("summary", analysis.summary);
    block("key claims", analysis.keyClaims.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  } catch (err) {
    console.error(`${RED}  summarize failed:${RESET} ${err instanceof Error ? err.message : err}`);
    console.error(`${DIM}  continuing to the embedding stage with extracted data only.${RESET}`);
  }

  // ---- 3. embed -----------------------------------------------------------
  header("3/3  EMBED");
  const toEmbed = [
    analysis?.title ?? content.title,
    analysis?.summary ?? content.text.slice(0, 1000),
    (analysis?.tags ?? []).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
  const t2 = Date.now();
  try {
    const vec = await embed(toEmbed);
    console.log(`${DIM}  (${Date.now() - t2} ms, model load included)${RESET}\n`);
    field("dimensions", vec.length);
    field("first 8 dims", Array.from(vec.slice(0, 8)).map((n) => n.toFixed(5)).join("  "));
    const norm = Math.sqrt(Array.from(vec).reduce((s, n) => s + n * n, 0));
    field("L2 norm", norm.toFixed(6));
    console.log(`\n${GREEN}${BOLD}  pipeline OK${RESET}`);
  } catch (err) {
    console.error(`${RED}  embed failed:${RESET} ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
