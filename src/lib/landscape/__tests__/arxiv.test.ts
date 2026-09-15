import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ARXIV_EMPTY_RETRY_MS,
  ARXIV_MAX_SEARCH_QUERY_CHARS,
  ArxivApiError,
  type ArxivWarning,
  arxivSearchUrl,
  buildArxivQuery,
  isSaneArxivQuery,
  parseArxivFeed,
  planArxivQuery,
  searchArxiv,
  type FetchTextFn,
} from "@/lib/landscape/sources/arxiv";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const NOW = new Date("2026-09-15T12:00:00Z");

describe("parseArxivFeed", () => {
  const feed = parseArxivFeed(fixture("arxiv-search.xml"));

  it("reads opensearch counters", () => {
    expect(feed.totalResults).toBe(1284);
    expect(feed.startIndex).toBe(0);
    expect(feed.itemsPerPage).toBe(3);
    expect(feed.error).toBeNull();
    expect(feed.entries).toHaveLength(3);
  });

  it("parses a full entry", () => {
    const p = feed.entries[0];
    expect(p.arxivId).toBe("2309.08600");
    expect(p.version).toBe(3);
    expect(p.title).toBe("Sparse Autoencoders Find Highly Interpretable Features in Language Models");
    expect(p.abstract).toBe(
      "One of the roadblocks to a better understanding of neural networks' internals is \\emph{polysemanticity}, where neurons appear to activate in multiple, semantically distinct contexts & resist interpretation.",
    );
    expect(p.authors).toEqual([{ name: "Hoagy Cunningham" }, { name: "Aidan Ewart" }, { name: "Lee Sharkey" }]);
    expect(p.publishedAt).toBe("2023-09-15T17:56:55.000Z");
    expect(p.updatedAt).toBe("2023-10-04T14:12:31.000Z");
    expect(p.year).toBe(2023);
    expect(p.primaryCategory).toBe("cs.LG");
    expect(p.categories).toEqual(["cs.LG", "cs.CL"]);
    expect(p.journalRef).toBe("ICLR 2024");
    expect(p.venue).toBe("ICLR 2024");
    expect(p.comment).toBe("20 pages, 18 figures");
    expect(p.doi).toBe("10.48550/iclr.2024.xyz");
    expect(p.arxivUrl).toBe("https://arxiv.org/abs/2309.08600");
    expect(p.pdfUrl).toBe("https://arxiv.org/pdf/2309.08600");
    expect(p.source).toBe("arxiv");
    expect(p.rank).toBe(1);
  });

  it("handles old-style ids, multiline titles and missing optional fields", () => {
    const p = feed.entries[1];
    expect(p.arxivId).toBe("hep-th/9901001");
    expect(p.version).toBe(2);
    expect(p.title).toBe("An Old-Style Identifier Paper");
    expect(p.doi).toBeNull();
    expect(p.journalRef).toBeNull();
    expect(p.venue).toBeNull();
    expect(p.pdfUrl).toBe("https://arxiv.org/pdf/hep-th/9901001");
    expect(p.rank).toBe(2);
  });

  it("decodes entities without eating math and keeps unicode names", () => {
    const p = feed.entries[2];
    expect(p.abstract).toContain("k < 100 works.");
    expect(p.abstract).not.toContain("\n");
    expect(p.authors?.[1].name).toBe("Tom Dupré la Tour");
    expect(p.rank).toBe(3);
  });

  it("detects the arXiv error entry", () => {
    const err = parseArxivFeed(fixture("arxiv-error.xml"));
    expect(err.error).toBe("incorrect id format for 1234.12345");
    expect(err.entries).toEqual([]);
  });

  it("parses an empty feed", () => {
    const empty = parseArxivFeed(fixture("arxiv-empty.xml"));
    expect(empty.totalResults).toBe(1284);
    expect(empty.entries).toEqual([]);
    expect(empty.error).toBeNull();
  });

  it("throws on non-XML", () => {
    expect(() => parseArxivFeed("<feed><entry>")).toThrow(ArxivApiError);
  });
});

