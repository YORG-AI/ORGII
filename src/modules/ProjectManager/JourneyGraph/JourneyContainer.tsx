import { RefreshCw } from "lucide-react";
import React, { useEffect, useState } from "react";

import {
  type JourneyGraphPayload,
  type JourneyScope,
  journeyGraphQuery,
} from "@src/api/tauri/journeyGraph";
import TabPill from "@src/components/TabPill";

import { BranchesGraph } from "./components/BranchesGraph";
import { CoverageLedger } from "./components/CoverageLedger";
import { FileLineagePanel } from "./components/FileLineagePanel";
import { StorylineTimeline } from "./components/StorylineTimeline";
import {
  graphToBranchesViewModel,
  graphToCoverageLedgerViewModel,
  graphToFileLineageViewModel,
  graphToStorylineViewModel,
} from "./viewModel";

type JourneyTab = "storyline" | "branches" | "files" | "coverage";

export interface JourneyContainerProps {
  scope: JourneyScope;
  title: string;
}

interface JourneyResult {
  scope: JourneyScope;
  graph: JourneyGraphPayload | null;
  error: string | null;
}

const journeyTabs = [
  { key: "storyline", label: "Storyline" },
  { key: "branches", label: "Branches" },
  { key: "files", label: "File Lineage" },
  { key: "coverage", label: "Coverage" },
];

function JourneyContent({
  graph,
  activeTab,
}: {
  graph: JourneyGraphPayload;
  activeTab: JourneyTab;
}) {
  switch (activeTab) {
    case "branches":
      return <BranchesGraph viewModel={graphToBranchesViewModel(graph)} />;
    case "files":
      return (
        <FileLineagePanel viewModel={graphToFileLineageViewModel(graph)} />
      );
    case "coverage":
      return (
        <CoverageLedger viewModel={graphToCoverageLedgerViewModel(graph)} />
      );
    case "storyline":
      return <StorylineTimeline viewModel={graphToStorylineViewModel(graph)} />;
  }
}

/** The sole read-only query/container path for both project and session Journeys. */
export const JourneyContainer: React.FC<JourneyContainerProps> = ({
  scope,
  title,
}) => {
  const [result, setResult] = useState<JourneyResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<JourneyTab>("storyline");

  useEffect(() => {
    let cancelled = false;
    void journeyGraphQuery(scope).then(
      (graph) => {
        if (!cancelled) setResult({ scope, graph, error: null });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setResult({
          scope,
          graph: null,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey, scope]);

  const currentResult = result?.scope === scope ? result : null;
  const graph = currentResult?.graph ?? null;
  const error = currentResult?.error ?? null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-1"
      data-testid="journey-container"
    >
      <header className="flex items-center gap-2 border-b border-border-2 px-3 py-2">
        <div className="min-w-0 flex-1 text-sm font-medium text-text-1">
          {title}
        </div>
        <button
          type="button"
          aria-label="Refresh Journey"
          className="rounded-md border border-border-2 p-1 text-text-2 hover:bg-fill-2"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      <div className="border-b border-border-2 px-3 py-2">
        <TabPill
          tabs={journeyTabs}
          activeTab={activeTab}
          onChange={(tab) => setActiveTab(tab as JourneyTab)}
          variant="pill"
          size="mini"
          fillWidth={false}
        />
      </div>
      {error && (
        <div className="p-3 text-xs text-warning-6" role="alert">
          Journey unavailable: {error}
        </div>
      )}
      {!error && !graph && (
        <div className="p-3 text-xs text-text-3">Loading Journey...</div>
      )}
      {graph && (
        <main className="min-h-0 flex-1 overflow-auto p-3">
          <JourneyContent graph={graph} activeTab={activeTab} />
        </main>
      )}
    </div>
  );
};
