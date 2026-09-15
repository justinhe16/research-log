import { describe, expect, it } from "vitest";

import { landscapeSnapshotFixture as snap } from "@/components/landscape/__fixtures__/snapshot";
import type { ClusterDTO, PaperLite } from "@/lib/landscape/types";
import {
  assignLanes,
  computeTimelineLayout,
  fitLabel,
  LAYOUT,
  packLane,
  paperYearFraction,
  timeDomain,
  UNCLUSTERED_LANE,
} from "../layout";

const colorOf = (c: ClusterDTO) => `var(--chart-${c.color})`;

function layout(papers: PaperLite[] = snap.papers, width = 900) {
  return computeTimelineLayout({
    papers,
    clusters: snap.clusters,
    edges: snap.edges,
    eras: snap.documents.narrative?.eras ?? [],
    width,
    colorOf,
  });
}

function paper(over: Partial<PaperLite>): PaperLite {
  return { ...snap.papers[0], ...over };
}

describe("paperYearFraction", () => {
  it("reads month and day, falls back to mid-year, and returns null without a date", () => {
    expect(paperYearFraction({ publishedAt: "2024-01-01", year: 2024 })).toBe(2024);
    expect(paperYearFraction({ publishedAt: "2024-07-01", year: 2024 })).toBeCloseTo(2024.5);
    expect(paperYearFraction({ publishedAt: null, year: 2021 })).toBe(2021.5);
    expect(paperYearFraction({ publishedAt: null, year: null })).toBeNull();
  });
});

describe("timeDomain", () => {
  it("snaps to whole years, covers eras and is at least two years wide", () => {
    expect(timeDomain([2020.2, 2025.7])).toEqual([2020, 2026]);
    expect(timeDomain([2023.4])).toEqual([2022, 2024]);
    expect(timeDomain([2023.4], [{ startYear: 2019, endYear: 2024 }])).toEqual([2019, 2025]);
  });
});

describe("assignLanes", () => {
  it("orders clusters by their earliest paper and puts unclustered papers last", () => {
    const papers = [
      paper({ id: "a", clusterIdx: 1, publishedAt: "2019-05-01" }),
      paper({ id: "b", clusterIdx: 0, publishedAt: "2022-05-01" }),
      paper({ id: "c", clusterIdx: null, publishedAt: "2018-05-01" }),
      paper({ id: "d", clusterIdx: 2, publishedAt: null, year: null }),
    ];
    const lanes = assignLanes(papers, snap.clusters, colorOf);
    expect(lanes.map((l) => l.idx)).toEqual([1, 0, UNCLUSTERED_LANE]);
    expect(lanes[2].label).toBe("Unclustered");
  });

  it("follows cluster start order on the fixture", () => {
    expect(layout().lanes.map((l) => l.idx)).toEqual([0, 1, 2]);
  });
});

