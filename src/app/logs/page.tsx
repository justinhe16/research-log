import type { Metadata } from "next";

import { EntriesView } from "@/components/entries/entries-view";

export const metadata: Metadata = {
  title: "Logs",
  description: "Log your historical readings and track what to read next.",
};

export default function LogsPage() {
  return <EntriesView />;
}
