import { describe, expect, it } from "vitest";

import { landscapeSnapshotFixture as snapshot } from "../../__fixtures__/snapshot";
import { computeLayout, labelText, nodeSize, ZOOM_BANDS, zoomBandIndex } from "../layout";

describe("computeLayout", () => {
  it("is deterministic for the same snapshot, regardless of input order", () => {
    const a = computeLayout(snapshot.papers, snapshot.clusters, snapshot.edges);
    const b = computeLayout([...snapshot.papers].reverse(), snapshot.clusters, [...snapshot.edges].reverse());
    expect(a.positions.size).toBe(snapshot.papers.length);
    for (const [id, p] of a.positions) {
      expect(b.positions.get(id)).toEqual(p);
    }
  });

  it("places every paper without overlapping circles", () => {
    const { positions } = computeLayout(snapshot.papers, snapshot.clusters, snapshot.edges);
    const pts = [...positions.values()];
    for (let i = 0; i < pts.length; i++) {
      expect(Number.isFinite(pts[i].x) && Number.isFinite(pts[i].y)).toBe(true);
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        expect(d).toBeGreaterThanOrEqual((pts[i].size + pts[j].size) / 2 - 1);
      }
    }
  });

  it("keeps a cluster's papers closer to their own anchor than to others", () => {
    const { positions, anchors } = computeLayout(snapshot.papers, snapshot.clusters, snapshot.edges);
    let own = 0;
    for (const p of snapshot.papers) {
      const pos = positions.get(p.id)!;
      const dist = (g: number) => Math.hypot(pos.x - anchors.get(g)!.x, pos.y - anchors.get(g)!.y);
      const nearest = [...anchors.keys()].sort((x, y) => dist(x) - dist(y))[0];
      if (nearest === (p.clusterIdx ?? -1)) own++;
    }
    expect(own / snapshot.papers.length).toBeGreaterThan(0.85);
  });

  it("handles missing clusters and empty input", () => {
    expect(computeLayout([], null, []).positions.size).toBe(0);
    const { positions, anchors } = computeLayout(snapshot.papers.slice(0, 5), null, []);
    expect(positions.size).toBe(5);
    expect([...anchors.keys()]).toEqual([-1]);
  });

  it("sizes nodes by influence", () => {
    expect(nodeSize(0)).toBe(12);
    expect(nodeSize(1)).toBe(40);
    expect(nodeSize(Number.NaN)).toBe(12);
  });

  it("culls labels so none collide at each zoom band", () => {
    const { positions, labels } = computeLayout(snapshot.papers, snapshot.clusters, snapshot.edges);
    expect(labels).toHaveLength(ZOOM_BANDS.length);
    labels.forEach((ids, band) => {
      const { planZoom: z, maxLabels } = ZOOM_BANDS[band];
      expect(ids.size).toBeGreaterThan(0);
      expect(ids.size).toBeLessThanOrEqual(maxLabels);
      const boxes = [...ids].map((id) => {
        const p = positions.get(id)!;
        const title = snapshot.papers.find((x) => x.id === id)!.title;
        const w = Math.min(168, labelText(title).length * 6 + 8) / z;
        const top = p.y + p.size / 2 + 6 / z;
        return { x0: p.x - w / 2, x1: p.x + w / 2, y0: top, y1: top + 16 / z };
      });
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
        }
    });
    expect(zoomBandIndex(0.3)).toBe(0);
    expect(zoomBandIndex(1)).toBe(2);
    expect(zoomBandIndex(2)).toBe(3);
  });
});
