import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/lib/db/create";
import { topics } from "@/lib/db/schema";
import { SLUG_MAX, slugify, uniqueSlug } from "@/lib/landscape/slug";

describe("slugify", () => {
  it("folds, lowercases and hyphenates", () => {
    expect(slugify("Retrieval-Augmented Generation")).toBe("retrieval-augmented-generation");
    expect(slugify("  Café  Über—Naïve (RAG) ")).toBe("cafe-uber-naive-rag");
    expect(slugify("GPT-4 & LLMs!!")).toBe("gpt-4-llms");
  });

  it("never returns empty", () => {
    expect(slugify("")).toBe("topic");
    expect(slugify("   ---  ")).toBe("topic");
    expect(slugify("强化学习")).toBe("topic");
    expect(slugify(null)).toBe("topic");
  });

  it("caps length, preferring a word boundary", () => {
    const s = slugify("very long topic name ".repeat(10));
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s.endsWith("-")).toBe(false);
    expect(s.startsWith("very-long-topic-name-very")).toBe(true);
    expect(slugify("a".repeat(100))).toBe("a".repeat(SLUG_MAX));
  });
});

describe("uniqueSlug", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
  });
  afterEach(() => db.$client.close());

  const add = (id: string, slug: string) => db.insert(topics).values({ id, slug, name: id }).run();

  it("appends -2, -3 on collision", () => {
    expect(uniqueSlug(db, "Diffusion Models")).toBe("diffusion-models");
    add("a", "diffusion-models");
    expect(uniqueSlug(db, "Diffusion Models")).toBe("diffusion-models-2");
    add("b", "diffusion-models-2");
    expect(uniqueSlug(db, "diffusion models")).toBe("diffusion-models-3");
    // A prefix-sharing slug is not a collision.
    add("c", "diffusion-models-for-audio");
    expect(uniqueSlug(db, "Diffusion models for video")).toBe("diffusion-models-for-video");
  });

  it("ignores the topic's own slug when excludeId is given", () => {
    add("a", "rag");
    expect(uniqueSlug(db, "RAG")).toBe("rag-2");
    expect(uniqueSlug(db, "RAG", "a")).toBe("rag");
  });

  it("keeps suffixed slugs within SLUG_MAX", () => {
    const name = "x".repeat(100);
    add("a", uniqueSlug(db, name));
    const second = uniqueSlug(db, name);
    expect(second).toBe(`${"x".repeat(SLUG_MAX - 2)}-2`);
    expect(second.length).toBe(SLUG_MAX);
  });
});
