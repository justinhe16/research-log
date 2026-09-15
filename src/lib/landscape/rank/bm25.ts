/*
 * BM25F over two fields (title, abstract). Each field's term frequency is
 * length-normalized against that field's average length, weighted, and summed
 * into one pseudo-frequency per term, which then goes through the usual BM25
 * saturation:
 *
 *   tf'(t, d) = sum_f  w_f * tf_f(t, d) / (1 - b + b * len_f(d) / avgLen_f)
 *   score(d)  = sum_t  idf(t) * tf' / (k1 + tf')
 *   idf(t)    = ln(1 + (N - df + 0.5) / (df + 0.5))        (never negative)
 *
 * df counts documents containing the term in any field.
 */

import { BM25_B, BM25_K1, BM25_TITLE_WEIGHT } from "../constants";
import { tokenize } from "./tokenize";

export type Bm25Field = "title" | "abstract";
const FIELDS: readonly Bm25Field[] = ["title", "abstract"];

export type Bm25Doc = {
  id: string;
  fields: { title: string | null | undefined; abstract: string | null | undefined };
};

export type Bm25Options = {
  k1?: number;
  b?: number;
  fieldWeights?: Partial<Record<Bm25Field, number>>;
};

type IndexedDoc = {
  id: string;
  tf: Record<Bm25Field, Map<string, number>>;
  len: Record<Bm25Field, number>;
};

export type Bm25Index = {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: Record<Bm25Field, number>;
  k1: number;
  b: number;
  fieldWeights: Record<Bm25Field, number>;
};

export type Bm25Score = { id: string; score: number };

function countTerms(terms: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function buildBm25Index(docs: Bm25Doc[], opts: Bm25Options = {}): Bm25Index {
  const fieldWeights: Record<Bm25Field, number> = {
    title: opts.fieldWeights?.title ?? BM25_TITLE_WEIGHT,
    abstract: opts.fieldWeights?.abstract ?? 1,
  };
  const df = new Map<string, number>();
  const totalLen: Record<Bm25Field, number> = { title: 0, abstract: 0 };

  const indexed: IndexedDoc[] = docs.map((doc) => {
    const tf = {} as IndexedDoc["tf"];
    const len = {} as IndexedDoc["len"];
    const seen = new Set<string>();
    for (const f of FIELDS) {
      const terms = tokenize(doc.fields[f] ?? "");
      tf[f] = countTerms(terms);
      len[f] = terms.length;
      totalLen[f] += terms.length;
      for (const t of tf[f].keys()) seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    return { id: doc.id, tf, len };
  });

  const n = indexed.length;
  return {
    docs: indexed,
    df,
    avgLen: {
      title: n ? totalLen.title / n : 0,
      abstract: n ? totalLen.abstract / n : 0,
    },
    k1: opts.k1 ?? BM25_K1,
    b: opts.b ?? BM25_B,
    fieldWeights,
  };
}

export function bm25Idf(index: Bm25Index, term: string): number {
  const n = index.docs.length;
  const df = index.df.get(term) ?? 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function termScore(index: Bm25Index, doc: IndexedDoc, term: string, idf: number): number {
  let tfPrime = 0;
  for (const f of FIELDS) {
    const tf = doc.tf[f].get(term);
    if (!tf) continue;
    const avg = index.avgLen[f];
    const norm = avg > 0 ? 1 - index.b + (index.b * doc.len[f]) / avg : 1;
    tfPrime += (index.fieldWeights[f] * tf) / norm;
  }
  if (tfPrime === 0) return 0;
  return (idf * tfPrime) / (index.k1 + tfPrime);
}

/** Accepts raw query strings or pre-tokenized terms; strings are tokenized. */
function toTerms(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const list = typeof input === "string" ? [input] : input;
  // Dedupe: repeating a query term shouldn't multiply its weight.
  return [...new Set(list.flatMap((s) => tokenize(s)))];
}

export type ScoreBm25Options = {
  /** Terms whose presence penalizes a document (the topic's "exclude" list). */
  excludeTerms?: string | string[];
  /** Multiplier on the subtracted BM25 mass of exclude terms. Default 1. */
  excludeWeight?: number;
};

/**
 * Score every indexed document. Exclude terms subtract their own BM25
 * contribution (times `excludeWeight`), so a matching document can go negative.
 * Result is sorted by score descending; ties keep index order. Query terms go
 * through `tokenize`, so pass raw phrases (or already-tokenized terms, which
 * tokenize to themselves).
 */
export function scoreBm25(
  index: Bm25Index,
  queryTerms: string | string[],
  opts: ScoreBm25Options = {},
): Bm25Score[] {
  const exclude = toTerms(opts.excludeTerms);
  const excludeSet = new Set(exclude);
  const query = toTerms(queryTerms).filter((t) => !excludeSet.has(t));
  const excludeWeight = opts.excludeWeight ?? 1;

  const qIdf = query.map((t) => [t, bm25Idf(index, t)] as const);
  const xIdf = exclude.map((t) => [t, bm25Idf(index, t)] as const);

  const scored = index.docs.map((doc, i) => {
    let score = 0;
    for (const [t, idf] of qIdf) score += termScore(index, doc, t, idf);
    for (const [t, idf] of xIdf) score -= excludeWeight * termScore(index, doc, t, idf);
    return { id: doc.id, score, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map(({ id, score }) => ({ id, score }));
}
