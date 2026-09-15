import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { topics } from "@/lib/db/schema";
import { toBuffer } from "@/lib/embedding";
import { TOPIC_SIMILARITY_THRESHOLD } from "@/lib/landscape/constants";
import {
  findSimilarTopics,
  findSimilarTopicsFor,
  isAcronymMatch,
  rankSimilar,
  topicEmbeddingText,
  type SimilarityCandidate,
} from "@/lib/landscape/topic-dedupe";

const v = (...xs: number[]) => Float32Array.from(xs);

function cand(id: string, name: string, vector: Float32Array | null): SimilarityCandidate {
  return { id, slug: id, name, description: "", lastSearchAt: null, paperCount: 0, vector };
}

describe("topicEmbeddingText", () => {
  it("joins name and description, collapsing whitespace", () => {
    expect(topicEmbeddingText("  Diffusion  models ", "")).toBe("Diffusion models");
    expect(topicEmbeddingText("RAG", " retrieval\nfor LLMs ")).toBe("RAG. retrieval for LLMs");
    expect(topicEmbeddingText("RAG", null)).toBe("RAG");
  });
});

describe("isAcronymMatch", () => {
  it("matches an acronym against its expansion", () => {
    expect(isAcronymMatch("RAG", "Retrieval-Augmented Generation")).toBe(true);
    expect(isAcronymMatch("retrieval augmented generation", "rag")).toBe(true);
    expect(isAcronymMatch("RLHF", "Reinforcement Learning from Human Feedback")).toBe(true);
    expect(isAcronymMatch("LLMs", "Large Language Models")).toBe(true);
    expect(isAcronymMatch("RAG", "Retrieval-Augmented Generation (RAG)")).toBe(true);
    expect(isAcronymMatch("RAG", "Retrieval Augmented Generation (RAG) for code")).toBe(true);
  });

  it("does not match unrelated names", () => {
    expect(isAcronymMatch("RLHF", "reward hacking")).toBe(false);
    expect(isAcronymMatch("RAG", "Graph Neural Networks")).toBe(false);
    expect(isAcronymMatch("Diffusion models", "Retrieval-Augmented Generation")).toBe(false);
    expect(isAcronymMatch("RAG", "RAG")).toBe(false); // identical names are cosine's job
    expect(isAcronymMatch("GNN", "Networks")).toBe(false); // single word has no initials
  });
});

describe("rankSimilar", () => {
  const q = v(1, 0, 0);
  const candidates = [
    cand("far", "Far", v(0, 1, 0)), // 0
    cand("close", "Close", v(0.9, 0.1, 0)), // ~0.994
    cand("exact", "Exact", v(2, 0, 0)), // 1
    cand("mid", "Mid", v(0.7, 0.7, 0)), // ~0.707
    cand("novec", "No vector", null),
  ];

  it("sorts descending and filters below the threshold", () => {
    const out = rankSimilar(q, candidates);
    expect(out.map((s) => s.id)).toEqual(["exact", "close"]);
    expect(out[0].similarity).toBeCloseTo(1);
    expect(out[0]).not.toHaveProperty("vector");
  });

  it("honours threshold, excludeId and limit", () => {
    expect(rankSimilar(q, candidates, { threshold: 0.5 }).map((s) => s.id)).toEqual(["exact", "close", "mid"]);
    expect(rankSimilar(q, candidates, { excludeId: "exact" }).map((s) => s.id)).toEqual(["close"]);
    expect(rankSimilar(q, candidates, { threshold: 0.5, limit: 1 }).map((s) => s.id)).toEqual(["exact"]);
  });

  it("floors acronym matches at the threshold even with orthogonal vectors", () => {
    const cs = [cand("rag", "Retrieval-Augmented Generation", v(0, 1, 0)), cand("rh", "reward hacking", v(0, 1, 0))];
    const out = rankSimilar(q, cs, { queryName: "RAG" });
    expect(out.map((s) => s.id)).toEqual(["rag"]);
    expect(out[0].similarity).toBe(TOPIC_SIMILARITY_THRESHOLD);

    expect(rankSimilar(q, cs, { queryName: "RLHF" })).toEqual([]);
    // Works with no query vector (embedding failed) too.
    expect(rankSimilar(null, cs, { queryName: "RAG" }).map((s) => s.id)).toEqual(["rag"]);
  });

  it("never lowers a higher cosine for an acronym match", () => {
    const out = rankSimilar(q, [cand("rag", "Retrieval Augmented Generation", v(1, 0, 0))], { queryName: "RAG" });
    expect(out[0].similarity).toBeCloseTo(1);
  });
});

describe("findSimilarTopics (db)", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    const insert = (id: string, name: string, emb: Float32Array | null) =>
      db.insert(topics).values({ id, slug: id, name, embedding: emb ? toBuffer(emb) : null, paperCount: 7 }).run();
    insert("t1", "Diffusion models", v(1, 0, 0));
    insert("t2", "Score-based generative models", v(0.95, 0.05, 0));
    insert("t3", "Retrieval-Augmented Generation", v(0, 0, 1));
    insert("t4", "Unembedded", null);
  });
  afterEach(() => db.$client.close());

  it("scans stored embeddings", () => {
    const out = findSimilarTopics(db, v(1, 0, 0));
    expect(out.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect(out[0]).toMatchObject({ slug: "t1", name: "Diffusion models", paperCount: 7, lastSearchAt: null });
    expect(findSimilarTopics(db, v(1, 0, 0), { excludeId: "t1" }).map((s) => s.id)).toEqual(["t2"]);
  });

  it("embeds via the injected embedFn and applies the acronym heuristic", async () => {
    const texts: string[] = [];
    const { similar, embedding } = await findSimilarTopicsFor(db, { name: "RAG", description: "for QA" }, {}, async (t) => {
      texts.push(t);
      return v(0, 1, 0);
    });
    expect(texts).toEqual(["RAG. for QA"]);
    expect(embedding).toEqual(v(0, 1, 0));
    expect(similar.map((s) => s.id)).toEqual(["t3"]);
  });

  it("falls back to the heuristic when embedding throws", async () => {
    const res = await findSimilarTopicsFor(db, { name: "RAG" }, {}, async () => {
      throw new Error("model unavailable");
    });
    expect(res.embedding).toBeNull();
    expect(res.similar.map((s) => s.id)).toEqual(["t3"]);
  });
});
