import { describe, expect, it } from "vitest";
import {
  buildProseRefContext,
  citationLabel,
  rewriteDocumentProse,
  rewriteLandscapeDocumentsProse,
  rewriteProseRefs,
} from "@/lib/landscape/documents/prose-refs";
import type { LandscapeDocuments } from "@/lib/landscape/types";

const ctx = buildProseRefContext({
  papers: [
    { ref: "P1", title: "Scaling sparse autoencoders", authors: ["Leo Gao", "Tom Dupré la Tour"], year: 2024 },
    { ref: "P2", title: "Towards monosemanticity", authors: [{ name: "Trenton Bricken" }, { name: "A. Templeton" }], year: 2023 },
    { ref: "P3", title: "Solo paper", authors: ["Jane Lee"], year: null, publishedAt: "2022-05-01" },
    { ref: "P8", title: "InterPLM", authors: ["Elana Simon", "James Zou"], year: 2024 },
    { ref: "P12", title: "A Very Long Title About Sparse Dictionary Learning In Protein Language Models", authors: [], year: 2025 },
    { ref: "P14", title: "Diffusion SAEs", authors: ["Smith, John", "Doe"], year: 2025 },
    { ref: "P15", title: "Single-cell SAEs", authors: ["Wei Chen"], year: 2026 },
    { ref: "X9", title: "ignored", authors: ["Nobody"], year: 2020 },
  ],
  clusters: [
    { idx: 0, label: "Domain applications" },
    { idx: 1, label: "SAE methods" },
    { idx: 4, label: "Should not replace C4 dataset" },
  ],
});

const rw = (s: string) => rewriteProseRefs(s, ctx);

describe("citationLabel", () => {
  it("formats first-author surname, et al., year", () => {
    expect(citationLabel({ title: "t", authors: ["Leo Gao", "B"], year: 2024 })).toBe("Gao et al. 2024");
    expect(citationLabel({ title: "t", authors: ["Jane Lee"], year: 2024 })).toBe("Lee 2024");
    expect(citationLabel({ title: "t", authors: ["Smith, John", "X"], year: 2020 })).toBe("Smith et al. 2020");
    expect(citationLabel({ title: "t", authors: ["Martin Luther King Jr."], year: 1960 })).toBe("King 1960");
    expect(citationLabel({ title: "t", authors: ["Jane Lee"], year: null, publishedAt: "2021-02-03" })).toBe("Lee 2021");
    expect(citationLabel({ title: "t", authors: ["Jane Lee"], year: null })).toBe("Lee");
  });

  it("falls back to a truncated title without authors", () => {
    expect(citationLabel({ title: "Attention Is All You Need", authors: [], year: 2017 })).toBe("Attention Is All You Need, 2017");
    const long = citationLabel({ title: "A Very Long Title About Sparse Dictionary Learning In Protein Language Models", authors: null, year: 2025 });
    expect(long.endsWith("…, 2025")).toBe(true);
    expect(long.length).toBeLessThan(60);
  });

  it("builds the context from P refs only", () => {
    expect(ctx.papers.get(1)).toBe("Gao et al. 2024");
    expect(ctx.papers.get(3)).toBe("Lee 2022");
    expect(ctx.papers.size).toBe(7);
  });
});

