import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const DB_FILE = process.env.DATABASE_PATH ?? "data/research.db";

// path.join(process.cwd(), ...) rather than path.resolve(<dynamic>): the latter is
// opaque to Turbopack's static analysis, which then traces the entire project into
// the server bundle.
export const DB_PATH = path.isAbsolute(DB_FILE)
  ? DB_FILE
  : path.join(/* turbopackIgnore: true */ process.cwd(), DB_FILE);

type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// Cached on globalThis so Next's dev HMR doesn't open a new handle on every reload.
const globalForDb = globalThis as unknown as { __researchLogDb?: Db };

function create(): Db {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const sqlite = new Database(DB_PATH);
  // WAL keeps reads non-blocking during ingest writes and survives crashes cleanly.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema }) as Db;

  // Apply any pending migrations at boot so a fresh clone (or a restored
  // backup from an older schema) is immediately usable.
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  }

  return db;
}

export const db: Db = globalForDb.__researchLogDb ?? create();
if (process.env.NODE_ENV !== "production") globalForDb.__researchLogDb = db;

export { schema };
