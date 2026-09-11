/**
 * One-off maintenance: strip markup from already-stored entries.
 *
 * The model occasionally mimics the prompt's <document> wrapper and wraps its own
 * output (e.g. each key claim in <item>...</item>). Ingest now scrubs this, but
 * rows written before that fix -- and anything arriving via /api/import -- still
 * need cleaning. Purely local: no API calls, no re-summarization.
 *
 *   npm run db:scrub
 */
import Database from "better-sqlite3";
import path from "node:path";
import { cleanMultiline, cleanText } from "../src/lib/sanitize";

const DB_FILE = process.env.DATABASE_PATH ?? "data/research.db";
const dbPath = path.isAbsolute(DB_FILE) ? DB_FILE : path.join(process.cwd(), DB_FILE);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

type Row = {
  id: string;
  title: string;
  summary: string;
  key_claims: string;
  tags: string;
  authors: string;
  org: string | null;
  venue: string | null;
};

const cleanJsonArray = (raw: string): { value: string; changed: boolean } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return { value: raw, changed: false };
  }
  if (!Array.isArray(parsed)) return { value: raw, changed: false };
  const cleaned = parsed.map((v) => cleanText(v)).filter(Boolean);
  const next = JSON.stringify(cleaned);
  return { value: next, changed: next !== raw };
};

const rows = db
  .prepare("SELECT id, title, summary, key_claims, tags, authors, org, venue FROM entries")
  .all() as Row[];

const update = db.prepare(
  `UPDATE entries SET title = ?, summary = ?, key_claims = ?, tags = ?, authors = ?,
   org = ?, venue = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
);

let changedRows = 0;
const apply = db.transaction((all: Row[]) => {
  for (const row of all) {
    const title = cleanText(row.title);
    const summary = cleanMultiline(row.summary);
    const claims = cleanJsonArray(row.key_claims);
    const tags = cleanJsonArray(row.tags);
    const authors = cleanJsonArray(row.authors);
    const org = row.org == null ? null : cleanText(row.org) || null;
    const venue = row.venue == null ? null : cleanText(row.venue) || null;

    const changed =
      title !== row.title ||
      summary !== row.summary ||
      claims.changed ||
      tags.changed ||
      authors.changed ||
      org !== row.org ||
      venue !== row.venue;

    if (!changed) continue;
    changedRows += 1;
    console.log(`  cleaned: ${title.slice(0, 60) || row.id}`);
    update.run(title, summary, claims.value, tags.value, authors.value, org, venue, row.id);
  }
});

apply(rows);
console.log(
  changedRows
    ? `\nScrubbed ${changedRows} of ${rows.length} entries.`
    : `\nNothing to scrub (${rows.length} entries already clean).`,
);
db.close();
