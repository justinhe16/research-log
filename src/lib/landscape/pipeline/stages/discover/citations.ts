import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { papers, searchPapers } from "@/lib/db/schema";
import { upsertPapers } from "@/lib/landscape/papers/repo";
import type { S2CitationLink, S2Paper } from "@/lib/landscape/sources/semantic-scholar";
import { embedPool, prerankPool } from "./prerank";
import { chunks, errMessage, rethrowIfCancelled, tx, warn, yieldNow, s2LookupId, type Env } from "./shared";

/*
 * Stage 6 (citations): follow S2 references + citations out of the top prerank
 * seeds and admit papers that link to >= minSeedLinks seeds or are cited
 * influentially. Deep runs a second hop from the best hop-1 admissions.
 *
 * Resume: per hop, the seed list, processed seeds and admissions are
 * checkpointed. Link lists are not (they can be thousands of records); a resumed
 * hop re-requests already-processed seeds, which the api_cache answers without
 * touching the network.
 */

type HopState = { seeds: string[]; processed: string[]; admitted: string[]; done: boolean };
type CitationsCheckpoint = { hops: Record<string, HopState> };

type SeedRow = { id: string; s2Id: string | null; arxivId: string | null; doi: string | null };
type Link = S2CitationLink & { seedId: string; dir: "references" | "citations" };

function readCheckpoint(raw: Record<string, unknown> | null): CitationsCheckpoint {
  const hops = (raw?.hops ?? {}) as Record<string, Partial<HopState>>;
  const out: CitationsCheckpoint = { hops: {} };
  for (const [k, v] of Object.entries(hops)) {
    out.hops[k] = {
      seeds: Array.isArray(v.seeds) ? v.seeds : [],
      processed: Array.isArray(v.processed) ? v.processed : [],
      admitted: Array.isArray(v.admitted) ? v.admitted : [],
      done: v.done === true,
    };
  }
  return out;
}

function seedRows(db: Db, ids: string[]): SeedRow[] {
  const byId = new Map<string, SeedRow>();
  for (const part of chunks(ids, 500)) {
    for (const r of db
      .select({ id: papers.id, s2Id: papers.s2Id, arxivId: papers.arxivId, doi: papers.doi })
      .from(papers)
      .where(inArray(papers.id, part))
      .all()) {
      byId.set(r.id, r);
    }
  }
  return ids.map((id) => byId.get(id)).filter((r): r is SeedRow => !!r);
}

function topByRrf(env: Env, limit: number, among?: string[]): string[] {
  if (limit <= 0) return [];
  const { db, ctx } = env;
  const where = among
    ? and(eq(searchPapers.searchId, ctx.searchId), inArray(searchPapers.paperId, among.length ? among : [""]))
    : eq(searchPapers.searchId, ctx.searchId);
  return db
    .select({ id: searchPapers.paperId })
    .from(searchPapers)
    .where(where)
    .orderBy(desc(sql`coalesce(${searchPapers.rrf}, 0)`), searchPapers.paperId)
    .limit(limit)
    .all()
    .map((r) => r.id);
}

/** Map S2 papers to existing `papers.id`s by s2 id, then arXiv id, then DOI. */
function resolveExisting(db: Db, list: S2Paper[]): Map<S2Paper, string> {
  const out = new Map<S2Paper, string>();
  const lookup = (col: typeof papers.s2Id | typeof papers.arxivId | typeof papers.doi, key: (p: S2Paper) => string | null | undefined) => {
    const pending = list.filter((p) => !out.has(p) && key(p));
    const values = [...new Set(pending.map((p) => key(p)!))];
    const found = new Map<string, string>();
    for (const part of chunks(values, 500)) {
      for (const r of db.select({ id: papers.id, v: col }).from(papers).where(inArray(col, part)).all()) {
        if (r.v) found.set(r.v, r.id);
      }
    }
    for (const p of pending) {
      const id = found.get(key(p)!);
      if (id) out.set(p, id);
    }
  };
  lookup(papers.s2Id, (p) => p.s2Id);
  lookup(papers.arxivId, (p) => p.arxivId);
  lookup(papers.doi, (p) => p.doi);
  return out;
}

async function fetchLinks(env: Env, seeds: SeedRow[], state: HopState, hopKey: string, cp: CitationsCheckpoint, onSeed: (i: number) => void): Promise<Link[]> {
  const { ctx, deps, db } = env;
  const links: Link[] = [];
  const processed = new Set(state.processed);
  let failures = 0;
  for (let i = 0; i < seeds.length; i++) {
    ctx.throwIfCancelled();
    const seed = seeds[i];
    const lookupId = s2LookupId(seed);
    if (!lookupId) {
      onSeed(i);
      continue;
    }
    const opts = { limit: deps.citationLinkLimit, cache: { db }, signal: ctx.signal };
    try {
      const [refs, cits] = [await deps.s2References(lookupId, opts), await deps.s2Citations(lookupId, opts)];
      for (const l of refs) links.push({ ...l, seedId: seed.id, dir: "references" });
      for (const l of cits) links.push({ ...l, seedId: seed.id, dir: "citations" });
    } catch (err) {
      rethrowIfCancelled(ctx, err);
      failures++;
      warn(ctx, `citation lookup failed for seed ${lookupId}: ${errMessage(err)}`);
    }
    if (!processed.has(seed.id)) {
      processed.add(seed.id);
      state.processed = [...processed];
      cp.hops[hopKey] = state;
      ctx.saveCheckpoint({ hops: cp.hops });
    }
    onSeed(i);
    await yieldNow();
  }
  if (seeds.length && failures === seeds.length) warn(ctx, "citation expansion failed for every seed");
  return links;
}

