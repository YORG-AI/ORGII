/**
 * IssuesContent
 *
 * GitHub Issues panel for the workstation primary sidebar.
 * Interaction patterns aligned with SourceControlContent:
 * - Generic localized filter input
 * - Refresh and filter controls in the regular section header actions
 * - The outer CollapsibleSection header ("ISSUES") is provided by the sidebar module
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSetAtom } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import type { GitHubIssue } from "@src/api/tauri/github";
import { buildIntegrationsPath } from "@src/config/mainAppPaths/integrations";
import { SectionFilterInput } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/SectionFilterInput";
import {
  type SectionStatus,
  SectionStatusRow,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/SectionStatusRow";
import { TreeSectionHeader } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/TreeSectionHeader";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { workstationIssueCallbackAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";

import { useWorkstationIssues } from "../../hooks/useWorkstationIssues";
import { IssueRow } from "./IssueRow";
import { NewIssueForm } from "./NewIssueForm";

type IssueVirtualRow =
  | { kind: "header"; section: "open" | "closed" }
  | { kind: "status"; section: "open" | "closed"; status: SectionStatus }
  | { kind: "issue"; issue: GitHubIssue }
  | { kind: "loadMore"; section: "open" | "closed" };

export interface IssuesContentProps {
  repoPath: string;
  repoId?: string;
  branchName?: string;
  remoteUrl?: string;
  onOpenNewIssueForm?: () => void;
  /** Whether the filter input row is currently open */
  showFilter?: boolean;
  /** Active filter query (synced with external useSectionFilter) */
  filterQuery?: string;
  /** Called when filter query changes */
  onFilterQueryChange?: (q: string) => void;
  /** Called when the filter input should close (Escape pressed) */
  onFilterClose?: () => void;
}