describe("packLane", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`,
    x: 100 + (i % 3) * 4,
    r: 4 + (i % 4) * 2,
    influence: (i * 37) % 10 / 10,
    t: 2020 + i / 12,
  }));

  it("is deterministic regardless of input order", () => {
    const a = packLane(items).offsets;
    const b = packLane([...items].reverse()).offsets;
    for (const item of items) expect(b.get(item.id)).toEqual(a.get(item.id));
  });

  it("puts the most influential paper on the centre line and avoids overlap", () => {
    const { offsets, overflow } = packLane(items);
    expect(overflow).toEqual([]);
    const top = [...items].sort((p, q) => q.influence - p.influence)[0];
    expect(offsets.get(top.id)).toEqual({ dx: 0, dy: 0 });
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const oa = offsets.get(a.id)!;
        const ob = offsets.get(b.id)!;
        const d = Math.hypot(a.x + oa.dx - (b.x + ob.dx), oa.dy - ob.dy);
        expect(d).toBeGreaterThanOrEqual(a.r + b.r + LAYOUT.gap - 1e-9);
      }
    }
  });

  it("jitters sideways before overflowing when capped", () => {
    const column = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, x: 200, r: LAYOUT.rMin, influence: 1 - i / 30, t: 2024 }));
    const { offsets, overflow } = packLane(column, 30);
    expect([...offsets.values()].some((o) => o.dx !== 0)).toBe(true);
    expect(overflow.length).toBeGreaterThan(0);
    expect(offsets.size + overflow.length).toBe(column.length);
    // The least influential papers are the ones collapsed.
    expect(overflow).toContain("c29");
    for (const o of offsets.values()) {
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(LAYOUT.jitterStep * LAYOUT.jitterSteps);
      expect(Math.abs(o.dy) + LAYOUT.rMin).toBeLessThanOrEqual(30);
    }
  });
});

describe("computeTimelineLayout", () => {
  it("places every dated paper inside its lane and the plot", () => {
    const l = layout();
    expect(l.placed).toHaveLength(snap.papers.length);
    expect(l.undated).toHaveLength(0);
    for (const p of l.placed) {
      const lane = l.lanes.find((x) => x.idx === p.laneIdx)!;
      expect(p.y - p.r).toBeGreaterThanOrEqual(lane.y);
      expect(p.y + p.r).toBeLessThanOrEqual(lane.y + lane.height);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(l.width);
    }
  });

  it("is stable across paper order", () => {
    const a = layout();
    const b = layout([...snap.papers].reverse());
    for (const p of a.placed) {
      const q = b.byId.get(p.paper.id)!;
      expect([q.x, q.y, q.laneIdx]).toEqual([p.x, p.y, p.laneIdx]);
    }
  });

  it("keeps only builds_on edges between placed papers, and separates undated papers", () => {
    const papers = snap.papers.map((p) => (p.id === "paper-08" ? { ...p, publishedAt: null, year: null } : p));
    const l = layout(papers);
    expect(l.undated.map((p) => p.id)).toEqual(["paper-08"]);
    expect(l.edges.every((e) => e.source !== "paper-08" && e.target !== "paper-08")).toBe(true);
    expect(l.edges.length).toBeGreaterThan(0);
    expect(snap.edges.filter((e) => e.kind === "builds_on").length).toBeGreaterThan(l.edges.length);
  });

  it("clips ongoing eras to the domain and handles no dated papers", () => {
    const l = layout();
    const last = l.eras[l.eras.length - 1];
    expect(last.endYear).toBeNull();
    expect(last.x1).toBeCloseTo(l.width - LAYOUT.padX);
    const empty = layout(snap.papers.map((p) => ({ ...p, publishedAt: null, year: null })));
    expect(empty.placed).toHaveLength(0);
    expect(empty.lanes).toHaveLength(0);
    expect(empty.eras).toHaveLength(0);
  });
});

describe("dense lanes", () => {
  // 100 papers in one cluster, all in the same year.
  const dense = Array.from({ length: 100 }, (_, i) =>
    paper({
      id: `dense-${String(i).padStart(3, "0")}`,
      rank: i + 1,
      clusterIdx: 1,
      publishedAt: `2024-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      influence: ((i * 53) % 100) / 100,
    }),
  );

  it("caps lane height and collapses the rest into +N markers", () => {
    const l = layout(dense, 700);
    expect(l.lanes).toHaveLength(1);
    const lane = l.lanes[0];
    expect(lane.height).toBe(LAYOUT.laneMax);
    expect(lane.size).toBe(100);
    const hidden = l.overflow.flatMap((m) => m.papers);
    expect(hidden.length).toBeGreaterThan(0);
    expect(l.placed.length + hidden.length).toBe(100);
    expect(new Set([...l.placed.map((p) => p.paper.id), ...hidden.map((p) => p.id)]).size).toBe(100);
    expect(l.undated).toHaveLength(0);
    for (const p of l.placed) {
      expect(p.y - p.r).toBeGreaterThanOrEqual(lane.y);
      expect(p.y + p.r).toBeLessThanOrEqual(lane.y + lane.height - LAYOUT.markerRow);
    }
    const xs = l.overflow.map((m) => m.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(LAYOUT.markerMinGap - 1);
    for (const m of l.overflow) {
      expect(m.y).toBeGreaterThan(lane.y + lane.height - LAYOUT.markerRow - 4);
      expect(m.y).toBeLessThan(lane.y + lane.height);
    }
  });

  it("is deterministic for dense input in any order", () => {
    const a = layout(dense, 700);
    const b = layout([...dense].reverse(), 700);
    expect(b.overflow.map((m) => [m.id, m.x, m.papers.map((p) => p.id)])).toEqual(
      a.overflow.map((m) => [m.id, m.x, m.papers.map((p) => p.id)]),
    );
    for (const p of a.placed) {
      const q = b.byId.get(p.paper.id)!;
      expect([q.x, q.y]).toEqual([p.x, p.y]);
    }
  });
});

describe("fitLabel", () => {
  it("truncates with an ellipsis and hides labels in tiny bands", () => {
    expect(fitLabel("Scaling and open suites", 400)).toBe("Scaling and open suites");
    expect(fitLabel("Scaling and open suites", 61)).toMatch(/…$/);
    expect(fitLabel("Scaling", 12)).toBe("");
  });
});
