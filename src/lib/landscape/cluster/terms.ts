/*
 * Cluster key terms via class-based TF-IDF (c-TF-IDF, as in BERTopic): all
 * docs in a cluster are concatenated into one "class document", and a term
 * scores tf(term, class) · log(1 + avgClassLength / freq(term, all classes)).
 * Unigrams and bigrams; stopwords removed. Pure and synchronous.
 */

import { CLUSTER_KEY_TERMS } from "../constants";

export type ClusterDoc = { clusterIdx: number; text: string };

export type ClusterKeyTermsOptions = {
  topN?: number;
  /** Override the built-in tokenizer. Must return lowercase tokens in order, stopwords removed. */
  tokenize?: (text: string) => string[];
};

// Kept local on purpose (the ranking tokenizer lives elsewhere); includes
// academic boilerplate that would otherwise top every cluster.
const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between
both but by can could did do does doing down during each either et few for from further had has have having he her
here hers herself him himself his how however i if in into is it its itself just may me might more most much must my
myself no nor not now of off on once only or other our ours ourselves out over own per same she should so some such
than that the their theirs them themselves then there these they this those through thus to too under until up upon
us very via was we were what when where which while who whom why will with within without would yet you your yours
al paper papers work works approach approaches method methods propose proposed proposes present presents show shows
shown result results use used uses using based new novel study studies however furthermore moreover existing
different various well also first second one two three many several recent recently provide provides task tasks
problem problems model models performance demonstrate demonstrates achieve achieves state art experiments experimental
significantly significant introduce introduces address addresses paper's can't don't it's allow allows enable enables
`.split(/\s+/).filter(Boolean),
);

/** Minimal tokenizer: lowercase alphanumeric runs (inner hyphens kept), no stopwords, no pure numbers, length ≥ 2. */
export function tokenizeForTerms(text: string): string[] {
  return segmentsForTerms(text).flat();
}

/** Token runs split wherever a stopword / number was removed, so bigrams never bridge a gap. */
function segmentsForTerms(text: string): string[][] {
  const raw = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const segments: string[][] = [[]];
  for (const t of raw) {
    if (t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t)) segments[segments.length - 1].push(t);
    else if (segments[segments.length - 1].length > 0) segments.push([]);
  }
  return segments.filter((s) => s.length > 0);
}

function ngrams(segments: string[][]): string[] {
  const out = segments.flat();
  for (const tokens of segments) {
    for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

/**
 * Top key terms per cluster. Result is indexed by clusterIdx (0..max idx);
 * clusters with no docs get an empty array. Terms that occur in ≥2 of the
 * cluster's docs are preferred over one-off terms; a unigram already contained
 * in a higher-ranked bigram is skipped to avoid "graph", "graph neural".
 */
export function clusterKeyTerms(docs: readonly ClusterDoc[], opts: ClusterKeyTermsOptions = {}): string[][] {
  const topN = opts.topN ?? CLUSTER_KEY_TERMS;
  const segment = opts.tokenize ? (text: string) => [opts.tokenize!(text)] : segmentsForTerms;
  const k = docs.reduce((m, d) => Math.max(m, d.clusterIdx + 1), 0);
  if (k === 0) return [];

  const counts: Map<string, number>[] = Array.from({ length: k }, () => new Map());
  const docFreq: Map<string, number>[] = Array.from({ length: k }, () => new Map());
  const lengths = new Array<number>(k).fill(0);
  const docCount = new Array<number>(k).fill(0);
  const global = new Map<string, number>();

  for (const d of docs) {
    if (d.clusterIdx < 0) continue;
    const grams = ngrams(segment(d.text));
    docCount[d.clusterIdx]++;
    lengths[d.clusterIdx] += grams.length;
    for (const g of grams) {
      counts[d.clusterIdx].set(g, (counts[d.clusterIdx].get(g) ?? 0) + 1);
      global.set(g, (global.get(g) ?? 0) + 1);
    }
    for (const g of new Set(grams)) docFreq[d.clusterIdx].set(g, (docFreq[d.clusterIdx].get(g) ?? 0) + 1);
  }

  const nonEmpty = lengths.filter((l) => l > 0);
  const avgLen = nonEmpty.length ? nonEmpty.reduce((a, b) => a + b, 0) / nonEmpty.length : 0;

  return counts.map((termCounts, c) => {
    if (lengths[c] === 0) return [];
    const minDf = Math.min(2, docCount[c]);
    const scored = [...termCounts].map(([term, count]) => ({
      term,
      score: (count / lengths[c]) * Math.log(1 + avgLen / global.get(term)!),
      df: docFreq[c].get(term) ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    const ordered = [...scored.filter((s) => s.df >= minDf), ...scored.filter((s) => s.df < minDf)];

    const picked: string[] = [];
    const coveredByBigram = new Set<string>();
    for (const { term } of ordered) {
      if (picked.length >= topN) break;
      const parts = term.split(" ");
      if (parts.length === 1 && coveredByBigram.has(term)) continue;
      if (parts.length === 2) {
        // Drop already-picked unigrams this bigram subsumes.
        for (const p of parts) {
          coveredByBigram.add(p);
          const at = picked.indexOf(p);
          if (at >= 0) picked.splice(at, 1);
        }
      }
      picked.push(term);
    }
    return picked;
  });
}

/** Heuristic cluster label from key terms, e.g. "Graph neural / message passing". */
export function placeholderLabel(terms: readonly string[]): string {
  const chosen: string[] = [];
  const words = new Set<string>();
  for (const t of terms) {
    const parts = t.split(" ");
    if (parts.some((p) => words.has(p))) continue;
    chosen.push(t);
    parts.forEach((p) => words.add(p));
    if (chosen.length === 2) break;
  }
  if (chosen.length === 0) return "Untitled cluster";
  const label = chosen.join(" / ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