/** Admit candidates, write them to the pool, and store citation edges. Returns admitted ids. */
async function admit(env: Env, links: Link[], remaining: number): Promise<string[]> {
  const { db, ctx } = env;
  const { minSeedLinks } = ctx.config.citations;

  const poolIds = new Set(
    db.select({ id: searchPapers.paperId }).from(searchPapers).where(eq(searchPapers.searchId, ctx.searchId)).all().map((r) => r.id),
  );

  // One representative S2Paper per S2 id.
  const byKey = new Map<string, { paper: S2Paper; seeds: Set<string>; influential: boolean }>();
  for (const l of links) {
    const key = l.paper.s2Id!;
    let c = byKey.get(key);
    if (!c) byKey.set(key, (c = { paper: l.paper, seeds: new Set(), influential: false }));
    if (l.paper !== c.paper) l.paper = c.paper;
    c.seeds.add(l.seedId);
    c.influential ||= l.isInfluential;
  }
  const candidates = [...byKey.values()];
  const existing = resolveExisting(db, candidates.map((c) => c.paper));

  const eligible = candidates
    .filter((c) => !poolIds.has(existing.get(c.paper) ?? "") && !c.seeds.has(existing.get(c.paper) ?? ""))
    .filter((c) => c.seeds.size >= minSeedLinks || c.influential)
    .sort(
      (a, b) =>
        b.seeds.size - a.seeds.size ||
        Number(b.influential) - Number(a.influential) ||
        (b.paper.citationCount ?? 0) - (a.paper.citationCount ?? 0) ||
        a.paper.s2Id!.localeCompare(b.paper.s2Id!),
    )
    .slice(0, Math.max(0, remaining));

  const admitted: string[] = [];
  for (const part of chunks(eligible)) {
    const ids = upsertPapers(db, part.map((c) => c.paper));
    tx(db, () => {
      ids.forEach((id, i) => {
        existing.set(part[i].paper, id);
        const res = db
          .insert(searchPapers)
          .values({ searchId: ctx.searchId, paperId: id, origin: "citation" })
          .onConflictDoNothing()
          .run();
        if (res.changes > 0) admitted.push(id);
      });
    });
    await yieldNow();
  }

  // Edges, only where both ends are known papers.
  const edges: { citing: string; cited: string; influential: boolean; intents: string[] }[] = [];
  for (const l of links) {
    const other = existing.get(l.paper);
    if (!other || other === l.seedId) continue;
    edges.push(
      l.dir === "references"
        ? { citing: l.seedId, cited: other, influential: l.isInfluential, intents: l.intents }
        : { citing: other, cited: l.seedId, influential: l.isInfluential, intents: l.intents },
    );
  }
  for (const part of chunks(edges)) {
    tx(db, () => {
      for (const e of part) {
        db.run(sql`
          INSERT INTO paper_citations (citing_id, cited_id, is_influential, intents, created_at)
          VALUES (${e.citing}, ${e.cited}, ${e.influential ? 1 : 0}, ${JSON.stringify(e.intents)}, ${new Date().toISOString()})
          ON CONFLICT (citing_id, cited_id) DO UPDATE SET is_influential = max(is_influential, excluded.is_influential)
        `);
      }
    });
    await yieldNow();
  }
  return admitted;
}

export async function citationsStage(env: Env): Promise<void | "skipped"> {
  const { ctx, db } = env;
  const { hops, seeds: hop1Seeds, hop2Seeds, maxAdmitted } = ctx.config.citations;
  if (hops === 0 || hop1Seeds <= 0 || maxAdmitted <= 0) return "skipped";

  const cp = readCheckpoint(ctx.checkpoint);
  const totalAdmitted = () => Object.values(cp.hops).reduce((n, h) => n + h.admitted.length, 0);

  for (let hop = 1; hop <= hops; hop++) {
    ctx.throwIfCancelled();
    const key = String(hop);
    const state: HopState = cp.hops[key] ?? { seeds: [], processed: [], admitted: [], done: false };
    if (state.done) continue;

    if (!state.seeds.length) {
      state.seeds = hop === 1 ? topByRrf(env, hop1Seeds) : topByRrf(env, hop2Seeds, cp.hops["1"]?.admitted ?? []);
      cp.hops[key] = state;
      ctx.saveCheckpoint({ hops: cp.hops });
    }
    const seeds = seedRows(db, state.seeds);
    const remaining = maxAdmitted - totalAdmitted() + state.admitted.length;

    if (seeds.length && remaining > 0) {
      const links = await fetchLinks(env, seeds, state, key, cp, (i) =>
        ctx.setStageProgress(((hop - 1) + ((i + 1) / seeds.length) * 0.8) / hops),
      );
      ctx.throwIfCancelled();
      const admitted = await admit(env, links, remaining - state.admitted.length);
      state.admitted = [...new Set([...state.admitted, ...admitted])];
      cp.hops[key] = state;
      ctx.saveCheckpoint({ hops: cp.hops });
      ctx.updateCounters({ citationAdmitted: totalAdmitted() });

      if (state.admitted.length) {
        await embedPool(env);
        ctx.throwIfCancelled();
        const n = await prerankPool(env);
        ctx.updateCounters({ candidates: n, citationAdmitted: totalAdmitted() });
      }
    }
    state.done = true;
    cp.hops[key] = state;
    ctx.saveCheckpoint({ hops: cp.hops });
    ctx.setStageProgress(hop / hops);
  }
  ctx.updateCounters({ citationAdmitted: totalAdmitted() });
  ctx.setStageProgress(1);
}
