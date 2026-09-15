"use client";

import { memo } from "react";
import { Handle, Position, useStore, type NodeProps, type ReactFlowState } from "@xyflow/react";
import { SparklesIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { LABEL_GAP, labelText, zoomBandIndex } from "./layout";
import { useNodeEmphasis, type PaperNodeType } from "./map-context";

const zoomBand = (s: ReactFlowState) => zoomBandIndex(s.transform[2]);

const HIDDEN_HANDLE = "!pointer-events-none !top-1/2 !left-1/2 !size-px !min-h-0 !min-w-0 !-translate-1/2 !border-0 !opacity-0";

function PaperNodeComponent({ id, data, width }: NodeProps<PaperNodeType>) {
  const { paper, color, isNew, labelBands } = data;
  const emphasis = useNodeEmphasis(id);
  const band = useStore(zoomBand);

  const size = width ?? 12;
  const active = emphasis === "active";
  const dimmed = emphasis === "dimmed";
  // The hover card names the active paper; its neighbours always get labels.
  const showLabel = !active && !dimmed && (emphasis === "neighbor" || labelBands[band]);

  return (
    <div
      className={cn(
        "paper-node relative transition-opacity duration-200 motion-reduce:transition-none",
        dimmed ? "opacity-25" : "opacity-100",
      )}
      style={{ width: size, height: size, "--node-color": color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={HIDDEN_HANDLE} />

      {paper.loggedEntryId ? (
        <span
          aria-hidden
          className="absolute -inset-[4px] rounded-full border-[1.5px] border-dashed"
          style={{ borderColor: "color-mix(in oklab, var(--node-color), var(--foreground) 20%)" }}
        />
      ) : null}

      <span
        aria-hidden
        className={cn(
          "paper-node__disc absolute inset-0 rounded-full transition-[box-shadow,scale] duration-200 motion-reduce:transition-none",
          active && "scale-110",
        )}
        style={{
          background: "color-mix(in oklab, var(--node-color) 22%, var(--card))",
          boxShadow: active
            ? "inset 0 0 0 2px var(--node-color), 0 0 0 5px color-mix(in oklab, var(--node-color) 20%, transparent)"
            : "inset 0 0 0 1.5px var(--node-color)",
        }}
      />

      {paper.gameChanger ? (
        <span
          aria-hidden
          className="bg-card text-foreground/80 ring-border absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full ring-1"
        >
          <SparklesIcon className="size-2.5" strokeWidth={2.25} />
        </span>
      ) : null}

      {isNew ? (
        <span
          aria-hidden
          className="ring-card absolute size-1.5 rounded-full bg-emerald-500 ring-[1.5px]"
          style={{ top: size * 0.15 - 3, left: size * 0.15 - 3 }}
        />
      ) : null}

      {showLabel ? (
        <span
          className="text-foreground/85 pointer-events-none absolute top-full left-1/2 max-w-[168px] origin-top truncate text-[11px] leading-4 font-medium tracking-tight whitespace-nowrap"
          style={{
            marginTop: `calc(${LABEL_GAP}px / var(--zoom, 1))`,
            transform: "scale(calc(1 / var(--zoom, 1))) translateX(-50%)",
            transformOrigin: "0 0",
            textShadow: "0 0 2px var(--card), 0 0 4px var(--card), 0 0 6px var(--card)",
          }}
        >
          {labelText(paper.title)}
        </span>
      ) : null}
    </div>
  );
}

export const PaperNode = memo(PaperNodeComponent);
