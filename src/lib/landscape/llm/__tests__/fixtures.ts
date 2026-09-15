import type { DossierInput, DossierPaper } from "../dossier";

/** Deterministic synthetic papers (no randomness). */
export function syntheticPapers(n: number, opts: { longFields?: boolean } = {}): DossierPaper[] {
  const long = (s: string) => (opts.longFields ? `${s} ${"with a very detailed and elaborate explanation of the approach ".repeat(12)}` : s);
  return Array.from({ length: n }, (_, i) => ({
    paperId: `paper-${String(i).padStart(3, "0")}`,
    ref: `P${i + 1}`,
    title: long(`Sparse method number ${i} for interpretability`),
    year: 2018 + (i % 7),
    publishedAt: `${2018 + (i % 7)}-${String((i % 12) + 1).padStart(2, "0")}-15`,
    venue: i % 3 === 0 ? "NeurIPS" : null,
    clusterIdx: i % 5 === 4 ? null : i % 4,
    foundational: i % 10 === 0,
    metrics: {
      citationCount: 1000 - i,
      influentialCitationCount: 50 - (i % 50),
      velocity: 120.5 - i,
      pagerank: (100 - i) / 100,
      influence: ((i * 37) % 100) / 100,
      maxAuthorHIndex: 20 + (i % 30),
    },
    extraction:
      i % 6 === 5
        ? null
        : {
            problem: long(`Problem ${i}: features are entangled.`),
            method: long(`Trains a sparse autoencoder variant ${i}.`),
            results: long(`Recovers ${i}% more features on toy models.`),
            contribution: long(`First to scale variant ${i}.`),
            limitations: long("Only small models."),
            datasets: ["OpenWebText", "The Pile"],
            benchmarks: ["SAEBench"],
          },
    abstract: long(`Abstract of paper ${i}.`),
  }));
}

export function syntheticDossierInput(n: number, opts: { longFields?: boolean } = {}): DossierInput {
  const papers = syntheticPapers(n, opts);
  return {
    topic: { name: "Sparse autoencoders for interpretability", description: "Dictionary learning on LLM activations." },
    papers,
    clusters: [0, 1, 2, 3].map((idx) => ({
      idx,
      label: `cluster-${idx}`,
      keyTerms: ["sparse", "autoencoder", `term${idx}`],
      size: papers.filter((p) => p.clusterIdx === idx).length,
      yearMin: 2018,
      yearMax: 2024,
    })),
    edges: papers.slice(1).flatMap((p, i) => [
      { source: p.paperId, target: papers[i].paperId, kind: "builds_on" },
      { source: p.paperId, target: papers[0].paperId, kind: i % 2 ? "builds_on" : "cites" },
    ]),
    gameChangerCandidates: [papers[0].paperId, papers[Math.min(3, n - 1)].paperId, "not-in-set"],
    generatedAt: "2026-09-15T12:00:00.000Z",
  };
}
