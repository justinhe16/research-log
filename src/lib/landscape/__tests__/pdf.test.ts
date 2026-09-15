import { describe, expect, it } from "vitest";
import type { FetchBytesOptions } from "@/lib/landscape/sources/http";
import {
  classifyHeading,
  excerptForExtraction,
  fetchPaperPdf,
  findHeadings,
  pdfCandidates,
  type FetchBytesFn,
} from "@/lib/landscape/sources/pdf";

const filler = (tag: string, n: number) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n).trim();

function paper(sizes: Partial<Record<string, number>> = {}) {
  const s = { abstract: 800, intro: 4000, related: 6000, method: 8000, experiments: 8000, conclusion: 1500, refs: 9000, ...sizes };
  return [
    "Sparse Dictionaries for Fun and Profit",
    "Ada Lovelace, Alan Turing",
    "Abstract",
    filler("abs", s.abstract),
    "1 Introduction",
    filler("intro", s.intro),
    "2 Related Work",
    filler("related", s.related),
    "3 Method",
    filler("method", s.method),
    "3.1 Model",
    filler("submodel", 500),
    "4. Experiments",
    filler("exp", s.experiments),
    "5 Conclusion",
    filler("concl", s.conclusion),
    "References",
    filler("ref", s.refs),
  ].join("\n");
}

describe("classifyHeading", () => {
  it.each([
    ["Abstract", "abstract"],
    ["1 Introduction", "intro"],
    ["2. Related Work", "skip"],
    ["III. PROPOSED METHOD", "method"],
    ["4 Experimental Setup", "experiments"],
    ["Results", "results"],
    ["6 Conclusions:", "conclusion"],
    ["References", "end"],
    ["Acknowledgements", "end"],
  ])("%s -> %s", (line, kind) => {
    expect(classifyHeading(line)).toBe(kind);
  });

  it.each(["3.1 Model", "We propose a new method", "", "Introduction to a very long sentence that is clearly not a heading at all"])(
    "not a heading: %s",
    (line) => {
      expect(classifyHeading(line)).toBeNull();
    },
  );

  it("finds inline abstracts", () => {
    const h = findHeadings("Title\nAbstract: We study things.\n1 Introduction\nBody");
    expect(h.map((x) => x.kind)).toEqual(["abstract", "intro"]);
  });
});

describe("excerptForExtraction", () => {
  it("returns short text unchanged", () => {
    expect(excerptForExtraction("Abstract\nshort", 100)).toBe("Abstract\nshort");
  });

  it("keeps wanted sections, drops related work and references", () => {
    const text = paper();
    const out = excerptForExtraction(text, 30_000);
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out).toContain("Sparse Dictionaries for Fun and Profit");
    expect(out).toContain("Abstract");
    expect(out).toContain("1 Introduction");
    expect(out).toContain("3 Method");
    expect(out).toContain("submodel"); // subsections stay inside their parent
    expect(out).toContain("4. Experiments");
    expect(out).toContain("5 Conclusion");
    expect(out).not.toContain("related");
    expect(out).not.toContain("ref ref");
    // Everything wanted fits in 30k, so nothing is truncated.
    expect(out).not.toContain("[...]");
  });

  it("truncates long sections but keeps short ones whole", () => {
    const out = excerptForExtraction(paper({ method: 40_000, experiments: 40_000 }), 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toContain(filler("abs", 800));
    expect(out).toContain(filler("concl", 1500));
    expect(out).toContain("[...]");
    const methodChars = (out.match(/method/g) ?? []).length;
    const expChars = (out.match(/exp/g) ?? []).length;
    expect(methodChars).toBeGreaterThan(500);
    expect(expChars).toBeGreaterThan(500);
  });

  it("falls back to head + tail without headings", () => {
    const text = `${filler("head", 30_000)} ${filler("tail", 30_000)}`;
    const out = excerptForExtraction(text, 10_000);
    expect(out.length).toBeLessThanOrEqual(10_000);
    expect(out.startsWith("head")).toBe(true);
    expect(out.trimEnd().endsWith("tail")).toBe(true);
    expect(out).toContain("[...]");
  });

  it("cuts references off the fallback tail", () => {
    const text = [filler("body", 50_000), "References", filler("ref", 20_000)].join("\n");
    const out = excerptForExtraction(text, 10_000);
    expect(out).not.toContain("ref ref");
  });
});

describe("fetchPaperPdf", () => {
  const PDF = new TextEncoder().encode("%PDF-1.5\n...");

  it("prefers arXiv over pdfUrl", () => {
    expect(pdfCandidates({ arxivId: "2401.01234v2", pdfUrl: "https://example.org/a.pdf" })).toEqual([
      { url: "https://arxiv.org/pdf/2401.01234", via: "arxiv" },
      { url: "https://example.org/a.pdf", via: "pdfUrl" },
    ]);
    expect(pdfCandidates({ pdfUrl: "https://arxiv.org/pdf/2401.01234v1" })).toEqual([
      { url: "https://arxiv.org/pdf/2401.01234", via: "arxiv" },
    ]);
    expect(pdfCandidates({ pdfUrl: "file:///etc/passwd" })).toEqual([]);
  });

  it("returns null without candidates", async () => {
    expect(await fetchPaperPdf({})).toBeNull();
  });

  it("uses the 25MB cap and falls back when arXiv fails", async () => {
    const calls: { url: string; opts: FetchBytesOptions }[] = [];
    const fetchBytes: FetchBytesFn = async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes("arxiv.org")) throw new Error("HTTP 503");
      return { bytes: PDF, contentType: "application/pdf", url };
    };
    const out = await fetchPaperPdf({ arxivId: "2401.01234", pdfUrl: "https://example.org/a.pdf" }, { fetchBytes });
    expect(out).toMatchObject({ via: "pdfUrl", url: "https://example.org/a.pdf" });
    expect(calls.map((c) => c.url)).toEqual(["https://arxiv.org/pdf/2401.01234", "https://example.org/a.pdf"]);
    expect(calls[0].opts.maxBytes).toBe(25 * 1024 * 1024);
  });

  it("rejects non-PDF bodies and throws when every candidate fails", async () => {
    const fetchBytes: FetchBytesFn = async (url) => ({
      bytes: new TextEncoder().encode("<html>captcha</html>"),
      contentType: "text/html",
      url,
    });
    await expect(fetchPaperPdf({ arxivId: "2401.01234" }, { fetchBytes })).rejects.toThrow(/Not a PDF/);
  });
});
