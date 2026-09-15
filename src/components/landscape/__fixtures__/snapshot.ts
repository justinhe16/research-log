import type {
  ClusterDTO,
  EdgeDTO,
  LandscapeSnapshot,
  PaperLite,
  SearchProgress,
  TopicCard,
} from "@/lib/landscape/types";

/*
 * A realistic LandscapeSnapshot for building UI before the pipeline exists.
 * Titles and arXiv ids are real papers; metrics, ranks, extractions and all
 * synthesized prose are illustrative. It is a *refresh* search so the diff
 * banner and cluster-change badges have data. Validated in
 * src/lib/landscape/__tests__/synthesize-schemas.test.ts.
 */

type Seed = {
  n: number;
  title: string;
  authors: string[];
  year: number;
  month: string;
  venue: string | null;
  arxivId: string | null;
  cluster: number;
  cites: number;
  influential: number;
  hIndex: number;
  pagerank: number;
  relevance: number;
  tldr: string;
  foundational?: boolean;
  gameChanger?: boolean;
  origin?: PaperLite["origin"];
  logged?: boolean;
};

const CURRENT_YEAR = 2026;

const SEEDS: Seed[] = [
  // --- cluster 0: foundations ------------------------------------------------
  { n: 1, title: "Toy Models of Superposition", authors: ["Nelson Elhage", "Tristan Hume", "Catherine Olsson", "Chris Olah"], year: 2022, month: "09", venue: "Transformer Circuits Thread", arxivId: "2209.10652", cluster: 0, cites: 780, influential: 120, hIndex: 60, pagerank: 1, relevance: 0.91, tldr: "Shows small networks store more features than dimensions via superposition, motivating dictionary learning.", foundational: true, gameChanger: true, logged: true },
  { n: 2, title: "Zoom In: An Introduction to Circuits", authors: ["Chris Olah", "Nick Cammarata", "Ludwig Schubert", "Gabriel Goh"], year: 2020, month: "03", venue: "Distill", arxivId: null, cluster: 0, cites: 650, influential: 70, hIndex: 60, pagerank: 0.82, relevance: 0.62, tldr: "Frames neural networks as circuits of features and argues features are the fundamental unit of interpretability.", foundational: true },
  { n: 3, title: "A Mathematical Framework for Transformer Circuits", authors: ["Nelson Elhage", "Neel Nanda", "Catherine Olsson", "Chris Olah"], year: 2021, month: "12", venue: "Transformer Circuits Thread", arxivId: null, cluster: 0, cites: 540, influential: 90, hIndex: 60, pagerank: 0.77, relevance: 0.66, tldr: "Decomposes attention-only transformers into interpretable paths via the residual stream view." },
  { n: 4, title: "Softmax Linear Units", authors: ["Nelson Elhage", "Tristan Hume", "Catherine Olsson"], year: 2022, month: "06", venue: "Transformer Circuits Thread", arxivId: null, cluster: 0, cites: 120, influential: 15, hIndex: 45, pagerank: 0.31, relevance: 0.58, tldr: "An activation change that makes MLP neurons more interpretable, at the cost of hiding features elsewhere." },
  { n: 5, title: "Interpretability in the Wild: a Circuit for Indirect Object Identification in GPT-2 small", authors: ["Kevin Wang", "Alexandre Variengien", "Arthur Conmy", "Buck Shlegeris", "Jacob Steinhardt"], year: 2022, month: "11", venue: "ICLR 2023", arxivId: "2211.00593", cluster: 0, cites: 610, influential: 95, hIndex: 50, pagerank: 0.64, relevance: 0.55, tldr: "Reverse-engineers a 26-head circuit in GPT-2 small, establishing path patching as a standard tool." },
  { n: 6, title: "Language models can explain neurons in language models", authors: ["Steven Bills", "Nick Cammarata", "Dan Mossing", "Jeff Wu", "William Saunders"], year: 2023, month: "05", venue: "OpenAI", arxivId: null, cluster: 0, cites: 300, influential: 40, hIndex: 40, pagerank: 0.35, relevance: 0.63, tldr: "Uses GPT-4 to write and score natural-language explanations of every GPT-2 neuron; most neurons explain poorly.", origin: "citation" },

  // --- cluster 1: SAE architectures & scaling ---------------------------------
  { n: 7, title: "Sparse Autoencoders Find Highly Interpretable Features in Language Models", authors: ["Hoagy Cunningham", "Aidan Ewart", "Logan Riggs", "Robert Huben", "Lee Sharkey"], year: 2023, month: "09", venue: "ICLR 2024", arxivId: "2309.08600", cluster: 1, cites: 520, influential: 110, hIndex: 25, pagerank: 0.72, relevance: 0.97, tldr: "Trains SAEs on Pythia residual streams and shows the learned features are more monosemantic than neurons.", gameChanger: true, logged: true },
  { n: 8, title: "Towards Monosemanticity: Decomposing Language Models With Dictionary Learning", authors: ["Trenton Bricken", "Adly Templeton", "Joshua Batson", "Chris Olah"], year: 2023, month: "10", venue: "Transformer Circuits Thread", arxivId: null, cluster: 1, cites: 690, influential: 150, hIndex: 60, pagerank: 0.9, relevance: 0.96, tldr: "A one-layer transformer's MLP decomposed into ~4k interpretable features with a 16x overcomplete SAE.", gameChanger: true },
  { n: 9, title: "Scaling Monosemanticity: Extracting Interpretable Features from Claude 3 Sonnet", authors: ["Adly Templeton", "Tom Conerly", "Jonathan Marcus", "Chris Olah"], year: 2024, month: "05", venue: "Transformer Circuits Thread", arxivId: null, cluster: 1, cites: 480, influential: 95, hIndex: 60, pagerank: 0.61, relevance: 0.95, tldr: "SAEs with up to 34M features on a production model yield multilingual, multimodal, steerable features.", gameChanger: true },
  { n: 10, title: "Scaling and evaluating sparse autoencoders", authors: ["Leo Gao", "Tom Dupré la Tour", "Henk Tillman", "Jan Leike", "Jeffrey Wu"], year: 2024, month: "06", venue: "ICLR 2025", arxivId: "2406.04093", cluster: 1, cites: 340, influential: 70, hIndex: 45, pagerank: 0.48, relevance: 0.94, tldr: "Top-k SAEs remove the L1 tuning problem and follow clean scaling laws up to 16M latents on GPT-4.", gameChanger: true },
  { n: 11, title: "Improving Dictionary Learning with Gated Sparse Autoencoders", authors: ["Senthooran Rajamanoharan", "Arthur Conmy", "Lewis Smith", "Neel Nanda"], year: 2024, month: "04", venue: "NeurIPS 2024", arxivId: "2404.16014", cluster: 1, cites: 150, influential: 30, hIndex: 30, pagerank: 0.33, relevance: 0.9, tldr: "Separates detection from magnitude estimation to fix L1 shrinkage, a Pareto improvement over ReLU SAEs." },
  { n: 12, title: "Jumping Ahead: Improving Reconstruction Fidelity with JumpReLU Sparse Autoencoders", authors: ["Senthooran Rajamanoharan", "Tom Lieberum", "Nicolas Sonnerat", "Neel Nanda"], year: 2024, month: "07", venue: null, arxivId: "2407.14435", cluster: 1, cites: 130, influential: 25, hIndex: 30, pagerank: 0.27, relevance: 0.89, tldr: "A thresholded activation trained with straight-through estimators directly optimizes L0." },
  { n: 13, title: "Gemma Scope: Open Sparse Autoencoders Everywhere All At Once on Gemma 2", authors: ["Tom Lieberum", "Senthooran Rajamanoharan", "Arthur Conmy", "Neel Nanda"], year: 2024, month: "08", venue: "BlackboxNLP 2024", arxivId: "2408.05147", cluster: 1, cites: 210, influential: 40, hIndex: 30, pagerank: 0.39, relevance: 0.88, tldr: "Releases 400+ JumpReLU SAEs on every layer of Gemma 2, making SAE research accessible without training.", logged: true },
  { n: 14, title: "Learning Multi-Level Features with Matryoshka Sparse Autoencoders", authors: ["Bart Bussmann", "Noa Nabeshima", "Adam Karvonen", "Neel Nanda"], year: 2025, month: "03", venue: "ICML 2025", arxivId: "2503.17547", cluster: 1, cites: 45, influential: 8, hIndex: 20, pagerank: 0.08, relevance: 0.86, tldr: "Nested dictionaries reduce feature absorption and splitting by forcing early latents to reconstruct alone." },

  // --- cluster 2: evaluation & applications -----------------------------------
  { n: 15, title: "Sparse Feature Circuits: Discovering and Editing Interpretable Causal Graphs in Language Models", authors: ["Samuel Marks", "Can Rager", "Eric J. Michaud", "Yonatan Belinkov", "David Bau", "Aaron Mueller"], year: 2024, month: "03", venue: "ICLR 2025", arxivId: "2403.19647", cluster: 2, cites: 190, influential: 45, hIndex: 40, pagerank: 0.42, relevance: 0.87, tldr: "Builds circuits from SAE features instead of neurons, enabling targeted removal of spurious correlations." },
  { n: 16, title: "Transcoders Find Interpretable LLM Feature Circuits", authors: ["Jacob Dunefsky", "Philippe Chlenski", "Neel Nanda"], year: 2024, month: "06", venue: "NeurIPS 2024", arxivId: "2406.11944", cluster: 2, cites: 80, influential: 18, hIndex: 30, pagerank: 0.2, relevance: 0.84, tldr: "Replaces MLPs with wide sparse transcoders so circuit analysis factors into input-invariant and input-dependent terms." },
  { n: 17, title: "Towards Principled Evaluations of Sparse Autoencoders for Interpretability and Control", authors: ["Aleksandar Makelov", "George Lange", "Neel Nanda"], year: 2024, month: "05", venue: null, arxivId: "2405.08366", cluster: 2, cites: 60, influential: 10, hIndex: 30, pagerank: 0.14, relevance: 0.83, tldr: "Compares SAEs to supervised feature dictionaries on IOI, finding SAEs capture only part of the known variables." },
  { n: 18, title: "Automatically Interpreting Millions of Features in Large Language Models", authors: ["Gonçalo Paulo", "Alex Mallen", "Caden Juang", "Nora Belrose"], year: 2024, month: "10", venue: "ICML 2025", arxivId: "2410.13928", cluster: 2, cites: 70, influential: 12, hIndex: 20, pagerank: 0.12, relevance: 0.85, tldr: "An open pipeline for LLM-written feature explanations with cheaper detection and fuzzing scores." },
  { n: 19, title: "SAEBench: A Comprehensive Benchmark for Sparse Autoencoders in Language Model Interpretability", authors: ["Adam Karvonen", "Can Rager", "Johnny Lin", "Neel Nanda"], year: 2025, month: "03", venue: "ICML 2025", arxivId: "2503.09532", cluster: 2, cites: 55, influential: 9, hIndex: 30, pagerank: 0.06, relevance: 0.9, tldr: "Eight metrics across 200+ SAEs show proxy metrics like loss recovered poorly predict downstream usefulness.", origin: "carryover" },
  { n: 20, title: "Are Sparse Autoencoders Useful? A Case Study in Sparse Probing", authors: ["Subhash Kantamneni", "Joshua Engels", "Senthooran Rajamanoharan", "Max Tegmark", "Neel Nanda"], year: 2025, month: "02", venue: "ICML 2025", arxivId: "2502.16681", cluster: 2, cites: 50, influential: 10, hIndex: 40, pagerank: 0.05, relevance: 0.86, tldr: "SAE-feature probes fail to beat strong baselines on 113 datasets, including in data-scarce and shifted settings." },
  { n: 21, title: "Sparse Autoencoders Trained on the Same Data Learn Different Features", authors: ["Gonçalo Paulo", "Nora Belrose"], year: 2025, month: "01", venue: null, arxivId: "2501.16615", cluster: 2, cites: 30, influential: 5, hIndex: 20, pagerank: 0.03, relevance: 0.82, tldr: "Only ~30% of latents are shared between SAEs differing by random seed, questioning feature universality." },
];

