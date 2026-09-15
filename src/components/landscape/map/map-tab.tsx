"use client";

import dynamic from "next/dynamic";
import { WaypointsIcon } from "lucide-react";

import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { StateMessage } from "../state-message";
import { MapSkeleton } from "./map-skeleton";

export type MapTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

// xyflow and d3-force load only when this tab is opened.
const LandscapeMap = dynamic(() => import("./landscape-map"), { ssr: false, loading: MapSkeleton });

export function MapTab({ snapshot, onOpenPaper }: MapTabProps) {
  if (snapshot.papers.length === 0) {
    return (
      <StateMessage
        icon={<WaypointsIcon />}
        title="Nothing to map yet"
        body="This search has no selected papers. Run a deeper search to collect papers and their citations."
      />
    );
  }
  return <LandscapeMap snapshot={snapshot} onOpenPaper={onOpenPaper} />;
}