describe("rewriteProseRefs", () => {
  it("replaces a single ref in prose", () => {
    expect(rw("This builds on P1 directly.")).toBe("This builds on Gao et al. 2024 directly.");
  });

  it("joins two refs with and", () => {
    expect(rw("Methods from P1 and P2 dominate.")).toBe("Methods from Gao et al. 2024 and Bricken et al. 2023 dominate.");
  });

  it("parenthesized lists use semicolons", () => {
    expect(rw("Protein models (P8, P14, P15) are rising.")).toBe(
      "Protein models (Simon et al. 2024; Smith et al. 2025; Chen 2026) are rising.",
    );
    expect(rw("See [P1; P2].")).toBe("See [Gao et al. 2024; Bricken et al. 2023].");
  });

  it("handles comma lists without spaces and oxford lists", () => {
    expect(rw("P1,P2 agree.")).toBe("Gao et al. 2024 and Bricken et al. 2023 agree.");
    expect(rw("P1, P2, and P3 agree.")).toBe("Gao et al. 2024, Bricken et al. 2023, and Lee 2022 agree.");
    expect(rw("P14/P15 report it.")).toBe("Smith et al. 2025 and Chen 2026 report it.");
  });

  it("expands ranges to known refs", () => {
    expect(rw("Early work (P1–P3) set the stage.")).toBe(
      "Early work (Gao et al. 2024; Bricken et al. 2023; Lee 2022) set the stage.",
    );
    expect(rw("Early work P1-P3 set the stage.")).toBe(
      "Early work Gao et al. 2024, Bricken et al. 2023, and Lee 2022 set the stage.",
    );
  });

  it("replaces cluster refs, keeping possessives", () => {
    expect(rw("One family (C0) applies SAEs.")).toBe("One family (Domain applications) applies SAEs.");
    expect(rw("contrasted with C0's focus")).toBe("contrasted with Domain applications's focus");
    expect(rw("Cluster C1 grew from 4 to 6.")).toBe("Cluster SAE methods grew from 4 to 6.");
    expect(rw("nearly every cluster-0 paper")).toBe("nearly every Domain applications paper");
    expect(rw("a cluster-9 paper")).toBe("a cluster-9 paper");
    expect(rw("P12's limitations")).toBe("A Very Long Title About Sparse Dictionary…, 2025's limitations");
  });

  it("replaces refs at sentence start", () => {
    expect(rw("P2 introduces k-sparse autoencoders. P8 follows.")).toBe(
      "Bricken et al. 2023 introduces k-sparse autoencoders. Simon et al. 2024 follows.",
    );
  });

  it("replaces lower-case paper refs", () => {
    expect(rw("as shown by p12 and p1")).toBe("as shown by A Very Long Title About Sparse Dictionary…, 2025 and Gao et al. 2024");
  });

  it("leaves non-refs and unknown refs outside parentheses alone", () => {
    expect(rw("Trained on a P100 GPU with GPT4 and C4 dataset.")).toBe("Trained on a P100 GPU with GPT4 and C4 dataset.");
    expect(rw("GPT-4 scale, top-p0.9, MP3, C9 cluster, p99")).toBe("GPT-4 scale, top-p0.9, MP3, C9 cluster, p99");
    expect(rw("No refs here.")).toBe("No refs here.");
  });

  it("removes unknown refs cleanly", () => {
    expect(rw("This is shown (P99).")).toBe("This is shown.");
    expect(rw("Results (P1, P99) hold.")).toBe("Results (Gao et al. 2024) hold.");
    expect(rw("Results (P1, P99; 412 citations) hold.")).toBe("Results (Gao et al. 2024; 412 citations) hold.");
    expect(rw("Results (P99; 412 citations) hold.")).toBe("Results (P99; 412 citations) hold.");
    expect(rw("Both P99 and P2 agree.")).toBe("Both Bricken et al. 2023 agree.");
    expect(rw("(P98, P99) Sparse coding came first.")).toBe("Sparse coding came first.");
  });

  it("keeps paragraph breaks", () => {
    expect(rw("First (P1).\n\nSecond (P2).")).toBe("First (Gao et al. 2024).\n\nSecond (Bricken et al. 2023).");
  });

  it("is a no-op with an empty context", () => {
    const empty = buildProseRefContext({ papers: [], clusters: [] });
    expect(rewriteProseRefs("P1 and C0", empty)).toBe("P1 and C0");
  });
});

describe("rewriteDocumentProse", () => {
  it("rewrites prose fields and leaves ids alone", () => {
    const doc = rewriteDocumentProse(
      "narrative",
      {
        eras: [{ label: "Era of P1", startYear: 2020, endYear: null, summary: "Built on P1 (P2).", keyPaperIds: ["P1-id"] }],
        gameChangers: [{ paperId: "P1", why: "P1 scaled it.", evidence: "vel 3/y (P1)" }],
        frontier: { summary: "Frontier (P8, P14).", paperIds: ["P8"] },
        outlook: "C0 will grow.",
        whatChanged: null,
      },
      ctx,
    );
    expect(doc.eras[0].summary).toBe("Built on Gao et al. 2024 (Bricken et al. 2023).");
    expect(doc.eras[0].label).toBe("Era of Gao et al. 2024");
    expect(doc.eras[0].keyPaperIds).toEqual(["P1-id"]);
    expect(doc.gameChangers[0]).toEqual({ paperId: "P1", why: "Gao et al. 2024 scaled it.", evidence: "vel 3/y (Gao et al. 2024)" });
    expect(doc.frontier).toEqual({ summary: "Frontier (Simon et al. 2024; Smith et al. 2025).", paperIds: ["P8"] });
    expect(doc.outlook).toBe("Domain applications will grow.");
    expect(doc.whatChanged).toBeNull();
  });

  it("covers every document kind in a snapshot", () => {
    const docs: LandscapeDocuments = {
      clusters: { topicSummary: "Two tracks (C0, C1).", clusters: [{ idx: 0, name: "C0 name", summary: "Like P1.", keyIdeas: ["P2 idea"], representativePaperIds: [] }] },
      tensions: { tensions: [{ title: "P1 vs P2", description: "(P1)", positions: [{ stance: "P8 says", paperIds: [] }], clusterIdxs: [] }] },
      gaps: { gaps: [{ title: "Gap", description: "P3 lacks", evidence: "P14 shows", evidencePaperIds: [], directions: ["Extend P15"] }] },
      narrative: null,
      readingPath: { steps: [{ phase: "core", paperId: "x", reason: "Read after P1." }] },
      diff: null,
    };
    const out = rewriteLandscapeDocumentsProse(docs, ctx);
    expect(out.clusters?.topicSummary).toBe("Two tracks (Domain applications; SAE methods).");
    expect(out.clusters?.clusters[0].name).toBe("C0 name");
    expect(out.clusters?.clusters[0].summary).toBe("Like Gao et al. 2024.");
    expect(out.clusters?.clusters[0].keyIdeas).toEqual(["Bricken et al. 2023 idea"]);
    expect(out.tensions?.tensions[0].title).toBe("Gao et al. 2024 vs Bricken et al. 2023");
    expect(out.tensions?.tensions[0].positions[0].stance).toBe("Simon et al. 2024 says");
    expect(out.gaps?.gaps[0]).toMatchObject({ description: "Lee 2022 lacks", evidence: "Smith et al. 2025 shows", directions: ["Extend Chen 2026"] });
    expect(out.readingPath?.steps[0].reason).toBe("Read after Gao et al. 2024.");
    expect(out.narrative).toBeNull();
  });
});