const pid = (n: number) => `paper-${String(n).padStart(2, "0")}`;

function percentile(values: number[], v: number): number {
  const below = values.filter((x) => x < v).length;
  return values.length > 1 ? below / (values.length - 1) : 1;
}

const citeValues = SEEDS.map((s) => s.cites);
const velocityOf = (s: Seed) => Math.round((s.cites / Math.max(1, CURRENT_YEAR - s.year)) * 10) / 10;
const velocityValues = SEEDS.map(velocityOf);
const inflValues = SEEDS.map((s) => s.influential);
const prValues = SEEDS.map((s) => s.pagerank);
const hValues = SEEDS.map((s) => s.hIndex);

const ranked = [...SEEDS].sort((a, b) => b.relevance - a.relevance);

export const fixturePapers: PaperLite[] = ranked.map((s, i) => {
  const influence =
    0.3 * percentile(citeValues, s.cites) +
    0.25 * percentile(velocityValues, velocityOf(s)) +
    0.15 * percentile(inflValues, s.influential) +
    0.2 * percentile(prValues, s.pagerank) +
    0.1 * percentile(hValues, s.hIndex);
  return {
    id: pid(s.n),
    title: s.title,
    authors: s.authors,
    year: s.year,
    publishedAt: `${s.year}-${s.month}-15`,
    venue: s.venue,
    arxivId: s.arxivId,
    doi: s.arxivId ? `10.48550/arxiv.${s.arxivId}` : null,
    arxivUrl: s.arxivId ? `https://arxiv.org/abs/${s.arxivId}` : null,
    pdfUrl: s.arxivId ? `https://arxiv.org/pdf/${s.arxivId}` : null,
    ref: `P${s.n}`,
    rank: i + 1,
    relevance: s.relevance,
    influence: Math.round(influence * 1000) / 1000,
    citationCount: s.cites,
    influentialCitationCount: s.influential,
    velocity: velocityOf(s),
    pagerank: s.pagerank,
    maxAuthorHIndex: s.hIndex,
    clusterIdx: s.cluster,
    origin: s.origin ?? "query",
    foundational: s.foundational ?? false,
    gameChanger: s.gameChanger ?? false,
    loggedEntryId: s.logged ? `entry-${s.n}` : null,
    hasExtraction: true,
    tldr: s.tldr,
  };
});

