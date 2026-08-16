import { RefreshCw } from "lucide-react";
import React, { useEffect, useState } from "react";

import {
  type JourneyScope,
  journeyGraphQuery,
} from "@src/api/tauri/journeyGraph";
import {
  type JourneyViewModel,
  graphToJourneyViewModel,
} from "@src/modules/ProjectManager/JourneyGraph/viewModel";

export interface ProjectJourneyPageProps {
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
  forceDemo?: boolean;
}

interface JourneyResult {
  scope: JourneyScope;
  view: JourneyViewModel | null;
  error: string | null;
}

/** P1 factual view. Narrative controls and local inference belong to later phases. */
const ProjectJourneyPage: React.FC<ProjectJourneyPageProps> = ({
  projectId,
  projectSlug,
  projectName,
}) => {
  const [result, setResult] = useState<JourneyResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const scope = projectId
    ? (`project/${projectId}` as JourneyScope)
    : projectSlug
      ? (`project/${projectSlug}` as JourneyScope)
      : null;

  useEffect(() => {
    if (!scope) return;

    let cancelled = false;
    void journeyGraphQuery(scope).then(
      (graph) => {
        if (cancelled) return;
        setResult({
          scope,
          view: graphToJourneyViewModel(graph),
          error: null,
        });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setResult({
          scope,
          view: null,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [refreshKey, scope]);

  const currentResult = result?.scope === scope ? result : null;
  const error = scope
    ? (currentResult?.error ?? null)
    : "Project identity is required; refusing to guess a Journey graph.";
  const view = currentResult?.view ?? null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-1"
      data-testid="project-journey-page"
    >
      <div className="flex items-center gap-2 border-b border-border-2 px-3 py-2">
        <div className="min-w-0 flex-1 text-sm font-medium text-text-1">
          Project Journey{projectName ? ` · ${projectName}` : ""}
        </div>
        <button
          type="button"
          aria-label="Refresh Journey"
          className="rounded-md border border-border-2 p-1 text-text-2 hover:bg-fill-2"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <div className="p-3 text-xs text-warning-6" role="alert">
          Journey unavailable: {error}
        </div>
      )}
      {!error && !view && (
        <div className="p-3 text-xs text-text-3">Loading Journey...</div>
      )}
      {view && (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-2 text-xs text-text-3">
            {view.nodes.length} canonical graph nodes
          </div>
          <div className="flex flex-wrap gap-2">
            {view.nodes.map((node) => (
              <div
                key={node.id}
                className="w-52 rounded-md border border-border-2 p-2 text-xs"
                data-testid="journey-node"
              >
                <div className="font-medium text-text-1">{node.title}</div>
                <div className="mt-1 text-text-3">
                  {node.kind} · {node.evidenceClass}
                </div>
                <div
                  className="mt-1 truncate text-text-3"
                  title={node.sourceRef}
                >
                  {node.sourceRef}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectJourneyPage;
