/**
 * GitHistoryContent Component
 *
 * Displays git commit graph in the source control sidebar.
 * Each commit is clickable and opens a commit detail tab in the main pane.
 *
 * Graph mode renders a metro-style SVG lane visualization using parent_shas
 * to compute branch/merge topology.
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import { useActionSystem } from "@src/ActionSystem";
import { getGitCommits } from "@src/api/http/git/commits";
import type { GitCommitInfo } from "@src/api/http/git/types";
import { Placeholder } from "@src/components/Placeholder";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import {
  type UseWorkStationTabsReturn,
  useWorkStationTabs,
} from "@src/hooks/tabHost/useWorkStationTabs";
import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";
import { PRIMARY_SIDEBAR_HOVER } from "@src/modules/WorkStation/shared/tokens";
import {
  type GitHistoryRequest,
  getCachedGitHistory,
  loadGitHistory,
  writeGitHistoryCache,
} from "@src/services/git/gitHistoryResource";
import {
  SOURCE_CONTROL_CHANGES_TAB_ID,
  type SourceControlHistorySelection,
  createGitCommitDetailTab,
} from "@src/store/workstation/tabs";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import GitHistoryContextMenu from "./GitHistoryContextMenu";
import {
  type CommitGraphNode,
  DOT_RADIUS,
  LANE_WIDTH,
  assignLanesIncremental,
  createGraphState,
} from "./graphLayout";

// ============================================
// Constants
// ============================================

const COMMITS_PAGE_SIZE = 25;
const NOOP_REFRESH = () => undefined;

// ============================================
// Helpers
// ============================================

// ============================================
// Graph SVG Row Component
// ============================================

/** Row height must match the button's rendered height for lines to connect */
const ROW_HEIGHT = 36;

interface GraphSvgProps {
  graphNode: CommitGraphNode;
  svgWidth: number;
  isFirst: boolean;
}

const GraphSvg: React.FC<GraphSvgProps> = memo(
  ({ graphNode, svgWidth, isFirst }) => {
    const centerY = ROW_HEIGHT / 2;
    const dotX = graphNode.lane * LANE_WIDTH + LANE_WIDTH / 2;

    return (
      <svg width={svgWidth} height={ROW_HEIGHT} className="flex-shrink-0">
        {/* Lines */}
        {graphNode.lines.map((line, lineIdx) => {
          const fromX = line.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
          const toX = line.toLane * LANE_WIDTH + LANE_WIDTH / 2;

          // Skip top lines on the very first commit row (nothing above)
          if (
            isFirst &&
            line.segment === "top" &&
            line.fromLane === graphNode.lane &&
            line.toLane === graphNode.lane
          ) {
            return null;
          }

          if (line.segment === "top") {
            return (
              <line
                key={`line-${lineIdx}`}
                x1={fromX}
                y1={0}
                x2={toX}
                y2={centerY}
                stroke={line.color}
                strokeWidth={1.5}
              />
            );
          }
          return (
            <line
              key={`line-${lineIdx}`}
              x1={fromX}
              y1={centerY}
              x2={toX}
              y2={ROW_HEIGHT}
              stroke={line.color}
              strokeWidth={1.5}
            />
          );
        })}

        {/* Commit dot */}
        <circle cx={dotX} cy={centerY} r={DOT_RADIUS} fill={graphNode.color} />
      </svg>
    );
  }
);

GraphSvg.displayName = "GraphSvg";

// ============================================
// Commit Row Component
// ============================================

interface CommitRowProps {
  commit: GitCommitInfo;
  isSelected: boolean;
  graphNode?: CommitGraphNode;
  svgWidth?: number;
  isFirst?: boolean;
  onSelect: (commit: GitCommitInfo) => void;
  onContextMenu: (event: React.MouseEvent, commit: GitCommitInfo) => void;
}