describe("buildArxivQuery", () => {
  it("ANDs the most distinctive terms and ORs the rest, dropping stopwords and duplicates", () => {
    expect(buildArxivQuery({ text: "Sparse autoencoders for the interpretability of sparse models" })).toBe(
      'all:"autoencoders" AND all:"interpretability" AND (all:"sparse" OR all:"models")',
    );
    expect(buildArxivQuery({ text: "sparse autoencoder" })).toBe('all:"sparse" AND all:"autoencoder"');
    expect(buildArxivQuery({ text: "diffusion guidance models" })).toBe(
      'all:"diffusion" AND all:"guidance" AND all:"models"',
    );
    expect(buildArxivQuery({ text: "rlhf" })).toBe('all:"rlhf"');
  });

  it("ANDs three terms when the text has six or more", () => {
    expect(buildArxivQuery({ text: "mechanistic interpretability circuits transformer attention heads" })).toBe(
      'all:"mechanistic" AND all:"interpretability" AND all:"transformer" AND (all:"circuits" OR all:"attention" OR all:"heads")',
    );
  });

  it("relaxed mode ORs every text term and ignores the provided query", () => {
    const plan = planArxivQuery(
      { text: "sparse autoencoder features", arxiv: 'abs:"sparse autoencoder"' },
      { relaxed: true, categories: ["cs.LG"] },
    );
    expect(plan).toEqual({
      query: '(all:"sparse" OR all:"autoencoder" OR all:"features") AND cat:cs.LG',
      kind: "relaxed",
      relaxable: false,
    });
  });

  it("reports the plan kind and whether it is relaxable", () => {
    expect(planArxivQuery({ text: "a b c", arxiv: "abs:rlhf" })).toMatchObject({ kind: "provided", relaxable: true });
    expect(planArxivQuery({ text: "sparse autoencoder" })).toMatchObject({ kind: "fallback", relaxable: true });
    expect(planArxivQuery({ text: "rlhf" })).toMatchObject({ kind: "fallback", relaxable: false });
    expect(planArxivQuery({ text: "the" })).toEqual({ query: "", kind: "empty", relaxable: false });
  });

  it("accepts a provided query with a 12-digit date range", () => {
    expect(isSaneArxivQuery("abs:rlhf AND submittedDate:[202201010000 TO 202609152359]")).toBe(true);
    expect(isSaneArxivQuery("abs:rlhf ANDNOT ti:survey")).toBe(true);
  });

  it("uses a sane provided arXiv query", () => {
    const q = 'abs:"sparse autoencoder" AND (ti:interpretability OR abs:features)';
    expect(buildArxivQuery({ text: "x", arxiv: q })).toBe(q);
    expect(buildArxivQuery({ text: "x", arxivQuery: q })).toBe(q);
  });

  it.each([
    'abs:"sparse autoencoder',
    "abs:sparse) OR (ti:x",
    "(abs:sparse",
    "abs:sparse AND",
    "OR abs:sparse",
    "abs:sparse AND OR ti:x",
    "evil:sparse",
    "abs: AND ti:x",
    "sparse autoencoder",
    "abs:x; DROP TABLE",
    "abs:x&max_results=2000",
    "()",
    "abs:x and ti:y",
    "abs:x ti:y",
    "abs:x AND sparse",
    'abs:x AND "sparse autoencoder"',
    "id:1706.03762",
    "abs:x AND submittedDate:[20220101 TO 20260101]",
    "abs:x AND submittedDate:[2022010100000 TO 2026010100000]",
  ])("rejects malformed provided query %j and falls back to text", (bad) => {
    expect(isSaneArxivQuery(bad)).toBe(false);
    expect(buildArxivQuery({ text: "sparse autoencoder", arxiv: bad })).toBe('all:"sparse" AND all:"autoencoder"');
  });

  it("strips quotes, parens and operators from text terms", () => {
    const q = buildArxivQuery({ text: 'foo" OR (cat:hep-th) AND bar)' });
    expect(q).toBe('all:"foo" AND all:"hep-th" AND (all:"cat" OR all:"bar")');
    expect(isSaneArxivQuery(q)).toBe(true);
  });

  it("returns empty string when nothing is searchable", () => {
    expect(buildArxivQuery({ text: '  "() the of' })).toBe("");
  });

  it("OR-s valid categories and drops invalid ones", () => {
    expect(buildArxivQuery({ text: "rlhf" }, { categories: ["cs.LG", "cs.CL", "cs.LG) OR (all:x"] })).toBe(
      '(all:"rlhf") AND (cat:cs.LG OR cat:cs.CL)',
    );
    expect(buildArxivQuery({ text: "rlhf", categories: ["cs.AI"] })).toBe('(all:"rlhf") AND cat:cs.AI');
  });

  it.each(["physics.acc-ph", "cond-mat.stat-mech", "hep-th", "math.GT", "q-bio.NC", "astro-ph.CO"])(
    "accepts category %s",
    (cat) => {
      expect(buildArxivQuery({ text: "rlhf" }, { categories: [cat] })).toBe(`(all:"rlhf") AND cat:${cat}`);
    },
  );

  it("caps the combined query length by dropping categories", () => {
    const provided = Array.from({ length: 60 }, (_, i) => `abs:term${i}`).join(" OR ");
    expect(provided.length).toBeLessThanOrEqual(1000);
    const cats = Array.from({ length: 10 }, (_, i) => `cond-mat.stat-mech${"x".repeat(20 + i * 5)}`);
    const q = buildArxivQuery({ text: "x", arxiv: provided }, { categories: cats, since: "2025-01-01", now: NOW });
    expect(q.length).toBeLessThanOrEqual(ARXIV_MAX_SEARCH_QUERY_CHARS);
    expect(q).toContain("submittedDate:");
    expect(q).not.toContain("cat:");
  });

  it("does not add categories when the provided query already has cat:", () => {
    expect(buildArxivQuery({ text: "x", arxiv: "abs:rlhf AND cat:cs.LG" }, { categories: ["cs.CL"] })).toBe(
      "abs:rlhf AND cat:cs.LG",
    );
  });

  it("adds a submittedDate range from since", () => {
    expect(buildArxivQuery({ text: "rlhf" }, { since: "2025-03-07", now: NOW })).toBe(
      '(all:"rlhf") AND submittedDate:[202503070000 TO 202609152359]',
    );
  });

  it("adds a submittedDate range from windowYears, with since taking precedence", () => {
    expect(buildArxivQuery({ text: "rlhf" }, { windowYears: 4, categories: ["cs.LG"], now: NOW })).toBe(
      '(all:"rlhf") AND cat:cs.LG AND submittedDate:[202209150000 TO 202609152359]',
    );
    expect(buildArxivQuery({ text: "rlhf" }, { windowYears: 4, since: "2026-01-01", now: NOW })).toContain(
      "submittedDate:[202601010000 TO",
    );
    expect(buildArxivQuery({ text: "rlhf" }, { windowYears: null, now: NOW })).toBe('all:"rlhf"');
  });
});

