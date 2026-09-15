"use client";

import { memo } from "react";
import type { EdgeProps } from "@xyflow/react";

import { useEdgeEmphasis, type PaperEdgeType } from "./map-context";

/** Gap between an edge's end and the circle, leaving room for the logged ring. */
const END_GAP = 5;
const ARROW = 6;

/**
 * A straight edge between circle centers, clipped to each circle's rim. The
 * layout is static, so the geometry comes from edge data rather than handles.
 */
function PaperEdgeComponent({ id, source, target, data }: EdgeProps<PaperEdgeType>) {
  const emphasis = useEdgeEmphasis(source, target);
  if (!data) return null;

  const dx = data.tx - data.sx;
  const dy = data.ty - data.sy;
  const len = Math.hypot(dx, dy);
  if (len < data.sr + data.tr + END_GAP * 2) return null;
  const ux = dx / len;
  const uy = dy / len;

  const x1 = data.sx + ux * (data.sr + END_GAP / 2);
  const y1 = data.sy + uy * (data.sr + END_GAP / 2);
  const tipX = data.tx - ux * (data.tr + END_GAP);
  const tipY = data.ty - uy * (data.tr + END_GAP);

  const arrow = data.kind === "builds_on";
  const x2 = arrow ? tipX - ux * ARROW : tipX;
  const y2 = arrow ? tipY - uy * ARROW : tipY;

  const incident = emphasis === "incident";
  const dimmed = emphasis === "dimmed";

  const tone = incident ? 62 : data.kind === "builds_on" ? 34 : data.kind === "cites" ? 20 : 26;
  const stroke = `color-mix(in oklab, var(--foreground) ${tone}%, transparent)`;
  const width = data.kind === "builds_on" ? (incident ? 1.75 : 1.25) : incident ? 1.25 : 0.75;

  return (
    <g
      className="transition-opacity duration-200 motion-reduce:transition-none"
      style={{ opacity: dimmed ? 0.12 : 1 }}
      data-kind={data.kind}
    >
      <path
        id={id}
        d={`M ${x1} ${y1} L ${x2} ${y2}`}
        fill="none"
        style={{ stroke, strokeWidth: width, strokeDasharray: data.kind === "similar" ? "1.5 3.5" : undefined, strokeLinecap: "round" }}
      />
      {arrow ? (
        <path
          d={`M ${tipX} ${tipY} L ${x2 - uy * ARROW * 0.55} ${y2 + ux * ARROW * 0.55} L ${x2 + uy * ARROW * 0.55} ${y2 - ux * ARROW * 0.55} Z`}
          style={{ fill: stroke }}
        />
      ) : null}
    </g>
  );
}

export const PaperEdge = memo(PaperEdgeComponent);
