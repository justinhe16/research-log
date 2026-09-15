import path from "node:path";
import { createDb, type Db } from "./create";
import * as schema from "./schema";

const DB_FILE = process.env.DATABASE_PATH ?? "data/research.db";

// path.join(process.cwd(), ...) rather than path.resolve(<dynamic>): the latter is
// opaque to Turbopack's static analysis, which then traces the entire project into
// the server bundle.
export const DB_PATH = path.isAbsolute(DB_FILE)
  ? DB_FILE
  : path.join(/* turbopackIgnore: true */ process.cwd(), DB_FILE);

// Cached on globalThis so Next's dev HMR doesn't open a new handle on every reload.
const globalForDb = globalThis as unknown as { __researchLogDb?: Db };

export const db: Db = globalForDb.__researchLogDb ?? createDb(DB_PATH);
if (process.env.NODE_ENV !== "production") globalForDb.__researchLogDb = db;

export { createDb, schema };
export type { Db };