describe("arxivSearchUrl", () => {
  it("encodes params and clamps max_results", () => {
    const u = new URL(arxivSearchUrl('all:"a b"', { start: 50, maxResults: 500, sortBy: "submittedDate" }));
    expect(u.origin + u.pathname).toBe("https://export.arxiv.org/api/query");
    expect(u.searchParams.get("search_query")).toBe('all:"a b"');
    expect(u.searchParams.get("start")).toBe("50");
    expect(u.searchParams.get("max_results")).toBe("100");
    expect(u.searchParams.get("sortBy")).toBe("submittedDate");
    expect(u.searchParams.get("sortOrder")).toBe("descending");
  });
});

describe("searchArxiv", () => {
  it("returns parsed papers and passes host + cache to fetchText", async () => {
    const fetchText = vi.fn<FetchTextFn>(async () => fixture("arxiv-search.xml"));
    const sleep = vi.fn(async () => {});
    const papers = await searchArxiv(
      { text: "sparse autoencoders", arxiv: "", categories: [] },
      { fetchText, sleep, maxResults: 3, cache: { source: "arxiv", ttlMs: 1000 } },
    );
    expect(papers.map((p) => p.arxivId)).toEqual(["2309.08600", "hep-th/9901001", "2406.04093"]);
    expect(fetchText).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchText.mock.calls[0];
    expect(new URL(url).searchParams.get("max_results")).toBe("3");
    expect(opts).toMatchObject({ host: "arxiv", cache: { source: "arxiv", ttlMs: 1000 } });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries once after 5s, bypassing the cache, when totalResults > 0 but no entries", async () => {
    const fetchText = vi
      .fn<FetchTextFn>()
      .mockResolvedValueOnce(fixture("arxiv-empty.xml"))
      .mockResolvedValueOnce(fixture("arxiv-search.xml"));
    const sleep = vi.fn(async () => {});
    const papers = await searchArxiv("sparse", { fetchText, sleep, cache: {} });
    expect(sleep).toHaveBeenCalledWith(ARXIV_EMPTY_RETRY_MS);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(fetchText.mock.calls[0][1].cache?.bypass).toBeUndefined();
    expect(fetchText.mock.calls[1][1].cache?.bypass).toBe(true);
    expect(papers).toHaveLength(3);
  });

  it("retries only once, then returns empty and warns", async () => {
    const fetchText = vi.fn<FetchTextFn>(async () => fixture("arxiv-empty.xml"));
    const sleep = vi.fn(async () => {});
    const warnings: ArxivWarning[] = [];
    await expect(searchArxiv("sparse", { fetchText, sleep, onWarning: (w) => warnings.push(w) })).resolves.toEqual([]);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([{ kind: "empty_after_retry", query: 'all:"sparse"', totalResults: 1284 }]);
  });

  it("retries a zero-result AND query once with all terms OR-ed and reports it", async () => {
    const fetchText = vi
      .fn<FetchTextFn>()
      .mockResolvedValueOnce(fixture("arxiv-no-results.xml"))
      .mockResolvedValueOnce(fixture("arxiv-search.xml"));
    const warnings: ArxivWarning[] = [];
    const papers = await searchArxiv(
      { text: "sparse autoencoder", categories: ["cs.LG"] },
      { fetchText, sleep: async () => {}, onWarning: (w) => warnings.push(w) },
    );
    expect(papers).toHaveLength(3);
    const queries = fetchText.mock.calls.map(([u]) => new URL(u).searchParams.get("search_query"));
    expect(queries).toEqual([
      '(all:"sparse" AND all:"autoencoder") AND cat:cs.LG',
      '(all:"sparse" OR all:"autoencoder") AND cat:cs.LG',
    ]);
    expect(warnings).toEqual([
      {
        kind: "relaxed_retry",
        query: queries[0],
        relaxedQuery: queries[1],
        relaxedResults: 1284,
      },
    ]);
  });

  it("relaxes a zero-result provided query using the text terms", async () => {
    const fetchText = vi.fn<FetchTextFn>(async () => fixture("arxiv-no-results.xml"));
    const warnings: ArxivWarning[] = [];
    await searchArxiv(
      { text: "rlhf", arxiv: 'abs:"reward hacking" AND ti:rlhf' },
      { fetchText, sleep: async () => {}, onWarning: (w) => warnings.push(w) },
    );
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(new URL(fetchText.mock.calls[1][0]).searchParams.get("search_query")).toBe('all:"rlhf"');
    expect(warnings.map((w) => w.kind)).toEqual(["relaxed_retry"]);
  });

  it("warns about dropped entries", async () => {
    const xml = fixture("arxiv-search.xml").replace(
      "<id>http://arxiv.org/abs/2406.04093v1</id>",
      "<id>http://arxiv.org/abs/not-an-id</id>",
    );
    const warnings: ArxivWarning[] = [];
    const papers = await searchArxiv("sparse", {
      fetchText: async () => xml,
      sleep: async () => {},
      onWarning: (w) => warnings.push(w),
    });
    expect(papers).toHaveLength(2);
    expect(warnings).toEqual([{ kind: "dropped_entries", query: 'all:"sparse"', count: 1 }]);
    expect(parseArxivFeed(xml).dropped).toBe(1);
  });

  it("does not retry a genuinely empty result", async () => {
    const fetchText = vi.fn<FetchTextFn>(async () => fixture("arxiv-no-results.xml"));
    const sleep = vi.fn(async () => {});
    await expect(searchArxiv("zzqxv", { fetchText, sleep })).resolves.toEqual([]);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws ArxivApiError on the error entry", async () => {
    const fetchText = vi.fn<FetchTextFn>(async () => fixture("arxiv-error.xml"));
    await expect(searchArxiv("x", { fetchText, sleep: async () => {} })).rejects.toThrow(
      /incorrect id format/,
    );
  });

  it("skips the network when the query is empty", async () => {
    const fetchText = vi.fn<FetchTextFn>();
    await expect(searchArxiv({ text: "the of" }, { fetchText })).resolves.toEqual([]);
    expect(fetchText).not.toHaveBeenCalled();
  });
});
