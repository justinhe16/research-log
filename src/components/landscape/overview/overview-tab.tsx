import { LayoutDashboardIcon } from "lucide-react";

import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { ComingSoon } from "../coming-soon";

export type OverviewTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

// Placeholder: replaced in Wave D. Keep the props contract.
export function OverviewTab({ snapshot }: OverviewTabProps) {
  return (
    <div data-search-id={snapshot.search.id}>
      <ComingSoon icon={LayoutDashboardIcon} title="Overview" body="Eras, game-changing papers, clusters, tensions and open gaps for this field will appear here." />
    </div>
  );
}
