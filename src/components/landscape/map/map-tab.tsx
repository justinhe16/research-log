import { WaypointsIcon } from "lucide-react";

import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { ComingSoon } from "../coming-soon";

export type MapTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

// Placeholder: replaced in Wave D. Keep the props contract.
export function MapTab({ snapshot }: MapTabProps) {
  return (
    <div data-search-id={snapshot.search.id}>
      <ComingSoon icon={WaypointsIcon} title="Map" body="An interactive citation map, with papers sized by influence and colored by cluster." />
    </div>
  );
}