const IssuesContent: React.FC<IssuesContentProps> = memo(
  ({
    repoPath,
    repoId,
    branchName,
    remoteUrl,
    showFilter = false,
    filterQuery = "",
    onFilterQueryChange,
    onFilterClose,
  }) => {
    const { t } = useTranslation("common");
    const navigate = useNavigate();
    const scopeKey = workstationRepoScopeKey(repoId, repoPath);
    const setCallbackAtom = useSetAtom(
      workstationIssueCallbackAtomFamily(scopeKey)
    );

    const {
      openIssues,
      closedIssues,
      openLoadState,
      closedLoadState,
      openError,
      closedError,
      fetchClosed,
      openHasMore,
      closedHasMore,
      openLoadingMore,
      closedLoadingMore,
      loadMoreOpen,
      loadMoreClosed,
      remoteUrlLoading,
      needsReAuth,
      error,
      setSearchQuery,
      selectIssue,
      handleCreateIssue,
      handleCloseIssue,
      handleReopenIssue,
      handleAddComment,
      refresh,
      repoLabels,
      collaborators,
    } = useWorkstationIssues({ repoPath, repoId, branchName, remoteUrl });

    const [showNewIssueForm, setShowNewIssueForm] = useState(false);
    const [creatingIssue, setCreatingIssue] = useState(false);
    const [openCollapsed, setOpenCollapsed] = useState(false);
    // Closed section: collapsed by default; first expand triggers fetch
    const [closedCollapsed, setClosedCollapsed] = useState(true);
    const listRef = useRef<HTMLDivElement>(null);

    // Keep internal debounced search in sync with the externally controlled query
    useEffect(() => {
      setSearchQuery(filterQuery);
    }, [filterQuery, setSearchQuery]);

    const handleOpenNewIssueForm = useCallback(() => {
      setShowNewIssueForm(true);
    }, []);

    const handleCancelNewIssue = useCallback(() => {
      setShowNewIssueForm(false);
    }, []);

    const handleSubmitNewIssue = useCallback(
      async (
        title: string,
        body: string,
        labels: string[],
        assignees: string[]
      ) => {
        setCreatingIssue(true);
        try {
          const created = await handleCreateIssue(
            title,
            body || undefined,
            labels,
            assignees
          );
          if (created) {
            setShowNewIssueForm(false);
            selectIssue(created);
          }
        } finally {
          setCreatingIssue(false);
        }
      },
      [handleCreateIssue, selectIssue]
    );

    // Register callbacks so PinnedActionsBar, agents, and the github-issue-detail
    // tab renderer can trigger issue actions without coupling to this component.
    useEffect(() => {
      setCallbackAtom({
        openNewIssueForm: handleOpenNewIssueForm,
        closeIssue: handleCloseIssue,
        reopenIssue: handleReopenIssue,
        addComment: (number, body) => handleAddComment(number, body),
        refreshIssues: refresh,
      });
      return () => {
        setCallbackAtom({
          openNewIssueForm: null,
          closeIssue: null,
          reopenIssue: null,
          addComment: null,
          refreshIssues: null,
        });
      };
    }, [
      setCallbackAtom,
      handleOpenNewIssueForm,
      handleCloseIssue,
      handleReopenIssue,
      handleAddComment,
      refresh,
    ]);

    const isOpenLoading =
      remoteUrlLoading ||
      (openLoadState === "loading" && openIssues.length === 0);

    const handleToggleClosed = useCallback(() => {
      setClosedCollapsed((prev) => {
        const nowExpanded = prev; // true → expanding
        if (nowExpanded && closedLoadState === "idle") {
          void fetchClosed();
        }
        return !prev;
      });
    }, [closedLoadState, fetchClosed]);

    const handleOpenIssue = useCallback(
      (issue: GitHubIssue) => {
        selectIssue(issue);
      },
      [selectIssue]
    );

    const failedToLoad = t("git.issues.failedToLoad", "Failed to load");
    const loadingLabel = t("actions.loading", "Loading…");
    const noIssuesLabel = t("labels.noIssues", "No issues");

    const openStatus = useMemo<SectionStatus | null>(() => {
      if (isOpenLoading) return { kind: "loading", message: loadingLabel };
      if (openLoadState === "error") {
        return { kind: "error", message: openError ?? failedToLoad };
      }
      if (openIssues.length === 0)
        return { kind: "empty", message: noIssuesLabel };
      return null;
    }, [
      failedToLoad,
      isOpenLoading,
      loadingLabel,
      noIssuesLabel,
      openError,
      openIssues.length,
      openLoadState,
    ]);

    const closedStatus = useMemo<SectionStatus | null>(() => {
      if (closedLoadState === "loading") {
        return { kind: "loading", message: loadingLabel };
      }
      if (closedLoadState === "error") {
        return { kind: "error", message: closedError ?? failedToLoad };
      }
      if (closedLoadState === "ready" && closedIssues.length === 0) {
        return { kind: "empty", message: noIssuesLabel };
      }
      return null;
    }, [
      closedError,
      closedIssues.length,
      closedLoadState,
      failedToLoad,
      loadingLabel,
      noIssuesLabel,
    ]);

    const virtualRows = useMemo<IssueVirtualRow[]>(() => {
      const rows: IssueVirtualRow[] = [{ kind: "header", section: "open" }];
      if (!openCollapsed) {
        if (openStatus) {
          rows.push({ kind: "status", section: "open", status: openStatus });
        } else {
          rows.push(
            ...openIssues.map((issue) => ({ kind: "issue" as const, issue }))
          );
          if (openHasMore) rows.push({ kind: "loadMore", section: "open" });
        }
      }

      rows.push({ kind: "header", section: "closed" });
      if (!closedCollapsed) {
        if (closedStatus) {
          rows.push({
            kind: "status",
            section: "closed",
            status: closedStatus,
          });
        } else {
          rows.push(
            ...closedIssues.map((issue) => ({ kind: "issue" as const, issue }))
          );
          if (closedHasMore) rows.push({ kind: "loadMore", section: "closed" });
        }
      }
      return rows;
    }, [
      closedCollapsed,
      closedHasMore,
      closedIssues,
      closedStatus,
      openCollapsed,
      openHasMore,
      openIssues,
      openStatus,
    ]);

    // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
    const issueListVirtualizer = useVirtualizer({
      count: virtualRows.length,
      getScrollElement: () => listRef.current,
      estimateSize: (index) =>
        virtualRows[index]?.kind === "loadMore" ||
        virtualRows[index]?.kind === "status"
          ? 36
          : 24,
      overscan: 10,
    });
    const virtualItems = issueListVirtualizer.getVirtualItems();

    // ── Render ────────────────────────────────────────────────────────────────

    let listContent: React.ReactNode;

    // When the Open section is the sidebar's only content (Closed collapsed,
    // Open expanded with no rows), surface its loading/empty state as a centered
    // Explorer-style Placeholder that fills the pane. Section headers and the
    // inline SectionStatusRow are still used once Closed is expanded or Open has
    // rows, so each section keeps its own structured state.
    const openWholePane =
      !openCollapsed && closedCollapsed && openIssues.length === 0;

    if (needsReAuth) {
      listContent = (
        <Placeholder
          variant="error"
          placement="sidebar"
          title={t(
            "git.issues.reAuthRequired",
            "GitHub Authorization Required"
          )}
          subtitle={t(
            "git.issues.reAuthDescription",
            "Your GitHub token has expired. Go to Settings → Connections to reconnect."
          )}
          action={{
            label: t("git.issues.goToSettings", "Go to Settings"),
            onClick: () =>
              navigate(buildIntegrationsPath({ category: "connections" })),
          }}
          fillParentHeight
        />
      );
    } else if (error) {
      listContent = (
        <Placeholder
          variant="error"
          placement="sidebar"
          title={t("git.issues.failedToLoad", "Failed to load issues")}
          subtitle={error}
          action={{ label: t("actions.retry", "Retry"), onClick: refresh }}
          fillParentHeight
        />
      );
    } else if (openWholePane && openStatus && openStatus.kind !== "error") {
      listContent = (
        <div className="flex flex-1 flex-col overflow-hidden">
          <TreeSectionHeader
            id="open-issues"
            title="Open"
            collapsed={openCollapsed}
            count={openIssues.length}
            onToggle={() => setOpenCollapsed((prev) => !prev)}
          />
          <Placeholder
            variant={openStatus.kind === "loading" ? "loading" : "empty"}
            placement="sidebar"
            title={
              openStatus.kind === "loading" ? undefined : openStatus.message
            }
            fillParentHeight
          />
          <TreeSectionHeader
            id="closed-issues"
            title="Closed"
            collapsed={closedCollapsed}
            count={closedLoadState === "ready" ? closedIssues.length : null}
            onToggle={handleToggleClosed}
          />
        </div>
      );
    } else {
      const renderVirtualRow = (row: IssueVirtualRow): React.ReactNode => {
        switch (row.kind) {
          case "header":
            return row.section === "open" ? (
              <TreeSectionHeader
                id="open-issues"
                title="Open"
                collapsed={openCollapsed}
                count={openIssues.length}
                onToggle={() => setOpenCollapsed((prev) => !prev)}
              />
            ) : (
              <TreeSectionHeader
                id="closed-issues"
                title="Closed"
                collapsed={closedCollapsed}
                count={closedLoadState === "ready" ? closedIssues.length : null}
                onToggle={handleToggleClosed}
              />
            );
          case "status":
            return <SectionStatusRow status={row.status} />;
          case "issue":
            return (
              <IssueRow
                issue={row.issue}
                depth={1}
                isSelected={false}
                onClick={() => handleOpenIssue(row.issue)}
              />
            );
          case "loadMore": {
            const isOpenSection = row.section === "open";
            const isLoading = isOpenSection
              ? openLoadingMore
              : closedLoadingMore;
            return (
              <div className="flex justify-center py-1.5">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] font-medium text-text-2 transition-colors hover:bg-fill-1 disabled:cursor-default disabled:opacity-60"
                  disabled={isLoading}
                  onClick={isOpenSection ? loadMoreOpen : loadMoreClosed}
                >
                  {isLoading
                    ? t("actions.loading", "Loading…")
                    : t("actions.loadMore", "Load more")}
                </button>
              </div>
            );
          }
        }
      };

      listContent = (
        <div ref={listRef} className="flex flex-1 overflow-y-auto">
          <div
            className="relative w-full"
            style={{ height: issueListVirtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualItem) => {
              const row = virtualRows[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  ref={issueListVirtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderVirtualRow(row)}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {showFilter && (
          <SectionFilterInput
            query={filterQuery}
            onChange={(q) => onFilterQueryChange?.(q)}
            onClose={() => onFilterClose?.()}
          />
        )}

        {showNewIssueForm && (
          <NewIssueForm
            onSubmit={handleSubmitNewIssue}
            onCancel={handleCancelNewIssue}
            repoLabels={repoLabels}
            collaborators={collaborators}
            loading={creatingIssue}
          />
        )}

        {listContent}
      </div>
    );
  }
);

IssuesContent.displayName = "IssuesContent";

export default IssuesContent;