const CLUSTER_META = [
  { label: "Superposition & circuits", keyTerms: ["superposition", "circuits", "residual stream", "polysemantic", "path patching", "neurons"], baseClusterIdx: 0, change: "stable" as const },
  { label: "SAE architectures & scaling", keyTerms: ["sparse autoencoder", "dictionary learning", "top-k", "jumprelu", "scaling laws", "l0"], baseClusterIdx: 1, change: "grew" as const },
  { label: "Evaluating SAE usefulness", keyTerms: ["benchmark", "probing", "feature circuits", "auto-interpretability", "transcoders", "evaluation"], baseClusterIdx: null, change: "new" as const },
];

export const fixtureClusters: ClusterDTO[] = CLUSTER_META.map((meta, idx) => {
  const members = fixturePapers.filter((p) => p.clusterIdx === idx);
  const years = members.map((p) => p.year ?? CURRENT_YEAR);
  return {
    idx,
    label: meta.label,
    summary: null,
    keyTerms: meta.keyTerms,
    size: members.length,
    yearMin: Math.min(...years),
    yearMax: Math.max(...years),
    paperIds: members.map((p) => p.id),
    color: idx + 1,
    baseClusterIdx: meta.baseClusterIdx,
    change: meta.change,
  };
});

const cites = (a: number, b: number, weight = 1): EdgeDTO => ({ source: pid(a), target: pid(b), kind: "cites", weight });
const buildsOn = (a: number, b: number, weight = 1): EdgeDTO => ({ source: pid(a), target: pid(b), kind: "builds_on", weight });
const similar = (a: number, b: number, weight: number): EdgeDTO => ({ source: pid(a), target: pid(b), kind: "similar", weight });

