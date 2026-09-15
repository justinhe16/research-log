# research-log

A personal, local-first log of AI-research reading. Paste a URL; the app fetches
the page, has Claude Haiku pull out the structured bits (title, summary, key
claims, authors, venue, tags), embeds it locally, and files it alongside your own
notes and rating.

Everything lives in one SQLite file on your machine. No account, no server, no
data leaving the box except the summarization call to the Anthropic API.

## Quickstart

```bash
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

The database is created at `./data/research.db` on first boot and migrations in
`./drizzle` are applied automatically. Override the location with
`DATABASE_PATH`. The first ingest downloads the ~90MB MiniLM model to a local
cache; after that embedding is offline.

## Architecture

| Piece | What it is |
| --- | --- |
| App | Next.js 16, App Router, TypeScript, Tailwind + shadcn/ui |
| API | Route handlers under `src/app/api/*`, all `runtime = "nodejs"` |
| Storage | SQLite via better-sqlite3 + Drizzle ORM, WAL mode |
| Extraction | Claude Haiku (`claude-haiku-4-5`) over the fetched page text |
| Embeddings | `Xenova/all-MiniLM-L6-v2` (384-dim) run locally via transformers.js |

Embeddings are stored as raw `Float32Array` bytes in a BLOB column. They never
leave the database and are never sent to the client — the API exposes only a
`hasEmbedding` boolean.

## Data model

One table, `entries`. Fields split three ways:

**Yours** — `url`, `notes`, `whySaved` (why this looked worth reading),
`category`, `status` (`to-read` / `skimmed` / `read` / `revisit`), `rating` (1–5).

**Extracted by the LLM** — these exist so you can search and cluster later
without re-reading anything:

| Field | Why it's there |
| --- | --- |
| `title` | Canonical title, not the `<title>` tag's marketing version |
| `summary` | 2–3 sentences; what the thing actually argues |
| `keyClaims` | The specific claims, so you can scan without opening the paper |
| `tags` | Free-form topical tags for filtering |
| `authors`, `org`, `venue` | Provenance — who to trust, who to follow up with |
| `publishedAt` | Best-effort date; lets you sort by recency of the work, not of your bookmark |
| `contentType` | `paper` / `blog` / `post` / `docs` / `video` / `other` |

**System** — `embedding` (the vector), `rawText` (fetched page text, kept so a
re-summarize doesn't need a re-fetch), `ingestStatus` / `ingestError`, timestamps.

## Backup and restore

The vectors are the expensive part: losing them means re-embedding everything.
Both backup paths preserve them.

**Snapshot the database file** (safe to run while `npm run dev` is up — it uses
SQLite's online backup API, unlike `cp`):

```bash
npm run db:backup    # -> ./backups/research-<timestamp>.db, keeps the newest 10
```

Restore by stopping the dev server and copying a snapshot over
`./data/research.db` (delete any stale `-wal` / `-shm` sidecars first).

**Export / import as JSON** (portable, diffable, includes base64'd embeddings):

```bash
curl -OJ http://localhost:3000/api/export

# merge: existing ids are left alone, so your newer notes are never clobbered
curl -F file=@research-log-2026-09-10.json http://localhost:3000/api/import

# replace: wipe the table first
curl -F file=@research-log-2026-09-10.json 'http://localhost:3000/api/import?mode=replace'
```

The export is backup format **version 2**: `{ version, exportedAt, count,
entries, landscape }`, where `landscape` holds every Landscape table (topics,
searches and their stages / papers / clusters / edges / documents, papers, full
text, citations, extractions, LLM call history) except the disposable HTTP
cache. Vectors and cluster centroids are base64; JSON columns stay JSON. The
body is streamed row by row, but full text is usually most of the file — pass
`?fulltext=0` to leave it out (`curl -OJ 'http://localhost:3000/api/export?fulltext=0'`).
Import reads the whole file into memory and caps uploads at 256 MB.

Version 1 files (entries only) still import. On import:

- **Merge** never overwrites an existing row. Topics, searches and LLM calls
  with an existing id are skipped; a topic whose slug belongs to a *different*
  topic is imported with a `-2` suffix. Papers go through the dedupe resolver,
  so a paper you already have (same arXiv / DOI / S2 / OpenAlex id) is reused
  and every citation, extraction, full text and search row pointing at the
  incoming copy is remapped onto it. Searches whose topic is missing are skipped.
- **Replace** also wipes the Landscape tables — but only when the file has a
  `landscape` section, so restoring a v1 file never deletes Landscape data. A
  `?fulltext=0` export restored with replace leaves you without full text.
- Searches that were queued or running at export time come back as
  `interrupted` (resume them from the topic page).

Import responds with `{ imported, skipped, replaced, missingEmbeddings,
landscape? }` (`landscape` has per-table counts plus `skipped` details) and runs
in a single transaction — a malformed file gets a 400 and writes nothing.
Entries that arrive without a vector are stored with `embedding = null` rather
than blocking the request on a re-embed; backfill them afterwards:

```bash
npm run db:reembed
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run lint` | ESLint |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run db:generate` | Generate a Drizzle migration after editing `schema.ts` |
| `npm run db:backup` | Online snapshot to `./backups/`, pruned to 10 |
| `npm run db:reembed` | Backfill embeddings for entries that have none |
| `npm run db:scrub` | Strip stray markup from stored entries (local, no API calls) |

## Roadmap

- **Similarity / clustering graph view.** Every entry already carries a 384-dim
  vector, so a force-directed graph over pairwise cosine similarity is mostly a
  rendering problem — surface which papers cluster, and which reading you saved
  and never connected to anything else.
- Related-entries panel on each entry, backed by the same vectors.
- Semantic search over the log.

## A note on `npm audit`

`npm audit` reports advisories in two transitive dev/runtime dependencies:
`adm-zip` and `sharp` under `onnxruntime-node` (pulled in by
`@huggingface/transformers`), and `esbuild` under `drizzle-kit`. Both are
unfixable upstream without downgrading to a broken version, and neither is
reachable here: the esbuild issue is a dev-server-only cross-origin bug, and the
onnxruntime paths handle only the local model files. This app binds to localhost
and has no untrusted users.
