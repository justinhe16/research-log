import type { Db } from "@/lib/db/create";
import { topics } from "@/lib/db/schema";
import { cosine, embed, fromBuffer } from "@/lib/embedding";
import { TOPIC_SIMILARITY_THRESHOLD } from "./constants";
import type { SimilarTopic } from "./types";

/*
 * Topic dedupe (plan: "warn and let you choose"). MiniLM cosine on
 * name + description, plus one cheap lexical heuristic for acronyms, because a
 * short acronym embeds nowhere near its expansion ("RAG" vs
 * "Retrieval-Augmented Generation" scores well under the threshold).
 */

export type EmbedFn = (text: string) => Promise<Float32Array>;

/** The exact text embedded into `topics.embedding`. Keep stable: changing it
 *  invalidates every stored topic vector. */
export function topicEmbeddingText(name: string, description?: string | null): string {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  const d = (description ?? "").replace(/\s+/g, " ").trim();
  return d ? `${n}. ${d}` : n;
}

// ---------------------------------------------------------------------------
// Acronym heuristic
// ---------------------------------------------------------------------------

/** Words skipped when forming initials ("Reinforcement Learning from Human Feedback" -> RLHF). */
const INITIALS_STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "from", "in", "on", "to", "with", "by", "via", "at", "or",
]);

/** A name "is an acronym" when it is a single token of 2-8 letters/digits, e.g. "RAG", "RLHF", "GNNs". */
function asAcronym(name: string): string | null {
  const s = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9]{1,7}$/.test(s)) return null;
  // Allow a trailing plural "s" on an uppercase acronym: "LLMs" -> "llm".
  const depluralized = /^[A-Z0-9]{2,}s$/.test(s) ? s.slice(0, -1) : s;
  return depluralized.toLowerCase();
}

/** Initials of a multi-word phrase (hyphens split words). Returns both the
 *  stopword-free and the all-words variants; null for fewer than 2 words. */
function initialsOf(phrase: string): string[] {
  const words = phrase
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length < 2) return [];
  const all = words.map((w) => w[0]).join("");
  const content = words.filter((w) => !INITIALS_STOPWORDS.has(w)).map((w) => w[0]).join("");
  return content === all ? [all] : [content, all];
}

/** Name variants: the name without parentheticals, plus each parenthetical
 *  ("Retrieval-Augmented Generation (RAG)" -> ["Retrieval-Augmented Generation", "RAG"]). */
function nameVariants(name: string): string[] {
  const out = [name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim()];
  for (const m of name.matchAll(/\(([^)]+)\)/g)) out.push(m[1].trim());
  return out.filter(Boolean);
}

/**
 * True when one topic name is an acronym of the other: a single 2-8 char token
 * whose letters equal the initials of the other name's words (stopwords like
 * "of"/"from" may be skipped or kept), or when either name carries the other as a
 * parenthetical alias. Case-insensitive. Deliberately strict: it only
 * compares initials, so "RLHF" vs "reward hacking" (initials "rh") never matches.
 *
 * Known false positives: any unrelated phrase whose initials happen to spell the
 * acronym, e.g. "GAN" vs "Graph Attention Networks" or "RL" vs "Robust Learning".
 * These are accepted because a match only surfaces a "Similar to X" warning; the
 * user can still create the topic anyway.
 */
export function isAcronymMatch(a: string, b: string): boolean {
  const va = nameVariants(a ?? "");
  const vb = nameVariants(b ?? "");
  for (const x of va) {
    for (const y of vb) {
      if (oneWay(x, y) || oneWay(y, x)) return true;
      // Shared parenthetical alias / identical acronyms ("RAG" vs "... (RAG)").
      const ax = asAcronym(x);
      if (ax && ax === asAcronym(y) && (va.length > 1 || vb.length > 1)) return true;
    }
  }
  return false;
}

function oneWay(acronymSide: string, phraseSide: string): boolean {
  const acr = asAcronym(acronymSide);
  if (!acr) return false;
  return initialsOf(phraseSide).includes(acr);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type SimilarityCandidate = Omit<SimilarTopic, "similarity"> & {
  /** Stored topic vector; null/undefined for topics embedded before the model loaded. */
  vector: Float32Array | null | undefined;
};

export type RankSimilarOptions = {
  threshold?: number;
  excludeId?: string;
  limit?: number;
  /** Proposed topic name; enables the acronym heuristic. */
  queryName?: string;
};

/**
 * Pure ranking: cosine of `queryVec` against each candidate, filtered to
 * `>= threshold`, sorted descending (ties: name), capped at `limit`.
 *
 * Acronym boost: when `queryName` and a candidate's name are acronym matches
 * (see `isAcronymMatch`), the score is floored at the threshold, so the pair is
 * always reported even if the embeddings disagree (or the candidate has no vector).
 * It never lowers a higher cosine.
 */
export function rankSimilar(
  queryVec: Float32Array | null,
  candidates: SimilarityCandidate[],
  { threshold = TOPIC_SIMILARITY_THRESHOLD, excludeId, limit = 5, queryName }: RankSimilarOptions = {},
): SimilarTopic[] {
  const scored: SimilarTopic[] = [];
  for (const { vector, ...c } of candidates) {
    if (excludeId && c.id === excludeId) continue;
    let score = queryVec && vector ? cosine(queryVec, vector) : 0;
    if (queryName && isAcronymMatch(queryName, c.name)) score = Math.max(score, threshold);
    if (score < threshold) continue;
    scored.push({ ...c, similarity: Math.max(0, Math.min(1, score)) });
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(0, limit));
}

export type FindSimilarOptions = RankSimilarOptions;

/** Scan every topic's stored embedding. Topic counts are small (tens to
 *  hundreds), so a linear scan beats any index. */
export function findSimilarTopics(
  db: Db,
  vector: Float32Array | null,
  opts: FindSimilarOptions = {},
): SimilarTopic[] {
  const rows = db
    .select({
      id: topics.id,
      slug: topics.slug,
      name: topics.name,
      description: topics.description,
      embedding: topics.embedding,
      lastSearchAt: topics.lastSearchAt,
      paperCount: topics.paperCount,
    })
    .from(topics)
    .all();

  const candidates: SimilarityCandidate[] = rows.map(({ embedding, ...r }) => {
    let vec: Float32Array | null = null;
    if (embedding) {
      try {
        vec = fromBuffer(embedding);
      } catch {
        vec = null; // corrupt blob: fall back to the name heuristic only
      }
    }
    return { ...r, vector: vec };
  });
  return rankSimilar(vector, candidates, opts);
}

/**
 * Embed a proposed name + description and find similar topics. `embedFn`
 * defaults to the local MiniLM `embed`; tests inject literal vectors. If
 * embedding fails, falls back to the acronym heuristic alone rather than
 * blocking topic creation.
 */
export async function findSimilarTopicsFor(
  db: Db,
  input: { name: string; description?: string | null },
  opts: Omit<FindSimilarOptions, "queryName"> = {},
  embedFn: EmbedFn = embed,
): Promise<{ similar: SimilarTopic[]; embedding: Float32Array | null }> {
  let vector: Float32Array | null = null;
  try {
    vector = await embedFn(topicEmbeddingText(input.name, input.description));
  } catch {
    vector = null;
  }
  const similar = findSimilarTopics(db, vector, { ...opts, queryName: input.name });
  return { similar, embedding: vector };
}
