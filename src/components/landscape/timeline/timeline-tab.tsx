import { ChartGanttIcon } from "lucide-react";

import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { ComingSoon } from "../coming-soon";

export type TimelineTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

// Placeholder: replaced in Wave D. Keep the props contract.
export function TimelineTab({ snapshot }: TimelineTabProps) {
  return (
    <div data-search-id={snapshot.search.id}>
      <ComingSoon icon={ChartGanttIcon} title="Timeline" body="Each cluster laid out over time, with lineage between papers and the eras they belong to." />
    </div>
  );
}
