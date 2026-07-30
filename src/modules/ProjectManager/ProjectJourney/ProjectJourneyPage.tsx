import { RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";

import { journeyGraphQuery, type JourneyScope } from "@src/api/tauri/journeyGraph";
import { graphToJourneyViewModel, type JourneyViewModel } from "@src/modules/ProjectManager/JourneyGraph/viewModel";

export interface ProjectJourneyPageProps { projectId?: string; projectSlug?: string; projectName?: string; forceDemo?: boolean; }

/** P1 factual view. Narrative controls and local inference belong to later phases. */
const ProjectJourneyPage: React.FC<ProjectJourneyPageProps> = ({ projectId, projectSlug, projectName }) => {
  const [view, setView] = useState<JourneyViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = projectId ? (`project/${projectId}` as JourneyScope) : projectSlug ? (`project/${projectSlug}` as JourneyScope) : null;
  const reload = useCallback(async () => {
    if (!scope) { setError("Project identity is required; refusing to guess a Journey graph."); setView(null); return; }
    setError(null);
    try { setView(graphToJourneyViewModel(await journeyGraphQuery(scope))); }
    catch (reason) { setView(null); setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [scope]);
  useEffect(() => { void reload(); }, [reload]);
  return <div className="flex h-full min-h-0 flex-col bg-bg-1" data-testid="project-journey-page">
    <div className="flex items-center gap-2 border-b border-border-2 px-3 py-2"><div className="min-w-0 flex-1 text-sm font-medium text-text-1">Project Journey{projectName ? ` · ${projectName}` : ""}</div><button type="button" aria-label="Refresh Journey" className="rounded-md border border-border-2 p-1 text-text-2 hover:bg-fill-2" onClick={() => void reload()}><RefreshCw size={14} /></button></div>
    {error && <div className="p-3 text-xs text-warning-6" role="alert">Journey unavailable: {error}</div>}
    {!error && !view && <div className="p-3 text-xs text-text-3">Loading Journey...</div>}
    {view && <div className="min-h-0 flex-1 overflow-auto p-3"><div className="mb-2 text-xs text-text-3">{view.nodes.length} canonical graph nodes</div><div className="flex flex-wrap gap-2">{view.nodes.map((node) => <div key={node.id} className="w-52 rounded-md border border-border-2 p-2 text-xs" data-testid="journey-node"><div className="font-medium text-text-1">{node.title}</div><div className="mt-1 text-text-3">{node.kind} · {node.evidenceClass}</div><div className="mt-1 truncate text-text-3" title={node.sourceRef}>{node.sourceRef}</div></div>)}</div></div>}
  </div>;
};
export default ProjectJourneyPage;
