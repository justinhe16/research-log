import { ListOrderedIcon } from "lucide-react";

import type { LandscapeSnapshot } from "@/lib/landscape/types";
import { ComingSoon } from "../coming-soon";

export type ReadingPathTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

// Placeholder: replaced in Wave D. Keep the props contract.
export function ReadingPathTab({ snapshot }: ReadingPathTabProps) {
  return (
    <div data-search-id={snapshot.search.id}>
      <ComingSoon icon={ListOrderedIcon} title="Reading path" body="A numbered route from foundations to the frontier, with a reason for each paper." />
    </div>
  );
}
