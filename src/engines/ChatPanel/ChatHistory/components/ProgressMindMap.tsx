import { ChevronDown, ChevronUp, GitFork, RefreshCw } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";
import type { Session } from "@src/store/session";

import {
  type ProgressMindMapNode,
  buildProgressMindMap,
} from "../progressMindMap";

interface ProgressMindMapProps {
  sessionId: string;
  childSessions: readonly Session[];
  reloadKey: string;
  onJumpToTurn: (turnIndex: number) => void;
}

const COMPACT_LIMIT = 18;

const ProgressMindMap: React.FC<ProgressMindMapProps> = ({
  sessionId,
  childSessions,
  reloadKey,
  onJumpToTurn,
}) => {
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
    });
    loadTurnIndex(sessionId)
      .then((next) => {
        if (!cancelled) setTurns(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setTurns([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey, refreshNonce]);

  const graph = useMemo(
    () =>
      buildProgressMindMap(
        turns,
        childSessions,
        expanded ? Number.MAX_SAFE_INTEGER : COMPACT_LIMIT
      ),
    [childSessions, expanded, turns]
  );
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;

  const activate = (node: ProgressMindMapNode) => {
    setSelectedId(node.id);
    if (node.turnIndex != null) onJumpToTurn(node.turnIndex);
  };

  return (
    <section
      className="mx-auto w-full max-w-[980px] px-2 pb-2"
      data-testid="progress-mind-map"
    >
      <div className="overflow-hidden rounded-xl border border-border-2 bg-fill-1/70 shadow-sm">
        <div className="flex min-h-9 items-center justify-between gap-2 px-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => setOpen((value) => !value)}
          >
            <GitFork size={14} className="text-primary-6" />
            <span className="truncate text-xs font-medium text-text-1">
              Progress mind map
            </span>
            <span className="rounded-full bg-fill-3 px-1.5 py-0.5 text-[10px] text-text-2">
              {graph.totalTurns} steps
            </span>
            {open ? (
              <ChevronUp size={13} className="text-text-3" />
            ) : (
              <ChevronDown size={13} className="text-text-3" />
            )}
          </button>
          <button
            type="button"
            aria-label="Refresh progress mind map"
            title="Refresh"
            className="rounded p-1 text-text-3 hover:bg-fill-2 hover:text-text-1"
            onClick={() => setRefreshNonce((value) => value + 1)}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        {open && (
          <div className="border-t border-border-2 px-3 py-3">
            {loading ? (
              <div className="py-4 text-center text-xs text-text-3">
                Loading persisted turn data…
              </div>
            ) : error ? (
              <div className="py-4 text-center text-xs text-danger-6">
                Unable to load progress: {error}
              </div>
            ) : graph.nodes.length === 0 ? (
              <div className="py-4 text-center text-xs text-text-3">
                No persisted turns yet. Refresh after the first round completes.
              </div>
            ) : (
              <>
                <div className="overflow-x-auto pb-2">
                  <div
                    className="flex min-w-max items-start gap-0"
                    role="list"
                    aria-label="Session progress"
                  >
                    {graph.nodes
                      .filter((node) => node.kind !== "fork")
                      .map((node, index) => (
                        <React.Fragment key={node.id}>
                          {index > 0 && (
                            <div
                              className="mt-5 h-px w-7 bg-border-3"
                              aria-hidden="true"
                            />
                          )}
                          <MindMapNode
                            node={node}
                            selected={selectedId === node.id}
                            onClick={() => activate(node)}
                          />
                        </React.Fragment>
                      ))}
                  </div>
                  {graph.nodes.some((node) => node.kind === "fork") && (
                    <div className="ml-auto mt-3 flex w-fit max-w-full flex-wrap items-start gap-2 border-l border-dashed border-primary-4 pl-4">
                      {graph.nodes
                        .filter((node) => node.kind === "fork")
                        .map((node) => (
                          <MindMapNode
                            key={node.id}
                            node={node}
                            selected={selectedId === node.id}
                            onClick={() => activate(node)}
                          />
                        ))}
                    </div>
                  )}
                </div>
                {graph.hiddenTurns > 0 && (
                  <button
                    type="button"
                    className="mt-1 text-[11px] text-primary-6 hover:underline"
                    onClick={() => setExpanded(true)}
                  >
                    Show all {graph.totalTurns} steps
                  </button>
                )}
                {expanded && graph.totalTurns > COMPACT_LIMIT && (
                  <button
                    type="button"
                    className="mt-1 text-[11px] text-primary-6 hover:underline"
                    onClick={() => setExpanded(false)}
                  >
                    Collapse older steps
                  </button>
                )}
                {selected && (
                  <div className="mt-2 rounded-lg bg-fill-2 px-3 py-2 text-[11px] text-text-2">
                    <div className="font-medium text-text-1">
                      {selected.label}
                    </div>
                    <div>
                      {selected.detail} · status: {selected.status}
                    </div>
                    {selected.files.length > 0 && (
                      <div
                        className="mt-1 truncate"
                        title={selected.files
                          .map((file) => file.path)
                          .join("\n")}
                      >
                        Files:{" "}
                        {selected.files.map((file) => file.path).join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

const MindMapNode: React.FC<{
  node: ProgressMindMapNode;
  selected: boolean;
  onClick: () => void;
}> = ({ node, selected, onClick }) => {
  const active = [
    "running",
    "pending",
    "in_progress",
    "waiting_for_user",
  ].includes(node.status);
  const failed = ["failed", "error", "cancelled", "interrupted"].includes(
    node.status
  );
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      disabled={node.kind === "aggregate"}
      title={node.label}
      className={`w-36 rounded-lg border px-2.5 py-2 text-left transition-colors ${selected ? "border-primary-5 bg-primary-1" : "border-border-2 bg-bg-1 hover:border-primary-3 hover:bg-fill-2"} ${node.kind === "aggregate" ? "cursor-default opacity-70" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 flex-shrink-0 rounded-full ${failed ? "bg-danger-5" : active ? "animate-pulse bg-primary-5" : "bg-success-5"}`}
        />
        <span className="truncate text-[11px] font-medium text-text-1">
          {node.label}
        </span>
      </div>
      <div className="mt-1 truncate text-[10px] text-text-3">{node.detail}</div>
    </button>
  );
};

export default ProgressMindMap;
