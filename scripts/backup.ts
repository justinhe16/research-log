/**
 * Online snapshot of the SQLite database.
 *
 *   npm run db:backup
 *
 * Uses better-sqlite3's `.backup()` (SQLite's online backup API), so it produces
 * a consistent single-file copy even while `next dev` holds the DB open in WAL
 * mode -- unlike `cp`, which can catch a torn write plus a stale -wal sidecar.
 */
import fs from "node:fs";
import path from "node:path";
import { db, DB_PATH } from "../src/lib/db";

const KEEP = 10;
const BACKUP_DIR = path.resolve("./backups");

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Filesystem-safe ISO: 2026-09-10T14-32-05-123Z
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `research-${stamp}.db`);

  console.log(`Backing up ${DB_PATH}`);
  await db.$client.backup(dest);

  const size = fs.statSync(dest).size;
  console.log(`Wrote ${dest} (${fmtSize(size)})`);

  const stale = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^research-.*\.db$/.test(f))
    .sort() // timestamp-prefixed names sort chronologically
    .reverse()
    .slice(KEEP);

  for (const f of stale) {
    fs.rmSync(path.join(BACKUP_DIR, f));
    console.log(`Pruned old backup ${f}`);
  }

  const kept = fs.readdirSync(BACKUP_DIR).filter((f) => /^research-.*\.db$/.test(f)).length;
  console.log(`${kept} backup${kept === 1 ? "" : "s"} retained (keeping the newest ${KEEP}).`);
}

main().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