const CommitRow: React.FC<CommitRowProps> = memo(
  ({
    commit,
    isSelected,
    graphNode,
    svgWidth,
    isFirst = false,
    onSelect,
    onContextMenu,
  }) => {
    const { cursorReset, markClicked, resetCursor } =
      useImmediateCursorReset(isSelected);

    const handleClick = useCallback(() => {
      markClicked();
      onSelect(commit);
    }, [commit, markClicked, onSelect]);

    const authorName = commit.author?.name ?? "Unknown";
    const authorDate = commit.author?.date ?? "";

    return (
      <button
        className={`group flex w-full items-center gap-1 pl-2 pr-3 text-left transition-colors ${
          cursorReset || isSelected ? "cursor-default" : "cursor-pointer"
        } ${isSelected ? SURFACE_TOKENS.selected : PRIMARY_SIDEBAR_HOVER.row}`}
        style={{ height: `${ROW_HEIGHT}px` }}
        onClick={handleClick}
        onContextMenu={(event) => onContextMenu(event, commit)}
        onMouseLeave={resetCursor}
        title={`${commit.summary}\n\n${commit.short_sha} by ${authorName}`}
      >
        {/* Graph SVG column — all rows use same width for text alignment */}
        {graphNode && svgWidth && (
          <GraphSvg
            graphNode={graphNode}
            svgWidth={svgWidth}
            isFirst={isFirst}
          />
        )}

        {/* Commit info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-text-1">
              {commit.summary}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-3">
            <span className="truncate">{authorName}</span>
            {authorDate && (
              <span className="flex-shrink-0">
                {formatRelativeTime(authorDate, "nano")}
              </span>
            )}
          </div>
        </div>
      </button>
    );
  }
);

CommitRow.displayName = "CommitRow";

// ============================================
// Main Component
// ============================================

export type GitHistoryViewMode = "list" | "graph";

export interface GitHistoryContentProps {
  repoPath: string;
  repoId: string;
  viewMode?: GitHistoryViewMode;
  /** Expose refresh callback to parent via ref-like pattern */
  onRefreshReady?: (refresh: () => void) => void;
  /** Receives the selected commit when the host wants inline detail rendering. */
  onHistorySelectionChange?: (selection: SourceControlHistorySelection) => void;
  /** Case-insensitive substring filter applied to commit messages */
  filterQuery?: string;
}

type GitHistoryTabsApi = Pick<
  UseWorkStationTabsReturn,
  "openTab" | "activeTab" | "updateTabData"
>;

type GitHistoryContentInnerProps = GitHistoryContentProps & GitHistoryTabsApi;

const GitHistoryContentInner: React.FC<GitHistoryContentInnerProps> = ({
  repoPath,
  repoId,
  viewMode = "graph",
  onRefreshReady,
  onHistorySelectionChange,
  filterQuery,
  openTab,
  activeTab,
  updateTabData,
}) => {
  const isGraphMode = viewMode === "graph";
  const { t } = useTranslation();
  const { dispatch } = useActionSystem();

  const activeHistorySelection =
    activeTab?.type === "source-control"
      ? ((activeTab.data.historySelection ??
          null) as SourceControlHistorySelection | null)
      : null;
  const activeCommitSha =
    activeTab?.type === "git-commit-detail"
      ? (activeTab.data.commitSha as string)
      : activeHistorySelection?.type === "commit"
        ? activeHistorySelection.commitSha
        : null;

  const historyRequest = useMemo<GitHistoryRequest>(
    () => ({
      limit: COMMITS_PAGE_SIZE,
      repoId,
      repoPath,
    }),
    [repoId, repoPath]
  );
  const initialHistory = useMemo(
    () => getCachedGitHistory(historyRequest),
    [historyRequest]
  );
  const [commits, setCommits] = useState<GitCommitInfo[]>(
    () => initialHistory?.commits ?? []
  );
  const [loading, setLoading] = useState(() => initialHistory === null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(
    () => initialHistory?.hasMore ?? false
  );
  const [error, setError] = useState<string | null>(null);
  const [contextMenuCommit, setContextMenuCommit] =
    useState<GitCommitInfo | null>(null);
  const loadGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const loadInitialCommits = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (!repoId) return;

      const requestId = ++loadGenerationRef.current;
      setLoading(true);
      setError(null);

      try {
        const result = await loadGitHistory(historyRequest, { force });

        if (requestId !== loadGenerationRef.current) return;

        setCommits(result.commits);
        setHasMore(result.hasMore);
      } catch (err) {
        if (requestId !== loadGenerationRef.current) return;

        setError(err instanceof Error ? err.message : "Failed to load commits");
      } finally {
        if (requestId === loadGenerationRef.current) {
          setLoading(false);
        }
      }
    },
    [historyRequest, repoId]
  );

  // Reset all component-owned history when the repository scope changes. The
  // generation also prevents a late request from repopulating a closed or
  // repurposed history view.
  useEffect(() => {
    loadGenerationRef.current += 1;
    loadingMoreRef.current = false;
    const cachedHistory = getCachedGitHistory(historyRequest);
    setCommits(cachedHistory?.commits ?? []);
    setHasMore(cachedHistory?.hasMore ?? false);
    setLoading(cachedHistory === null);
    setLoadingMore(false);
    setError(null);
    setContextMenuCommit(null);
    void loadInitialCommits();

    return () => {
      loadGenerationRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, [historyRequest, loadInitialCommits]);

  // Refresh in place: keep the last successful rows visible while revalidating.
  const handleRefresh = useCallback(() => {
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setError(null);
    void loadInitialCommits({ force: true });
  }, [loadInitialCommits]);

  // Register refresh callback with parent
  useEffect(() => {
    onRefreshReady?.(handleRefresh);
    return () => onRefreshReady?.(NOOP_REFRESH);
  }, [onRefreshReady, handleRefresh]);

  // Load more commits when the virtual list reaches its current end.
  const handleLoadMore = useCallback(async () => {
    if (!repoId || loadingMoreRef.current || !hasMore) return;

    const requestGeneration = loadGenerationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await getGitCommits({
        repo_id: repoId,
        repo_path: repoPath,
        limit: COMMITS_PAGE_SIZE,
        skip: commits.length,
      });

      if (requestGeneration !== loadGenerationRef.current) return;

      if (result?.commits) {
        const nextHasMore = result.commits.length >= COMMITS_PAGE_SIZE;
        setCommits((prev) => {
          const nextCommits = [...prev, ...result.commits];
          writeGitHistoryCache(historyRequest, {
            commits: nextCommits,
            hasMore: nextHasMore,
          });
          return nextCommits;
        });
        setHasMore(nextHasMore);
      } else {
        setHasMore(false);
      }
    } catch {
      if (requestGeneration !== loadGenerationRef.current) return;
      setHasMore(false);
    } finally {
      if (requestGeneration === loadGenerationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [repoId, repoPath, commits.length, hasMore, historyRequest]);

  const filteredCommits = useMemo(() => {
    if (!filterQuery) return commits;
    const lower = filterQuery.toLowerCase();
    return commits.filter((c) => c.summary.toLowerCase().includes(lower));
  }, [commits, filterQuery]);

  // The old visible sentinel continued paging when the loaded page had no
  // filter matches. Keep that behavior so a match in older history remains
  // discoverable even though there is no virtual row to reach yet.
  useEffect(() => {
    if (!filterQuery || filteredCommits.length > 0 || !hasMore) return;
    void handleLoadMore();
  }, [filterQuery, filteredCommits.length, handleLoadMore, hasMore]);

  // Compute graph layout — pure function, deterministic output for same input
  // When a filter is active we skip the graph (flat list only)
  const graphData = useMemo(() => {
    if (!isGraphMode || filteredCommits.length === 0 || filterQuery) {
      return { nodeMap: new Map<string, CommitGraphNode>(), maxLanes: 1 };
    }
    const state = createGraphState();
    assignLanesIncremental(state, filteredCommits);
    const nodeMap = new Map<string, CommitGraphNode>();
    let maxLanes = 1;
    for (const node of state.nodes) {
      nodeMap.set(node.commit.sha, node);
      if (node.activeLaneCount > maxLanes) maxLanes = node.activeLaneCount;
    }
    return { nodeMap, maxLanes };
  }, [filteredCommits, isGraphMode, filterQuery]);

  const graphSvgWidth = graphData.maxLanes * LANE_WIDTH;

  const openCommitInNewTab = useCallback(
    (commit: GitCommitInfo) => {
      const tab = createGitCommitDetailTab(
        commit.sha,
        commit.short_sha,
        commit.summary
      );
      openTab(tab);
    },
    [openTab]
  );

  const handleCommitSelect = useCallback(
    (commit: GitCommitInfo) => {
      const selection: SourceControlHistorySelection = {
        type: "commit",
        commitSha: commit.sha,
        shortSha: commit.short_sha,
        commitMessage: commit.summary,
      };

      if (onHistorySelectionChange) {
        onHistorySelectionChange(selection);
        return;
      }

      if (activeTab?.type === "source-control") {
        updateTabData(SOURCE_CONTROL_CHANGES_TAB_ID, {
          historySelection: selection,
        });
        return;
      }

      openCommitInNewTab(commit);
    },
    [
      activeTab?.type,
      onHistorySelectionChange,
      openCommitInNewTab,
      updateTabData,
    ]
  );

  const handleCommitContextMenu = useCallback(
    (event: React.MouseEvent, commit: GitCommitInfo) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenuCommit(commit);
    },
    []
  );

  // Loading state
  if (loading && commits.length === 0) {
    return (
      <Placeholder variant="loading" placement="sidebar" fillParentHeight />
    );
  }

  // Error state
  if (error && commits.length === 0) {
    return (
      <Placeholder
        variant="error"
        title={t("placeholders.failedToLoadHistory")}
        subtitle={error}
      />
    );
  }

  // Empty state
  if (commits.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={t("placeholders.noCommitHistory")}
        fillParentHeight
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {filteredCommits.length === 0 && filterQuery ? (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("placeholders.noResults", "No results")}
          fillParentHeight
        />
      ) : (
        <Virtuoso
          className="min-h-0 flex-1 scrollbar-hide"
          data={filteredCommits}
          computeItemKey={(_index, commit) => commit.sha}
          fixedItemHeight={ROW_HEIGHT}
          overscan={ROW_HEIGHT * 8}
          endReached={() => {
            void handleLoadMore();
          }}
          itemContent={(index, commit) => (
            <CommitRow
              commit={commit}
              isSelected={commit.sha === activeCommitSha}
              graphNode={
                isGraphMode && !filterQuery
                  ? graphData.nodeMap.get(commit.sha)
                  : undefined
              }
              svgWidth={graphSvgWidth}
              isFirst={index === 0}
              onSelect={handleCommitSelect}
              onContextMenu={handleCommitContextMenu}
            />
          )}
        />
      )}

      {/* Loading indicator remains outside the virtual window. */}
      {hasMore && (
        <div className="flex h-8 shrink-0 items-center justify-center">
          {loadingMore && (
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={SPINNER_TOKENS.default}
              className="animate-spin text-text-3"
            />
          )}
        </div>
      )}

      {contextMenuCommit && (
        <GitHistoryContextMenu
          commit={contextMenuCommit}
          repoId={repoId}
          repoPath={repoPath}
          isHeadCommit={commits[0]?.sha === contextMenuCommit.sha}
          dispatch={dispatch}
          onOpenInNewTab={openCommitInNewTab}
          onActionComplete={handleRefresh}
          onClose={() => setContextMenuCommit(null)}
        />
      )}
    </div>
  );
};

const GitHistoryContent: React.FC<GitHistoryContentProps> = (props) => {
  const { openTab, activeTab, updateTabData } = useWorkStationTabs();
  return (
    <GitHistoryContentInner
      {...props}
      openTab={openTab}
      activeTab={activeTab}
      updateTabData={updateTabData}
    />
  );
};

export default memo(GitHistoryContent);
