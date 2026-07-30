import { RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";

import TabPill from "@src/components/TabPill";
import { journeyGraphQuery, type JourneyGraphPayload, type JourneyScope } from "@src/api/tauri/journeyGraph";

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

const journeyTabs = [
  { key: "storyline", label: "Storyline" },
  { key: "branches", label: "Branches" },
  { key: "files", label: "File Lineage" },
  { key: "coverage", label: "Coverage" },
];

function JourneyContent({ graph, activeTab }: { graph: JourneyGraphPayload; activeTab: JourneyTab }) {
  switch (activeTab) {
    case "branches": return <BranchesGraph viewModel={graphToBranchesViewModel(graph)} />;
    case "files": return <FileLineagePanel viewModel={graphToFileLineageViewModel(graph)} />;
    case "coverage": return <CoverageLedger viewModel={graphToCoverageLedgerViewModel(graph)} />;
    case "storyline": return <StorylineTimeline viewModel={graphToStorylineViewModel(graph)} />;
  }
}

/** The sole read-only query/container path for both project and session Journeys. */
export const JourneyContainer: React.FC<JourneyContainerProps> = ({ scope, title }) => {
  const [graph, setGraph] = useState<JourneyGraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<JourneyTab>("storyline");
  const reload = useCallback(async () => {
    setError(null);
    setGraph(null);
    try { setGraph(await journeyGraphQuery(scope)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [scope]);

  useEffect(() => { void reload(); }, [reload]);

  return <div className="flex h-full min-h-0 flex-col bg-bg-1" data-testid="journey-container">
    <header className="flex items-center gap-2 border-b border-border-2 px-3 py-2"><div className="min-w-0 flex-1 text-sm font-medium text-text-1">{title}</div><button type="button" aria-label="Refresh Journey" className="rounded-md border border-border-2 p-1 text-text-2 hover:bg-fill-2" onClick={() => void reload()}><RefreshCw size={14} /></button></header>
    <div className="border-b border-border-2 px-3 py-2"><TabPill tabs={journeyTabs} activeTab={activeTab} onChange={(tab) => setActiveTab(tab as JourneyTab)} variant="pill" size="mini" fillWidth={false} /></div>
    {error && <div className="p-3 text-xs text-warning-6" role="alert">Journey unavailable: {error}</div>}
    {!error && !graph && <div className="p-3 text-xs text-text-3">Loading Journey...</div>}
    {graph && <main className="min-h-0 flex-1 overflow-auto p-3"><JourneyContent graph={graph} activeTab={activeTab} /></main>}
  </div>;
};
