import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderTree,
  GitBranch,
  ListTodo,
  RefreshCw,
  Box,
  CircleDot,
} from "lucide-react";

import type { ProjectTreeNode } from "./model";
import { loadProjectTreeBundle } from "./loadProjectTree";

export interface ProjectTreePageProps {
  onOpenJourney?: (projectId: string, projectSlug?: string, projectName?: string) => void;
  onOpenWorkItem?: (workItemId: string, projectSlug?: string) => void;
  publishToWorkstationHeader?: boolean;
}

function kindIcon(kind: ProjectTreeNode["kind"]) {
  switch (kind) {
    case "workspace":
      return <FolderTree size={14} className="text-primary-6" />;
    case "project":
      return <Box size={14} className="text-primary-6" />;
    case "work_item":
      return <CircleDot size={14} className="text-text-2" />;
    case "todo":
      return <ListTodo size={14} className="text-text-3" />;
    case "session":
      return <GitBranch size={14} className="text-success-6" />;
    case "unassigned":
      return <FolderTree size={14} className="text-warning-6" />;
    default:
      return null;
  }
}

const ProjectTreePage: React.FC<ProjectTreePageProps> = ({
  onOpenJourney,
  onOpenWorkItem,
}) => {
  const [root, setRoot] = useState<ProjectTreeNode | null>(null);
  const [usedDemo, setUsedDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "workspace:root": true,
  });
  const [filter, setFilter] = useState("");

  const reload = useCallback(async (forceDemo = false) => {
    setLoading(true);
    setError(null);
    try {
      const bundle = await loadProjectTreeBundle({ forceDemo });
      setRoot(bundle.tree);
      setUsedDemo(bundle.usedDemo);
      setError(bundle.error ?? null);
      setExpanded((prev) => ({
        ...prev,
        "workspace:root": true,
        ...Object.fromEntries(
          (bundle.tree.children ?? []).map((c) => [c.id, true])
        ),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(false);
  }, [reload]);

  const rows = useMemo(() => {
    if (!root) return [] as Array<{ node: ProjectTreeNode; depth: number }>;
    const out: Array<{ node: ProjectTreeNode; depth: number }> = [];
    const q = filter.trim().toLowerCase();
    const walk = (node: ProjectTreeNode, depth: number) => {
      const selfMatch =
        !q ||
        node.title.toLowerCase().includes(q) ||
        node.kind.includes(q) ||
        node.status?.toLowerCase().includes(q);
      const childRows: Array<{ node: ProjectTreeNode; depth: number }> = [];
      if (expanded[node.id] || q) {
        for (const child of node.children) {
          // when filtering, auto-include matching descendants
          const before = childRows.length;
          walkCollect(child, depth + 1, childRows, q);
          if (childRows.length === before && q) {
            // no match in subtree
          }
        }
      }
      if (selfMatch || childRows.length > 0 || !q) {
        out.push({ node, depth });
        out.push(...childRows);
      }
    };
    const walkCollect = (
      node: ProjectTreeNode,
      depth: number,
      acc: Array<{ node: ProjectTreeNode; depth: number }>,
      query: string
    ) => {
      const selfMatch =
        !query ||
        node.title.toLowerCase().includes(query) ||
        node.kind.includes(query) ||
        node.status?.toLowerCase().includes(query);
      const childAcc: Array<{ node: ProjectTreeNode; depth: number }> = [];
      const open = expanded[node.id] || Boolean(query);
      if (open) {
        for (const child of node.children) {
          walkCollect(child, depth + 1, childAcc, query);
        }
      }
      if (selfMatch || childAcc.length > 0) {
        acc.push({ node, depth });
        acc.push(...childAcc);
      }
    };
    walk(root, 0);
    return out;
  }, [expanded, filter, root]);

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-1"
      data-testid="project-tree-page"
    >
      <div className="flex items-center gap-2 border-b border-border-2 px-3 py-2">
        <FolderTree size={16} className="text-primary-6" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-1">Project Tree</div>
          <div className="text-[11px] text-text-3">
            Workspace → Project → Work Item → Session / Task
            {usedDemo ? " · demo data" : ""}
          </div>
        </div>
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
          Load demo
        </button>
      </div>

      <div className="border-b border-border-2 px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter nodes…"
          className="w-full rounded-md border border-border-2 bg-fill-1 px-2 py-1.5 text-xs text-text-1 outline-none focus:border-primary-6"
          data-testid="project-tree-filter"
        />
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-warning-6">
          Load warning: {error} (showing available/demo data)
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {loading && (
          <div className="p-4 text-xs text-text-3">Loading tree…</div>
        )}
        {!loading &&
          rows.map(({ node, depth }) => {
            const hasChildren = node.children.length > 0;
            const open = expanded[node.id];
            return (
              <div
                key={node.id}
                className="group flex items-center gap-1 rounded-md px-1 py-1 text-xs hover:bg-fill-2"
                style={{ paddingLeft: 8 + depth * 14 }}
                data-testid={`project-tree-row-${node.kind}`}
                data-node-id={node.id}
              >
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center text-text-3"
                  onClick={() => hasChildren && toggle(node.id)}
                  aria-label={open ? "collapse" : "expand"}
                >
                  {hasChildren ? (
                    open ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )
                  ) : (
                    <span className="inline-block w-[13px]" />
                  )}
                </button>
                {kindIcon(node.kind)}
                <span className="min-w-0 flex-1 truncate text-text-1">
                  {node.title}
                </span>
                {node.status && (
                  <span className="rounded bg-fill-3 px-1.5 py-0.5 text-[10px] text-text-3">
                    {node.status}
                  </span>
                )}
                {node.kind === "project" && onOpenJourney && (
                  <button
                    type="button"
                    className="hidden rounded border border-border-2 px-1.5 py-0.5 text-[10px] text-primary-6 group-hover:inline"
                    onClick={() =>
                      onOpenJourney(
                        node.projectId ?? "",
                        node.projectSlug,
                        node.title
                      )
                    }
                  >
                    Journey
                  </button>
                )}
                {node.kind === "work_item" && onOpenWorkItem && (
                  <button
                    type="button"
                    className="hidden rounded border border-border-2 px-1.5 py-0.5 text-[10px] text-text-2 group-hover:inline"
                    onClick={() =>
                      onOpenWorkItem(node.workItemId ?? "", node.projectSlug)
                    }
                  >
                    Open
                  </button>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default ProjectTreePage;