export const fixtureEdges: EdgeDTO[] = [
  cites(3, 2), cites(1, 2), cites(1, 3), cites(4, 1), cites(5, 3), cites(6, 2),
  buildsOn(7, 1), buildsOn(8, 1), cites(8, 4), cites(8, 7), buildsOn(9, 8), cites(9, 7),
  buildsOn(10, 8), cites(10, 9), buildsOn(11, 8), cites(11, 7), buildsOn(12, 11), cites(12, 10),
  buildsOn(13, 12), cites(13, 10), buildsOn(14, 10), cites(14, 13), cites(14, 19),
  buildsOn(15, 7), cites(15, 5), cites(15, 8), buildsOn(16, 15), cites(16, 8),
  cites(17, 5), cites(17, 11), buildsOn(18, 6), cites(18, 9), cites(18, 13),
  buildsOn(19, 13), cites(19, 18), cites(19, 17), cites(20, 13), cites(20, 19), cites(21, 10), cites(21, 13),
  similar(7, 8, 0.86), similar(10, 12, 0.81), similar(11, 12, 0.88), similar(19, 17, 0.74),
  similar(20, 19, 0.7), similar(1, 4, 0.66), similar(15, 16, 0.79),
];

const SEARCH_ID = "search-refresh-2";
const BASE_SEARCH_ID = "search-initial-1";

