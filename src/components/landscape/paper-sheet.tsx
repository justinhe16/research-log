"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  BookmarkCheckIcon,
  BookmarkPlusIcon,
  ExternalLinkIcon,
  FileTextIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { landscapeApi } from "@/lib/landscape/api-client";
import type { ClusterDTO, EdgeKind, PaperDetail, PaperLite, PaperRelation } from "@/lib/landscape/types";
import { cn } from "@/lib/utils";
import { clusterColor } from "./cluster-colors";
import { useFixtureMode } from "./fixture-mode";
import { errorMessage, formatCount } from "./format";
import { ClusterChip, LABEL_CLASS, Metric } from "./metric";
import { shortDate } from "./papers/papers-table";

type PaperSheetProps = {
  /** The paper from the snapshot; null closes the sheet. */
  paper: PaperLite | null;
  searchId: string;
  topicName: string;
  clusters: ClusterDTO[];
  isNew: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenPaper: (paperId: string) => void;
  /** Called after "Log this paper" creates an entry. */
  onLogged: (paperId: string, entryId: string) => void;
};

export function PaperSheet({ paper, onOpenChange, ...rest }: PaperSheetProps) {
  return (
    <Sheet open={paper !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        {paper ? (
          <PaperSheetBody key={paper.id} paper={paper} {...rest} />
        ) : (
          <SheetTitle className="sr-only">Paper</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}

type DetailState = { detail: PaperDetail | null; error: string | null; loading: boolean };

function usePaperDetail(paperId: string, searchId: string): DetailState {
  const fixture = useFixtureMode();
  const [state, setState] = useState<DetailState>({ detail: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = fixture
          ? (await import("./dev-fixtures")).fixturePaperDetail(paperId)
          : await landscapeApi.getPaper(paperId, searchId);
        if (!cancelled) setState({ detail, error: null, loading: false });
      } catch (err) {
        if (!cancelled) setState({ detail: null, error: errorMessage(err, "Could not load paper details."), loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paperId, searchId, fixture]);
  return state;
}

function PaperSheetBody({
  paper,
  searchId,
  topicName,
  clusters,
  isNew,
  onOpenPaper,
  onLogged,
}: Omit<PaperSheetProps, "paper" | "onOpenChange"> & { paper: PaperLite }) {
  const fixture = useFixtureMode();
  const { detail, error, loading } = usePaperDetail(paper.id, searchId);
  const [logging, setLogging] = useState(false);
  const cluster = clusters.find((c) => c.idx === paper.clusterIdx) ?? null;
  const color = clusterColor(clusters, paper.clusterIdx);
  const logUrl = paper.arxivUrl ?? (paper.doi ? `https://doi.org/${paper.doi}` : null) ?? paper.pdfUrl;
  const extraction = detail?.extraction ?? null;
  const loggedEntryId = paper.loggedEntryId ?? detail?.loggedEntryId ?? null;

  async function logPaper() {
    if (!logUrl) return;
    setLogging(true);
    try {
      const entryId = fixture
        ? `fixture-entry-${paper.id}`
        : (await api.createEntry({ url: logUrl, whySaved: `Found in the ${topicName} landscape.` })).id;
      onLogged(paper.id, entryId);
      toast.success("Logged — reading it now", { description: paper.title });
    } catch (err) {
      toast.error(errorMessage(err, "Could not log this paper."));
    } finally {
      setLogging(false);
    }
  }

  const meta = [paper.venue, shortDate(paper) !== "—" ? shortDate(paper) : null].filter(Boolean) as string[];

  return (
    <>
      <SheetHeader className="border-border/60 gap-2.5 border-b px-5 pt-5 pb-4 pr-12">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted-foreground font-mono tracking-tight tabular-nums">#{paper.rank}</span>
          {cluster ? <ClusterChip color={color} label={cluster.label} /> : null}
          {paper.gameChanger ? (
            <Badge variant="outline" className="border-border/70 h-4.5 rounded px-1.5 text-[10px] font-normal">
              <SparklesIcon aria-hidden />
              Game-changer
            </Badge>
          ) : null}
          {paper.foundational ? (
            <Badge variant="outline" className="border-border/70 text-muted-foreground h-4.5 rounded px-1.5 text-[10px] font-normal">
              Foundational
            </Badge>
          ) : null}
          {isNew ? (
            <Badge className="h-4.5 rounded bg-emerald-500/12 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              New
            </Badge>
          ) : null}
          {paper.origin === "citation" ? <span className="text-muted-foreground">Found via citations</span> : null}
        </div>
        <SheetTitle className="text-lg leading-snug font-medium text-balance">{paper.title}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-foreground/75 line-clamp-2">{paper.authors.join(", ") || "Unknown authors"}</span>
            {meta.length > 0 ? <span>{meta.join(" · ")}</span> : null}
          </div>
        </SheetDescription>

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {loggedEntryId ? (
            <Button asChild size="sm" variant="secondary" className="text-xs">
              <Link href="/logs">
                <BookmarkCheckIcon data-icon="inline-start" />
                In your log
              </Link>
            </Button>
          ) : (
            <Button size="sm" className="text-xs" onClick={() => void logPaper()} disabled={!logUrl || logging} title={logUrl ? undefined : "No link to log"}>
              {logging ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <BookmarkPlusIcon data-icon="inline-start" />}
              Log this paper
            </Button>
          )}
          {paper.arxivUrl ? (
            <Button asChild size="sm" variant="outline" className="text-xs">
              <a href={paper.arxivUrl} target="_blank" rel="noreferrer">
                arXiv
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
          {paper.pdfUrl ? (
            <Button asChild size="sm" variant="outline" className="text-xs">
              <a href={paper.pdfUrl} target="_blank" rel="noreferrer">
                <FileTextIcon data-icon="inline-start" />
                PDF
              </a>
            </Button>
          ) : null}
          {!paper.arxivUrl && paper.doi ? (
            <Button asChild size="sm" variant="outline" className="text-xs">
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                DOI
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
        <section className="grid grid-cols-3 gap-x-4 gap-y-4" aria-label="Metrics">
          <Metric label="Relevance" value={Math.round(paper.relevance * 100)} hint="of 100 in this search" />
          <Metric label="Influence" value={Math.round(paper.influence * 100)} hint="of 100 in this search" />
          <Metric label="Citations" value={formatCount(paper.citationCount)} />
          <Metric label="Velocity" value={paper.velocity === null ? "—" : formatCount(paper.velocity)} hint="citations / year" />
          <Metric label="Influential" value={formatCount(paper.influentialCitationCount)} hint="citations" />
          <Metric label="Max h-index" value={formatCount(paper.maxAuthorHIndex)} hint="across authors" />
          <Metric label="PageRank" value={paper.pagerank === null ? "—" : Math.round(paper.pagerank * 100)} hint="of 100 in this graph" />
        </section>

        {loading ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {error ? (
              <p className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-xs">{error}</p>
            ) : null}

            {extraction ? (
              <section className="flex flex-col gap-4" aria-label="What the paper does">
                <Field label="Problem" text={extraction.problem} />
                <Field label="Method" text={extraction.method} />
                <Field label="Results" text={extraction.results} />
                <Field label="Contribution" text={extraction.contribution} />
                <Field label="Limitations" text={extraction.limitations} />
                {extraction.datasets.length > 0 || extraction.benchmarks.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Tags label="Datasets" items={extraction.datasets} />
                    <Tags label="Benchmarks" items={extraction.benchmarks} />
                  </div>
                ) : null}
                <p className="text-muted-foreground/80 text-[11px]">
                  Extracted from the {extraction.source === "fulltext" ? "full text" : "abstract"}.
                </p>
              </section>
            ) : (
              <Field label={detail?.abstract ? "Abstract" : "Summary"} text={detail?.abstract ?? paper.tldr} />
            )}

            {detail?.search?.relations && detail.search.relations.length > 0 ? (
              <Relations relations={detail.search.relations} clusters={clusters} onOpenPaper={onOpenPaper} />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Field({ label, text }: { label: string; text: string | null | undefined }) {
  if (!text || !text.trim()) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className={LABEL_CLASS}>{label}</h3>
      <p className="text-foreground/90 text-sm leading-6 whitespace-pre-line">{text}</p>
    </div>
  );
}

function Tags({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className={LABEL_CLASS}>{label}</h3>
      <div className="flex flex-wrap gap-1">
        {items.map((item, i) => (
          <Badge key={`${i}-${item}`} variant="outline" className="border-border/60 text-muted-foreground rounded-md px-1.5 text-[11px] font-normal">
            {item}
          </Badge>
        ))}
      </div>
    </div>
  );
}

const RELATION_GROUPS: { id: string; label: string; match: (r: PaperRelation) => boolean }[] = [
  { id: "builds-on", label: "Builds on", match: (r) => r.direction === "out" && r.kind !== "similar" },
  { id: "built-upon", label: "Built upon by", match: (r) => r.direction === "in" && r.kind !== "similar" },
  { id: "similar", label: "Similar", match: (r) => r.kind === "similar" },
];

const KIND_HINT: Record<EdgeKind, string> = { cites: "cites", builds_on: "builds on", similar: "similar" };

function Relations({
  relations,
  clusters,
  onOpenPaper,
}: {
  relations: PaperRelation[];
  clusters: ClusterDTO[];
  onOpenPaper: (paperId: string) => void;
}) {
  const seen = new Set<string>();
  return (
    <section className="flex flex-col gap-4" aria-label="In this landscape">
      {RELATION_GROUPS.map((group) => {
        const items = relations
          .filter(group.match)
          .filter((r) => {
            const key = `${group.id}:${r.paper.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => (a.paper.rank ?? 1e9) - (b.paper.rank ?? 1e9));
        if (items.length === 0) return null;
        return (
          <div key={group.id} className="flex flex-col gap-1.5">
            <h3 className={LABEL_CLASS}>
              {group.label} <span className="text-muted-foreground/70 tabular">{items.length}</span>
            </h3>
            <ul className="border-border/60 divide-border/60 flex flex-col divide-y overflow-hidden rounded-lg border">
              {items.map((r) => {
                const Arrow = r.direction === "out" ? ArrowUpRightIcon : ArrowDownLeftIcon;
                return (
                  <li key={r.paper.id}>
                    <button
                      type="button"
                      onClick={() => onOpenPaper(r.paper.id)}
                      className="hover:bg-muted/50 focus-visible:bg-muted/60 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors outline-none"
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: clusterColor(clusters, r.paper.clusterIdx) ?? "var(--border)" }}
                      />
                      <span className="text-foreground/90 min-w-0 flex-1 truncate text-[13px]">{r.paper.title}</span>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 font-mono text-[11px] tracking-tight tabular-nums">
                        {r.paper.year ?? ""}
                        <Arrow className={cn("size-3", r.kind === "similar" && "opacity-0")} aria-label={KIND_HINT[r.kind]} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
