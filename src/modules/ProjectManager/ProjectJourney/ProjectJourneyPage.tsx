import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitFork,
  Pin,
  PinOff,
  RefreshCw,
  Scissors,
  Sparkles,
} from "lucide-react";

import {
  type JourneyFileCategory,
  type JourneyNode,
  type ProjectJourneyGraph,
  type ProjectJourneyState,
  type ProjectLike,
  type WorkItemLike,
  buildProjectJourneyGraph,
  emptyJourneyState,
  filterFiles,
  loadJourneyState,
  nodesTouchedByFile,
  saveJourneyState,
  togglePinNode,
  togglePruneNode,
  DEMO_PROJECT,
  DEMO_WORK_ITEMS,
} from "./model";
import { loadProjectTreeBundle } from "./loadProjectTree";

export interface ProjectJourneyPageProps {
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
  forceDemo?: boolean;
}

type FileFilter = "all" | JourneyFileCategory;

const statusColor: Record<string, string> = {
  todo: "border-border-2 bg-fill-2",
  doing: "border-primary-5 bg-primary-1",
  done: "border-success-5 bg-success-1",
  abandoned: "border-danger-5 bg-danger-1 opacity-70",
};

const ProjectJourneyPage: React.FC<ProjectJourneyPageProps> = ({
  projectId,
  projectSlug,
  projectName,
  forceDemo,
}) => {
  const [graph, setGraph] = useState<ProjectJourneyGraph | null>(null);
  const [state, setState] = useState<ProjectJourneyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usedDemo, setUsedDemo] = useState(false);
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workItems, setWorkItems] = useState<WorkItemLike[]>([]);
  const [project, setProject] = useState<ProjectLike | null>(null);

  const rebuild = useCallback(
    (proj: ProjectLike, items: WorkItemLike[], st: ProjectJourneyState) => {
      const next = buildProjectJourneyGraph({
        project: proj,
        workItems: items,
        state: st,
      });
      setGraph(next);
      setState(st);
    },
    []
  );

  const reload = useCallback(
    async (demo = false) => {
      setLoading(true);
      setError(null);
      try {
        if (demo || forceDemo) {
          const st = loadJourneyState(DEMO_PROJECT.id);
          setProject(DEMO_PROJECT);
          setWorkItems(DEMO_WORK_ITEMS);
          setUsedDemo(true);
          rebuild(DEMO_PROJECT, DEMO_WORK_ITEMS, st);
          return;
        }
        const bundle = await loadProjectTreeBundle({ forceDemo: false });
        setUsedDemo(bundle.usedDemo);
        const projects = bundle.projects;
        const match =
          projects.find((p) => p.id === projectId) ||
          projects.find((p) => p.slug === projectSlug) ||
          projects.find((p) => p.id === DEMO_PROJECT.id) ||
          projects[0] ||
          DEMO_PROJECT;
        const items =
          bundle.workItemsByProject[match.id] ||
          bundle.workItemsByProject[match.slug ?? ""] ||
          (match.id === DEMO_PROJECT.id ? DEMO_WORK_ITEMS : []);
        const st = loadJourneyState(match.id);
        setProject(match);
        setWorkItems(items);
        rebuild(match, items, st);
        if (bundle.error) setError(bundle.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        const st = loadJourneyState(DEMO_PROJECT.id);
        setProject(DEMO_PROJECT);
        setWorkItems(DEMO_WORK_ITEMS);
        setUsedDemo(true);
        rebuild(DEMO_PROJECT, DEMO_WORK_ITEMS, st);
      } finally {
        setLoading(false);
      }
    },
    [forceDemo, projectId, projectSlug, rebuild]
  );

  useEffect(() => {
    void reload(Boolean(forceDemo));
  }, [forceDemo, reload]);

  const highlighted = useMemo(() => {
    if (!graph || !selectedFile) return new Set<string>();
    return new Set(nodesTouchedByFile(graph, selectedFile));
  }, [graph, selectedFile]);

  const files = useMemo(
    () => (graph ? filterFiles(graph, fileFilter) : []),
    [fileFilter, graph]
  );

  const mainline = graph?.nodes.filter(
    (n) => n.kind === "work_item" && n.isMainline && !n.pruned
  );
  const branches = graph?.nodes.filter(
    (n) => (n.kind === "session" || n.kind === "fork") && !n.pruned
  );
  const pruned = graph?.nodes.filter((n) => n.pruned);

  const onPin = (nodeId: string) => {
    if (!state || !project) return;
    const next = togglePinNode(state, nodeId);
    rebuild(project, workItems, next);
  };

  const onPrune = (nodeId: string) => {
    if (!state || !project) return;
    const next = togglePruneNode(state, nodeId);
    rebuild(project, workItems, next);
  };

  const selectedNode: JourneyNode | null =
    graph?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-1"
      data-testid="project-journey-page"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border-2 px-3 py-2">
        <GitFork size={16} className="text-primary-6" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-1">
            Project Journey
            {project || projectName
              ? ` · ${project?.name ?? projectName}`
              : ""}
          </div>
          <div className="text-[11px] text-text-3">
            Mainline pin + work-product suggestions · file blink · soft prune
            {usedDemo ? " · demo" : ""}
          </div>
        </div>
        {graph && (
          <div className="rounded-full bg-fill-3 px-2 py-0.5 text-[11px] text-text-2">
            mainline {Math.round(graph.mainlineProgress * 100)}% · sess{" "}
            {graph.stats.sessionCount} · files {graph.files.length} · redundant{" "}
            {graph.stats.redundantNodeCount}
          </div>
        )}
        <button
          type="button"
          className="rounded-md border border-border-2 px-2 py-1 text-xs text-text-2 hover:bg-fill-2"
          onClick={() => void reload(false)}
        >
          <RefreshCw size={12} className="inline" /> Refresh
        </button>
        <button
          type="button"
          className="rounded-md border border-border-2 px-2 py-1 text-xs text-text-2 hover:bg-fill-2"
          onClick={() => void reload(true)}
        >
          Demo
        </button>
      </div>

      {error && (
        <div className="px-3 py-1 text-xs text-warning-6">Warning: {error}</div>
      )}
      {loading && (
        <div className="p-4 text-xs text-text-3">Loading journey…</div>
      )}

      {!loading && graph && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[1fr_280px]">
          <div className="min-h-0 overflow-auto border-r border-border-2 p-3">
            <section className="mb-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text-2">
                <Sparkles size={12} /> Mainline
              </div>
              <div className="flex flex-wrap gap-2">
                {(mainline ?? []).map((node, idx) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    index={idx}
                    selected={selectedNodeId === node.id}
                    highlighted={highlighted.has(node.id)}
                    onSelect={() => setSelectedNodeId(node.id)}
                    onPin={() => onPin(node.id)}
                    onPrune={() => onPrune(node.id)}
                  />
                ))}
                {(mainline?.length ?? 0) === 0 && (
                  <div className="text-xs text-text-3">
                    No mainline yet — pin a work item or add work products.
                  </div>
                )}
              </div>
            </section>

            <section className="mb-4">
              <div className="mb-2 text-xs font-medium text-text-2">
                Branches / Sessions
              </div>
              <div className="flex flex-wrap gap-2">
                {(branches ?? []).map((node) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    selected={selectedNodeId === node.id}
                    highlighted={highlighted.has(node.id)}
                    onSelect={() => setSelectedNodeId(node.id)}
                    onPin={() => onPin(node.id)}
                    onPrune={() => onPrune(node.id)}
                  />
                ))}
              </div>
            </section>

            {(pruned?.length ?? 0) > 0 && (
              <section>
                <div className="mb-2 text-xs font-medium text-text-3">
                  Pruned (archived edges)
                </div>
                <div className="flex flex-wrap gap-2 opacity-60">
                  {pruned!.map((node) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      selected={selectedNodeId === node.id}
                      highlighted={false}
                      onSelect={() => setSelectedNodeId(node.id)}
                      onPin={() => onPin(node.id)}
                      onPrune={() => onPrune(node.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {selectedNode && (
              <div className="mt-4 rounded-lg border border-border-2 bg-fill-1 p-3 text-xs">
                <div className="font-medium text-text-1">{selectedNode.title}</div>
                <div className="mt-1 text-text-3">{selectedNode.summary}</div>
                <div className="mt-2 text-text-2">
                  sessions: {selectedNode.sessionIds.join(", ") || "—"}
                </div>
                <div className="mt-1 text-text-2">
                  files: {selectedNode.resultFileRefs.length}
                </div>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="border-b border-border-2 px-3 py-2">
              <div className="mb-2 text-xs font-medium text-text-2">
                Result files
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    "all",
                    "produced",
                    "touched_production",
                    "other",
                  ] as FileFilter[]
                ).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                      fileFilter === key
                        ? "bg-primary-6 text-white"
                        : "bg-fill-3 text-text-2"
                    }`}
                    onClick={() => setFileFilter(key)}
                    data-testid={`journey-file-filter-${key}`}
                  >
                    {key === "touched_production" ? "production" : key}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {files.map((f) => {
                const active = selectedFile === f.path;
                return (
                  <button
                    key={f.path}
                    type="button"
                    className={`mb-1 w-full rounded-md border px-2 py-1.5 text-left text-[11px] ${
                      active
                        ? "border-primary-6 bg-primary-1 animate-pulse"
                        : "border-border-2 bg-fill-1 hover:bg-fill-2"
                    }`}
                    onClick={() =>
                      setSelectedFile((prev) =>
                        prev === f.path ? null : f.path
                      )
                    }
                    data-testid="journey-file-row"
                    data-file-path={f.path}
                  >
                    <div className="truncate font-medium text-text-1">
                      {f.path.split("/").pop()}
                    </div>
                    <div className="truncate text-text-3">{f.path}</div>
                    <div className="mt-0.5 text-text-3">
                      {f.category} · {f.sessionIds.length} session(s)
                    </div>
                  </button>
                );
              })}
              {files.length === 0 && (
                <div className="p-2 text-xs text-text-3">No files in filter</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function NodeCard({
  node,
  index,
  selected,
  highlighted,
  onSelect,
  onPin,
  onPrune,
}: {
  node: JourneyNode;
  index?: number;
  selected: boolean;
  highlighted: boolean;
  onSelect: () => void;
  onPin: () => void;
  onPrune: () => void;
}) {
  return (
    <div
      className={`w-[220px] rounded-xl border p-2 shadow-sm transition ${
        statusColor[node.status] ?? statusColor.todo
      } ${selected ? "ring-2 ring-primary-6" : ""} ${
        highlighted ? "animate-pulse ring-2 ring-warning-6" : ""
      } ${node.pruned ? "opacity-50" : ""}`}
      data-testid="journey-node"
      data-node-id={node.id}
      data-highlighted={highlighted ? "1" : "0"}
    >
      <button type="button" className="w-full text-left" onClick={onSelect}>
        <div className="flex items-center gap-1 text-[11px] text-text-3">
          <span className="uppercase">{node.kind}</span>
          {typeof index === "number" && <span>#{index + 1}</span>}
          {node.suggestedMainline && !node.isMainline && (
            <span className="rounded bg-fill-3 px-1">suggested</span>
          )}
          {node.isMainline && (
            <span className="rounded bg-primary-6 px-1 text-white">main</span>
          )}
          {node.redundancyScore > 0 && (
            <span className="rounded bg-warning-6 px-1 text-white">
              redun {node.redundancyScore}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs font-medium text-text-1">
          {node.title}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[11px] text-text-3">
          {node.summary}
        </div>
      </button>
      <div className="mt-2 flex gap-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border-2 px-1.5 py-0.5 text-[10px] text-text-2 hover:bg-fill-2"
          onClick={onPin}
          title="Pin/unpin mainline"
        >
          {node.isMainline ? <PinOff size={10} /> : <Pin size={10} />}
          pin
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border-2 px-1.5 py-0.5 text-[10px] text-text-2 hover:bg-fill-2"
          onClick={onPrune}
          title="Soft prune / restore"
        >
          <Scissors size={10} />
          {node.pruned ? "restore" : "prune"}
        </button>
      </div>
    </div>
  );
}

// silence unused import if tree shaker complains in some builds
void saveJourneyState;
void emptyJourneyState;

export default ProjectJourneyPage;
