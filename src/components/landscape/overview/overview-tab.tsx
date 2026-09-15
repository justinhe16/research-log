"use client";

import { useMemo } from "react";
import { SearchXIcon } from "lucide-react";

import type { DocumentKind, LandscapeSnapshot } from "@/lib/landscape/types";
import { StateMessage } from "../state-message";
import { ClusterCards } from "./cluster-cards";
import { ErasStrip } from "./eras-strip";
import { FrontierOutlook } from "./frontier";
import { GameChangers } from "./game-changers";
import { Section, SectionNotice, type PaperLookup } from "./primitives";
import { SummaryHero, WhatChanged } from "./summary-hero";
import { Gaps, Tensions } from "./tensions-gaps";

export type OverviewTabProps = {
  snapshot: LandscapeSnapshot;
  onOpenPaper: (paperId: string) => void;
};

const RETRY_HINT = "Use Retry synthesis at the top of the page to try again.";

/**
 * The top-down report: the field at a glance, what changed, how it evolved, the
 * papers that moved it, where it is now, its clusters, and what is contested or open.
 * Each section hides when its document is absent, and shows a quiet notice when
 * its synthesis failed (the page-level alert owns the retry action).
 */
export function OverviewTab({ snapshot, onOpenPaper }: OverviewTabProps) {
  const lookup = useMemo<PaperLookup>(
    () => ({ byId: new Map(snapshot.papers.map((p) => [p.id, p])), clusters: snapshot.clusters, onOpenPaper }),
    [snapshot.papers, snapshot.clusters, onOpenPaper],
  );
  const failed = (kind: DocumentKind) => snapshot.failedDocuments.includes(kind);
  const { narrative, tensions, gaps, clusters: clustersDoc } = snapshot.documents;

  if (snapshot.papers.length === 0) {
    return (
      <StateMessage
        icon={<SearchXIcon />}
        title="This search selected no papers"
        body="Try a broader topic name or a deeper search."
      />
    );
  }

  const eras = narrative?.eras ?? [];
  const hasGameChangers = narrative ? narrative.gameChangers.some((g) => lookup.byId.has(g.paperId)) : snapshot.papers.some((p) => p.gameChanger);
  const tensionList = tensions?.tensions.filter((t) => t.title.trim()) ?? [];
  const gapList = gaps?.gaps.filter((g) => g.title.trim()) ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-9 pt-1">
      <div className="flex flex-col gap-3">
        <SummaryHero snapshot={snapshot} />
        <WhatChanged snapshot={snapshot} lookup={lookup} />
      </div>

      {eras.length > 0 ? (
        <Section id="eras" title="How the field evolved" description="Each era and the papers it was built on, oldest first.">
          <ErasStrip eras={eras} lookup={lookup} />
        </Section>
      ) : failed("narrative") ? (
        <Section id="eras" title="How the field evolved">
          <SectionNotice title="Eras, game-changers and the frontier could not be written for this search.">{RETRY_HINT}</SectionNotice>
        </Section>
      ) : null}

      {hasGameChangers ? (
        <Section
          id="game-changers"
          title="Game-changers"
          description={narrative ? "Papers that shifted the field, and the numbers behind the call." : "Papers the ranking flagged as outsized influences."}
        >
          <GameChangers narrative={narrative} papers={snapshot.papers} lookup={lookup} />
        </Section>
      ) : null}

      {narrative ? (
        <Section id="frontier" title="Where it is now">
          <FrontierOutlook narrative={narrative} lookup={lookup} />
        </Section>
      ) : null}

      {snapshot.clusters.length > 0 || failed("clusters") ? (
        <Section
          id="clusters"
          title="Clusters"
          count={snapshot.clusters.length || undefined}
          description="Groups of papers that share methods and questions."
        >
          {failed("clusters") ? (
            <SectionNotice title={snapshot.clusters.length > 0 ? "Cluster summaries could not be written. Names below come from key terms." : "Cluster summaries could not be written for this search."}>{RETRY_HINT}</SectionNotice>
          ) : null}
          {snapshot.clusters.length > 0 ? <ClusterCards clusters={snapshot.clusters} doc={clustersDoc} lookup={lookup} /> : null}
        </Section>
      ) : null}

      {tensionList.length > 0 || failed("tensions") ? (
        <Section
          id="tensions"
          title="Tensions"
          count={tensionList.length || undefined}
          description="Where papers in this landscape disagree."
        >
          {tensionList.length > 0 ? (
            <Tensions tensions={tensionList} lookup={lookup} />
          ) : (
            <SectionNotice title="Tensions could not be written for this search.">{RETRY_HINT}</SectionNotice>
          )}
        </Section>
      ) : null}

      {gapList.length > 0 || failed("gaps") ? (
        <Section id="gaps" title="Open problems" count={gapList.length || undefined} description="Gaps the literature leaves open, and where to push.">
          {gapList.length > 0 ? (
            <Gaps gaps={gapList} lookup={lookup} />
          ) : (
            <SectionNotice title="Open problems could not be written for this search.">{RETRY_HINT}</SectionNotice>
          )}
        </Section>
      ) : null}
    </div>
  );
}
