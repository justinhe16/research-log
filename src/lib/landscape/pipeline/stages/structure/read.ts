/*
 * Stages 11-12 (fulltext, extract): fetch PDFs for the top selected papers, then
 * extract every selected paper, cache-first against paper_extractions.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/create";
import { paperExtractions, paperFulltext, searchPapers } from "@/lib/db/schema";
import { EXTRACT_MAX_FAILURE_RATE, EXTRACTION_MODEL, EXTRACTION_VERSION, FULLTEXT_MAX_CHARS } from "@/lib/landscape/constants";
import { sourceHash, type ExtractionFields, type ExtractPaperInput } from "@/lib/landscape/llm/extract";
import { excerptForExtraction } from "@/lib/landscape/sources/pdf";
import type { StageContext } from "@/lib/landscape/types";
import {
  chunks,
  errorMessage,
  loadPool,
  rethrowIfAborted,
  resolveDb,
  warn,
  yieldLoop,
  type PoolPaper,
  type StructureDeps,
} from "./shared";

// ---------------------------------------------------------------------------
// fulltext
// ---------------------------------------------------------------------------

function existingFulltext(db: Db, ids: string[]): Map<string, { hash: string; text: string }> {
  const out = new Map<string, { hash: string; text: string }>();
  for (const group of chunks(ids, 500)) {
    const rows = db
      .select({ paperId: paperFulltext.paperId, hash: paperFulltext.hash, text: paperFulltext.text })
      .from(paperFulltext)
      .where(inArray(paperFulltext.paperId, group))
      .all();
    for (const r of rows) out.set(r.paperId, { hash: r.hash, text: r.text });
  }
  return out;
}

export async function fulltextStage(ctx: StageContext, deps: StructureDeps): Promise<void | "skipped"> {
  const m = ctx.config.fulltextCount;
  if (m <= 0) return "skipped";
  const db = await resolveDb(ctx, deps);
  const top = loadPool(db, ctx.searchId, { selectedOnly: true }).slice(0, m);
  if (top.length === 0) return "skipped";

  const have = new Set(existingFulltext(db, top.map((p) => p.paperId)).keys());
  let fetched = have.size;
  ctx.updateCounters({ fulltextFetched: fetched });

  let done = 0;
  for (const p of top) {
    ctx.throwIfCancelled();
    if (!have.has(p.paperId)) {
      try {
        const pdf = await deps.fetchPaperPdf(
          { arxivId: p.paper.arxivId, pdfUrl: p.paper.pdfUrl },
          { signal: ctx.signal },
        );
        if (!pdf) {
          warn(ctx, `fulltext: no PDF source for ${p.paperId}; using the abstract`);
        } else {
          const { text: raw } = await deps.extractPdfText(pdf.bytes);
          const clean = raw.trim();
          if (clean.length < 500) throw new Error(`PDF yielded too little text (${clean.length} chars)`);
          const truncated = clean.length > FULLTEXT_MAX_CHARS;
          const text = truncated ? clean.slice(0, FULLTEXT_MAX_CHARS) : clean;
          const source = pdf.via === "arxiv" ? "arxiv" : safeHost(pdf.url);
          db.insert(paperFulltext)
            .values({
              paperId: p.paperId,
              text,
              source,
              sourceUrl: pdf.url,
              hash: sourceHash(text),
              truncated,
              fetchedAt: deps.now().toISOString(),
            })
            .onConflictDoNothing()
            .run();
          fetched++;
          ctx.updateCounters({ fulltextFetched: fetched });
        }
      } catch (err) {
        rethrowIfAborted(ctx, err);
        warn(ctx, `fulltext: ${p.paperId} failed, falling back to the abstract: ${errorMessage(err)}`);
      }
    }
    done++;
    ctx.setStageProgress(done / top.length);
    await yieldLoop();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "pdf";
  }
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

type Source = "abstract" | "fulltext";

function findCached(db: Db, paperId: string, source: Source, hash: string): string | null {
  return (
    db
      .select({ id: paperExtractions.id })
      .from(paperExtractions)
      .where(
        and(
          eq(paperExtractions.paperId, paperId),
          eq(paperExtractions.version, EXTRACTION_VERSION),
          eq(paperExtractions.source, source),
          eq(paperExtractions.sourceHash, hash),
        ),
      )
      .get()?.id ?? null
  );
}

/** Insert (or find, if a concurrent run beat us) an extraction; returns its id. */
function storeExtraction(db: Db, paperId: string, source: Source, hash: string, fields: ExtractionFields, now: Date): string {
  const id = crypto.randomUUID();
  db.insert(paperExtractions)
    .values({
      id,
      paperId,
      version: EXTRACTION_VERSION,
      source,
      sourceHash: hash,
      model: EXTRACTION_MODEL,
      problem: fields.problem,
      method: fields.method,
      results: fields.results,
      contribution: fields.contribution,
      limitations: fields.limitations,
      datasets: fields.datasets,
      benchmarks: fields.benchmarks,
      createdAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return findCached(db, paperId, source, hash) ?? id;
}

function link(db: Db, searchId: string, paperId: string, extractionId: string): void {
  db.update(searchPapers)
    .set({ extractionId })
    .where(and(eq(searchPapers.searchId, searchId), eq(searchPapers.paperId, paperId)))
    .run();
}

function toInput(p: PoolPaper): ExtractPaperInput {
  return { paperId: p.paperId, title: p.paper.title, year: p.paper.year, venue: p.paper.venue, abstract: p.paper.abstract };
}

export const abstractHash = (abstract: string | null | undefined) => sourceHash(abstract ?? "");

export async function extractStage(ctx: StageContext, deps: StructureDeps): Promise<void | "skipped"> {
  const db = await resolveDb(ctx, deps);
  const selected = loadPool(db, ctx.searchId, { selectedOnly: true });
  if (selected.length === 0) return "skipped";
  const total = selected.length;
  const fulltext = existingFulltext(db, selected.map((p) => p.paperId));

  let cacheHits = 0;
  let extracted = 0;
  const failed = new Set<string>();
  const fulltextMisses: PoolPaper[] = [];
  const abstractMisses: PoolPaper[] = [];
  const report = () => {
    ctx.updateCounters({ extracted, extractionCacheHits: cacheHits, extractionFailed: failed.size });
    ctx.setStageProgress((extracted + failed.size) / total);
  };

  // Cache pass: full text preferred, then abstract.
  const lookupAbstract = (p: PoolPaper): boolean => {
    const hit = findCached(db, p.paperId, "abstract", abstractHash(p.paper.abstract));
    if (!hit) return false;
    link(db, ctx.searchId, p.paperId, hit);
    return true;
  };
  for (const p of selected) {
    const ft = fulltext.get(p.paperId);
    if (ft) {
      const hit = findCached(db, p.paperId, "fulltext", ft.hash);
      if (hit) {
        link(db, ctx.searchId, p.paperId, hit);
        cacheHits++;
        extracted++;
      } else fulltextMisses.push(p);
    } else if (lookupAbstract(p)) {
      cacheHits++;
      extracted++;
    } else abstractMisses.push(p);
  }
  report();
  await yieldLoop();

  // Full text: one paper per call. A failure falls back to the abstract path.
  for (const p of fulltextMisses) {
    ctx.throwIfCancelled();
    const ft = fulltext.get(p.paperId)!;
    try {
      const fields = await deps.extractFulltext(toInput(p), excerptForExtraction(ft.text), {
        recorder: ctx.recorder,
        signal: ctx.signal,
      });
      link(db, ctx.searchId, p.paperId, storeExtraction(db, p.paperId, "fulltext", ft.hash, fields, deps.now()));
      extracted++;
    } catch (err) {
      rethrowIfAborted(ctx, err);
      warn(ctx, `extract: full-text extraction failed for ${p.paperId}, using the abstract: ${errorMessage(err)}`);
      if (lookupAbstract(p)) {
        cacheHits++;
        extracted++;
      } else abstractMisses.push(p);
    }
    report();
    await yieldLoop();
  }

  // Abstracts: batched.
  if (abstractMisses.length) {
    ctx.throwIfCancelled();
    const byId = new Map(abstractMisses.map((p) => [p.paperId, p]));
    const { failures } = await deps.runExtractions(abstractMisses.map(toInput), {
      recorder: ctx.recorder,
      signal: ctx.signal,
      onResult: (paperId, fields) => {
        const p = byId.get(paperId);
        if (!p) return;
        link(db, ctx.searchId, paperId, storeExtraction(db, paperId, "abstract", abstractHash(p.paper.abstract), fields, deps.now()));
        extracted++;
        report();
      },
    });
    for (const f of failures) {
      failed.add(f.paperId);
      warn(ctx, `extract: ${f.paperId} failed: ${f.error}`);
    }
  }
  report();

  const rate = failed.size / total;
  if (rate > EXTRACT_MAX_FAILURE_RATE) {
    throw new Error(
      `Extraction failed for ${failed.size} of ${total} papers (${Math.round(rate * 100)}% > ${Math.round(EXTRACT_MAX_FAILURE_RATE * 100)}%).`,
    );
  }
  ctx.log(`extract: ${extracted}/${total} extracted (${cacheHits} cached, ${failed.size} failed)`);
}