const summary = {
  id: SEARCH_ID,
  topicId: "topic-sae",
  kind: "refresh" as const,
  depth: "standard" as const,
  status: "done" as const,
  stage: "finalize" as const,
  progress: 1,
  paperCount: fixturePapers.length,
  costUsd: 0.187,
  createdAt: "2026-09-01T10:00:00.000Z",
  startedAt: "2026-09-01T10:00:01.000Z",
  finishedAt: "2026-09-01T10:04:42.000Z",
};

const TOPIC_SUMMARY =
  "Sparse autoencoders (SAEs) decompose model activations into an overcomplete set of sparsely active features, addressing superposition. The field moved from toy models and one-layer demonstrations to production-scale dictionaries with millions of features, and is now contending with whether those features are faithful, universal and useful on downstream tasks.";

export const landscapeSnapshotFixture: LandscapeSnapshot = {
  topic: {
    id: "topic-sae",
    slug: "sparse-autoencoders-for-interpretability",
    name: "Sparse autoencoders for interpretability",
    description: "Dictionary learning on LLM activations: architectures, scaling, evaluation and uses.",
    summary: TOPIC_SUMMARY,
  },
  search: {
    ...summary,
    since: "2026-06-01",
    baseSearchId: BASE_SEARCH_ID,
    queries: [
      { text: "sparse autoencoders for interpretability", arxiv: 'abs:"sparse autoencoder" AND abs:interpretability', categories: ["cs.LG", "cs.CL"] },
      { text: "dictionary learning language model features", arxiv: 'abs:"dictionary learning" AND abs:"language model"', categories: ["cs.LG"] },
      { text: "superposition polysemantic neurons", arxiv: "abs:superposition AND abs:polysemantic", categories: ["cs.LG", "cs.AI"] },
      { text: "evaluating sparse autoencoder features", arxiv: 'abs:"sparse autoencoder" AND abs:evaluat*', categories: ["cs.LG", "cs.CL"] },
    ],
  },
  papers: fixturePapers,
  clusters: fixtureClusters,
  edges: fixtureEdges,
  documents: {
    clusters: {
      topicSummary: TOPIC_SUMMARY,
      clusters: [
        {
          idx: 0,
          name: "Superposition & circuits",
          summary: "The conceptual base: features as the unit of analysis, superposition as the obstacle, and circuit analysis as the goal SAEs serve.",
          keyIdeas: ["Networks represent more features than neurons", "Residual stream as a shared communication channel", "Path patching localizes behaviour to components"],
          representativePaperIds: [pid(1), pid(3), pid(5)],
        },
        {
          idx: 1,
          name: "SAE architectures & scaling",
          summary: "Engineering sparse dictionaries that reconstruct well at low L0 and scale to frontier models.",
          keyIdeas: ["L1 shrinkage and its fixes (gated, JumpReLU, top-k)", "Clean scaling laws in dictionary size", "Open SAE suites lower the barrier to entry", "Hierarchical dictionaries reduce absorption"],
          representativePaperIds: [pid(8), pid(10), pid(12), pid(13)],
        },
        {
          idx: 2,
          name: "Evaluating SAE usefulness",
          summary: "Whether SAE features are faithful, reproducible and beat baselines on tasks people care about.",
          keyIdeas: ["Proxy metrics poorly predict usefulness", "Feature circuits enable targeted edits", "Features vary across seeds", "Automated explanations at scale"],
          representativePaperIds: [pid(19), pid(20), pid(15)],
        },
      ],
    },
    tensions: {
      tensions: [
        {
          title: "Reconstruction vs. interpretability",
          description: "Architectures that push the sparsity-fidelity frontier do not obviously yield more useful or more interpretable features.",
          positions: [
            { stance: "Better reconstruction at fixed L0 is the right optimization target.", paperIds: [pid(10), pid(12)] },
            { stance: "Proxy metrics diverge from downstream usefulness and need task-grounded evaluation.", paperIds: [pid(19), pid(17)] },
          ],
          clusterIdxs: [1, 2],
        },
        {
          title: "Are SAE features canonical?",
          description: "Scaling results suggest a natural feature basis, while seed-sensitivity results suggest dictionaries are one of many decompositions.",
          positions: [
            { stance: "Features recur across scales and models, pointing to real structure.", paperIds: [pid(9), pid(8)] },
            { stance: "Different seeds on identical data share only a minority of latents.", paperIds: [pid(21)] },
          ],
          clusterIdxs: [1, 2],
        },
        {
          title: "SAEs vs. simple baselines",
          description: "Whether SAE features beat linear probes and steering vectors on practical tasks.",
          positions: [
            { stance: "Feature-level circuits enable edits baselines cannot express.", paperIds: [pid(15), pid(16)] },
            { stance: "On sparse probing, SAE features do not outperform strong baselines.", paperIds: [pid(20)] },
          ],
          clusterIdxs: [2],
        },
      ],
    },
    gaps: {
      gaps: [
        {
          title: "Ground-truth feature benchmarks",
          description: "There is no large-scale benchmark where the true features of a realistic model are known.",
          evidence: "Evaluations rely on proxies or small supervised dictionaries on IOI; SAEBench notes proxies disagree with task metrics.",
          evidencePaperIds: [pid(17), pid(19)],
          directions: ["Train models with planted features at scale", "Cross-validate SAE features against causal interventions"],
        },
        {
          title: "Stability across seeds and scales",
          description: "Little work characterizes which features are reliably recovered.",
          evidence: "Only ~30% of latents are shared across seeds, and no paper ties shared latents to downstream utility.",
          evidencePaperIds: [pid(21), pid(14)],
          directions: ["Ensemble or consensus dictionaries", "Report stability alongside reconstruction metrics"],
        },
        {
          title: "Cross-layer mechanisms",
          description: "Most SAEs are trained per layer, fragmenting features that are computed across layers.",
          evidence: "Transcoders and feature circuits stitch per-layer dictionaries post hoc.",
          evidencePaperIds: [pid(16), pid(15)],
          directions: ["Cross-layer or crosscoder dictionaries", "Evaluate circuit faithfulness end to end"],
        },
      ],
    },
    narrative: {
      eras: [
        { label: "Features and superposition", startYear: 2020, endYear: 2022, summary: "Circuits work established features as the unit of analysis; toy models showed superposition hides them from neuron-level inspection.", keyPaperIds: [pid(2), pid(3), pid(1)] },
        { label: "Dictionary learning works", startYear: 2023, endYear: 2023, summary: "Two concurrent papers showed SAEs recover monosemantic features in real language models.", keyPaperIds: [pid(7), pid(8)] },
        { label: "Scaling and open suites", startYear: 2024, endYear: 2024, summary: "Top-k and JumpReLU SAEs fixed shrinkage and scaled to frontier models; Gemma Scope made SAEs a commodity.", keyPaperIds: [pid(9), pid(10), pid(13)] },
        { label: "Is it useful?", startYear: 2025, endYear: null, summary: "The frontier shifted from building bigger dictionaries to testing whether features are stable and beat baselines.", keyPaperIds: [pid(19), pid(20), pid(21)] },
      ],
      gameChangers: [
        { paperId: pid(8), why: "Made dictionary learning the default method for finding features in transformers.", evidence: "Highest influential citations (150) and PageRank in the pool; 5 builds_on in-edges." },
        { paperId: pid(1), why: "Supplied the theory that explains why neurons are polysemantic.", evidence: "780 citations and top PageRank; cited by both founding SAE papers." },
        { paperId: pid(10), why: "Top-k SAEs and scaling laws turned SAE training into an engineering discipline.", evidence: "Velocity 170/yr, second-highest in the pool; built on by Matryoshka SAEs." },
      ],
      frontier: {
        summary: "Work now centres on evaluation: task-grounded benchmarks, seed stability and head-to-head comparisons with probing baselines, with hierarchical dictionaries as the main architectural response.",
        paperIds: [pid(19), pid(20), pid(14), pid(21)],
      },
      outlook: "Expect fewer new activation functions and more benchmarks with ground truth, cross-layer dictionaries, and evidence that SAEs help on safety-relevant tasks.",
      whatChanged: "Since June, a distinct evaluation cluster emerged: SAEBench and the sparse-probing negative result reframed the field around usefulness, and Matryoshka SAEs joined the architectures cluster.",
    },
    readingPath: {
      steps: [
        { phase: "foundations", paperId: pid(1), reason: "The superposition hypothesis is the problem every SAE paper is solving." },
        { phase: "foundations", paperId: pid(3), reason: "The residual-stream view explains where SAEs are attached and why." },
        { phase: "core", paperId: pid(8), reason: "The clearest end-to-end demonstration that dictionary learning finds real features." },
        { phase: "core", paperId: pid(10), reason: "Top-k SAEs and scaling laws are the modern training recipe." },
        { phase: "core", paperId: pid(12), reason: "JumpReLU is the architecture behind the most widely used open SAEs." },
        { phase: "core", paperId: pid(15), reason: "Shows what you can do with features once you have them." },
        { phase: "frontier", paperId: pid(19), reason: "The benchmark that shows why proxy metrics are not enough." },
        { phase: "frontier", paperId: pid(20), reason: "The strongest negative result on practical usefulness." },
        { phase: "frontier", paperId: pid(21), reason: "Challenges the idea of a canonical feature basis." },
      ],
    },
    diff: {
      baseSearchId: BASE_SEARCH_ID,
      since: "2026-06-01",
      newPaperIds: [pid(14), pid(19), pid(20), pid(21)],
      droppedPaperIds: ["paper-90", "paper-91"],
      rising: [
        { paperId: pid(10), citationsBefore: 290, citationsAfter: 340, delta: 50 },
        { paperId: pid(13), citationsBefore: 175, citationsAfter: 210, delta: 35 },
        { paperId: pid(19), citationsBefore: 30, citationsAfter: 55, delta: 25 },
      ],
      clusterChanges: [
        { idx: 0, baseIdxs: [0], change: "stable", label: "Superposition & circuits", sizeBefore: 6, sizeAfter: 6 },
        { idx: 1, baseIdxs: [1], change: "grew", label: "SAE architectures & scaling", sizeBefore: 7, sizeAfter: 8 },
        { idx: 2, baseIdxs: [], change: "new", label: "Evaluating SAE usefulness", sizeBefore: 0, sizeAfter: 7 },
      ],
    },
  },
  failedDocuments: [],
};

