import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CachedHttpOptions } from "@/lib/landscape/sources/http";
import {
  authorHIndex,
  normalizeOpenAlexAuthorId,
  parseOpenAlexWork,
  reconstructAbstract,
  worksByDoi,
  type OpenAlexFetchJson,
} from "@/lib/landscape/sources/openalex";

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

function fake(respond: (url: URL, n: number) => unknown) {
  const calls: { url: string; opts: CachedHttpOptions }[] = [];
  const fetchJson = (async (url: string, opts: CachedHttpOptions) => {
    calls.push({ url, opts });
    return respond(new URL(url), calls.length - 1);
  }) as OpenAlexFetchJson;
  return { calls, fetchJson };
}

describe("reconstructAbstract", () => {
  it("orders words by position, repeating words at every position", () => {
    expect(reconstructAbstract({ world: [1], hello: [0, 2] })).toBe("hello world hello");
  });
  it("returns null for empty or missing indexes", () => {
    expect(reconstructAbstract(null)).toBeNull();
    expect(reconstructAbstract({})).toBeNull();
  });
});

describe("parseOpenAlexWork", () => {
  const [bert, resnet] = fixture("openalex-works.json").results;

  it("parses ids, abstract, authors, locations", () => {
    const p = parseOpenAlexWork(bert)!;
    expect(p).toMatchObject({
      title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
      openalexId: "W2963341956",
      doi: "10.18653/v1/n19-1423",
      arxivId: "1810.04805",
      arxivUrl: "https://arxiv.org/abs/1810.04805",
      abstract: "We introduce a new language a model called BERT.",
      year: 2019,
      publishedAt: "2019-01-01",
      venue: "Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics",
      pdfUrl: "https://aclanthology.org/N19-1423.pdf",
      citationCount: 33623,
      influentialCitationCount: null,
      source: "openalex",
    });
    expect(p.authors).toEqual([
      { name: "Jacob Devlin", openalexId: "A5057457287" },
      { name: "Ming-Wei Chang", openalexId: "A5023888391" },
      { name: "Kristina Toutanova", openalexId: null },
    ]);
  });

  it("falls back to display_name and source name, handling nulls", () => {
    const p = parseOpenAlexWork(resnet)!;
    expect(p).toMatchObject({
      title: "Deep Residual Learning for Image Recognition",
      doi: null,
      arxivId: null,
      abstract: null,
      venue: "Computer Vision and Pattern Recognition",
      pdfUrl: null,
    });
    expect(parseOpenAlexWork({ id: "W1" })).toBeNull();
  });

  it("normalizes author ids", () => {
    expect(normalizeOpenAlexAuthorId("https://openalex.org/a123")).toBe("A123");
    expect(normalizeOpenAlexAuthorId("W123")).toBeNull();
  });
});

describe("worksByDoi", () => {
  it("chunks at 50 DOIs, normalizes, and keys results by DOI", async () => {
    const dois = ["https://doi.org/10.18653/V1/N19-1423", ...Array.from({ length: 60 }, (_, i) => `10.1000/x${i}`), "not a doi"];
    const { calls, fetchJson } = fake(() => fixture("openalex-works.json"));
    const out = await worksByDoi(dois, { fetchJson, mailto: "me@example.com" });
    expect(calls).toHaveLength(2);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/works");
    expect(u.searchParams.get("filter")!.startsWith("doi:10.18653/v1/n19-1423|10.1000/x0|")).toBe(true);
    expect(u.searchParams.get("filter")!.split("|")).toHaveLength(50);
    expect(new URL(calls[1].url).searchParams.get("filter")!.split("|")).toHaveLength(11);
    expect(u.searchParams.get("per-page")).toBe("50");
    expect(u.searchParams.get("mailto")).toBe("me@example.com");
    expect(calls[0].opts.host).toBe("openalex");
    expect([...out.keys()]).toEqual(["10.18653/v1/n19-1423"]);
  });

  it("makes no request for no DOIs", async () => {
    const { calls, fetchJson } = fake(() => ({}));
    expect((await worksByDoi(["nope"], { fetchJson, mailto: "" })).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("authorHIndex", () => {
  it("reads summary_stats.h_index", async () => {
    const { calls, fetchJson } = fake(() => ({
      results: [
        { id: "https://openalex.org/A5003442464", summary_stats: { h_index: 46 } },
        { id: "https://openalex.org/A5023888391", summary_stats: { h_index: null } },
      ],
    }));
    const out = await authorHIndex(["https://openalex.org/A5003442464", "A5023888391", "A5003442464"], {
      fetchJson,
      mailto: "",
    });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/authors");
    expect(u.searchParams.get("filter")).toBe("ids.openalex:A5003442464|A5023888391");
    expect(u.searchParams.has("mailto")).toBe(false);
    expect([...out]).toEqual([["A5003442464", 46]]);
  });
});
