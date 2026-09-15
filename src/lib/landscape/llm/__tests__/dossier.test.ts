import { describe, expect, it } from "vitest";
import { approxTokens, buildDossier, clip, DossierBudgetError, orderPapers } from "../dossier";
import { syntheticDossierInput } from "./fixtures";

describe("buildDossier", () => {
  it("is deterministic regardless of input order (snapshot)", () => {
    const input = syntheticDossierInput(8);
    const a = buildDossier(input);
    const b = buildDossier({ ...input, papers: [...input.papers].reverse(), edges: [...input.edges].reverse() });
    expect(b.text).toBe(a.text);
    expect(a.text).toMatchSnapshot();
    expect(a.refMap.P1).toBe("paper-000");
    expect(a.clusterIdxs).toEqual([0, 1, 2, 3]);
  });

  it("orders by cluster (nulls last), then date, then id", () => {
    const ordered = orderPapers(syntheticDossierInput(12).papers);
    const clusters = ordered.map((p) => p.clusterIdx ?? 99);
    expect(clusters).toEqual([...clusters].sort((x, y) => x - y));
    expect(ordered.at(-1)!.clusterIdx).toBeNull();
  });

  it("fits 100 papers under 30k tokens at ~130 tokens/card", () => {
    const d = buildDossier(syntheticDossierInput(100));
    expect(d.approxTokens).toBeLessThanOrEqual(30_000);
    expect(d.approxTokens).toBe(approxTokens(d.text));
    expect(Object.keys(d.refMap)).toHaveLength(100);
    expect(d.text).toContain("[P100]");
  });

  it("shrinks field caps when over budget", () => {
    const input = syntheticDossierInput(100, { longFields: true });
    const full = buildDossier(input, { maxTokens: 1e9 });
    const tight = buildDossier(input, { maxTokens: 20_000 });
    expect(tight.approxTokens).toBeLessThan(full.approxTokens);
    expect(tight.approxTokens).toBeLessThanOrEqual(20_000);
    // Every paper is still present.
    for (let i = 1; i <= 100; i++) expect(tight.text).toContain(`[P${i}]`);
  });

  it("throws a clear error when even the most compact cards exceed the budget", () => {
    const err = (() => {
      try {
        buildDossier(syntheticDossierInput(100, { longFields: true }), { maxTokens: 1_000 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(DossierBudgetError);
    expect((err as Error).message).toMatch(/100 papers .* over the 1000-token budget/);
  });

  it("omits PageRank from cards and the legend when the search has no citation graph", () => {
    const input = syntheticDossierInput(4);
    const withPr = buildDossier(input);
    expect(withPr.text).toMatch(/ · pr \d/);
    const noGraph = {
      ...input,
      papers: input.papers.map((p) => ({ ...p, metrics: { ...p.metrics, pagerank: null } })),
    };
    const text = buildDossier(noGraph).text;
    expect(text).not.toMatch(/\bpr\b/);
    expect(text).toContain("No citation graph was available");
    expect(text).toMatch(/cites \d+ \(infl [\d?]+\) · vel [\d.?]+\/y · influence/);
  });

  it("uses only builds_on edges and ignores unknown candidates", () => {
    const d = buildDossier(syntheticDossierInput(4));
    expect(d.text).not.toContain("not-in-set");
    expect(d.text).toMatch(/P2 -> P1\n/);
  });

  it("rejects duplicate refs", () => {
    const input = syntheticDossierInput(3);
    input.papers[1].ref = "P1";
    expect(() => buildDossier(input)).toThrow(/Duplicate/);
  });

  it("clip cuts at word boundaries and strips markup", () => {
    expect(clip("<b>alpha</b> beta gamma delta", 16)).toBe("alpha beta…");
    expect(clip(null, 10)).toBe("");
  });
});