// --- companion fixtures for list / progress UIs ------------------------------

export const topicCardFixture: TopicCard = {
  ...landscapeSnapshotFixture.topic,
  defaultDepth: "standard",
  paperCount: fixturePapers.length,
  lastSearchAt: summary.finishedAt,
  lastSearch: summary,
  activeSearch: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: summary.finishedAt,
};

export const runningProgressFixture: SearchProgress = {
  ...summary,
  id: "search-running-3",
  kind: "full",
  depth: "deep",
  status: "running",
  stage: "extract",
  progress: 0.58,
  paperCount: 0,
  costUsd: 0.21,
  finishedAt: null,
  error: null,
  cancelRequested: false,
  heartbeatAt: "2026-09-02T10:06:10.000Z",
  stages: [
    ["plan", "done"], ["expand", "done"], ["collect", "done"], ["embed", "done"], ["prerank", "done"],
    ["citations", "done"], ["enrich", "done"], ["rerank", "done"], ["graph", "done"], ["cluster", "done"],
    ["fulltext", "done"], ["extract", "running"], ["diff", "skipped"], ["synthesize", "pending"], ["finalize", "pending"],
  ].map(([stage, status]) => ({
    stage: stage as SearchProgress["stages"][number]["stage"],
    status: status as SearchProgress["stages"][number]["status"],
    startedAt: status === "pending" || status === "skipped" ? null : "2026-09-02T10:00:00.000Z",
    finishedAt: status === "done" ? "2026-09-02T10:01:00.000Z" : null,
    error: null,
  })),
  counters: {
    queries: 13, fetched: 1840, candidates: 900, embedded: 900, citationAdmitted: 212, enriched: 900,
    reranked: 250, selected: 100, clusters: 7, fulltextFetched: 9, extracted: 46, extractionCacheHits: 21, llmCalls: 12,
  },
  tokens: { inputTokens: 61_000, outputTokens: 18_500, cacheReadTokens: 0, cacheWriteTokens: 0 },
  failedDocuments: [],
};
