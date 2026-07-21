import { CheckCircle2, CircleDot, GitPullRequest } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import type { SelectOption } from "@src/components/Select";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import {
  GitHubWorkItemListFrame,
  GitHubWorkItemPagination,
  GitHubWorkItemSummary,
} from "./GitHubWorkItemList";
import { ManagedIssueRow, ManagedPrRow } from "./GitHubWorkItemRows";
import {
  GITHUB_ITEM_KIND,
  type ManagedGitHubItem,
  type ManagedIssueItem,
  type ManagedPrItem,
} from "./githubManagedItemModel";
import {
  GITHUB_QUERY_SCOPE,
  GITHUB_QUERY_STATE,
  type GitHubQueryScope,
  type GitHubQueryState,
} from "./githubWorkItemsSearchQuery";

interface VirtualRow {
  index: number;
  start: number;
}

interface GitHubWorkItemsListViewProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  loading: boolean;
  loadingMore: boolean;
  loadError: string | null;
  repoSourceCount: number;
  allItemCount: number;
  filteredItemCount: number;
  pagedItems: ManagedGitHubItem[];
  virtualRows: VirtualRow[];
  virtualHeight: number;
  measureRow: (element: HTMLDivElement | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  queryState: GitHubQueryState | null;
  issueStateCounts: { open: number; closed: number };
  openIssuesLoaded: boolean;
  closedIssuesLoaded: boolean;
  openPrCount: number;
  closedPrCount: number;
  openPrLoaded: boolean;
  closedPrLoaded: boolean;
  issuePersonalFilterOptions: SelectOption[];
  selectedIssuePersonalFilters: string[];
  currentPage: number;
  totalLoadedPages: number;
  hasMoreRemoteItems: boolean;
  canGoNext: boolean;
  onQueryStateChange: (state: GitHubQueryState) => void;
  onIssuePersonalFiltersSelect: (values: (string | number)[]) => void;
  onRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onOpenIssue: (issue: ManagedIssueItem) => void;
  onOpenIssueInBrowser: (issue: ManagedIssueItem) => void;
  onOpenIssueInMyStation: (issue: ManagedIssueItem) => void;
  onAddIssue: (issue: ManagedIssueItem) => void;
  onOpenPr: (pr: ManagedPrItem) => void;
  onAddPr: (pr: ManagedPrItem) => void;
}

export function GitHubWorkItemsListView({
  scope,
  loading,
  loadingMore,
  loadError,
  repoSourceCount,
  allItemCount,
  filteredItemCount,
  pagedItems,
  virtualRows,
  virtualHeight,
  measureRow,
  scrollRef,
  queryState,
  issueStateCounts,
  openIssuesLoaded,
  closedIssuesLoaded,
  openPrCount,
  closedPrCount,
  openPrLoaded,
  closedPrLoaded,
  issuePersonalFilterOptions,
  selectedIssuePersonalFilters,
  currentPage,
  totalLoadedPages,
  hasMoreRemoteItems,
  canGoNext,
  onQueryStateChange,
  onIssuePersonalFiltersSelect,
  onRefresh,
  onPreviousPage,
  onNextPage,
  onOpenIssue,
  onOpenIssueInBrowser,
  onOpenIssueInMyStation,
  onAddIssue,
  onOpenPr,
  onAddPr,
}: GitHubWorkItemsListViewProps) {
  const { t } = useTranslation(["sessions", "common"]);

  let content;
  if (scope !== GITHUB_QUERY_SCOPE.PR && loading && filteredItemCount === 0) {
    content = (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
      />
    );
  } else if (loadError && allItemCount === 0) {
    content = (
      <Placeholder
        variant="error"
        subtitle={loadError}
        action={{ label: t("common:actions.retry"), onClick: onRefresh }}
        fillParentHeight
      />
    );
  } else if (!loading && repoSourceCount === 0) {
    content = <Placeholder variant="empty" fillParentHeight />;
  } else if (
    scope !== GITHUB_QUERY_SCOPE.PR &&
    !loading &&
    filteredItemCount === 0
  ) {
    content = <Placeholder variant="no-results" fillParentHeight />;
  } else {
    const issueScope = scope === GITHUB_QUERY_SCOPE.ISSUE;
    const summary = (
      <GitHubWorkItemSummary
        tabs={[
          {
            key: GITHUB_QUERY_STATE.OPEN,
            label: t("chat.panels.manageIssues.stateOpen"),
            count: issueScope
              ? openIssuesLoaded
                ? issueStateCounts.open
                : null
              : openPrLoaded
                ? openPrCount
                : null,
            icon: issueScope ? (
              <CircleDot size={13} strokeWidth={1.8} />
            ) : (
              <GitPullRequest size={13} strokeWidth={1.8} />
            ),
            active: issueScope
              ? queryState === GITHUB_QUERY_STATE.OPEN
              : queryState === null || queryState === GITHUB_QUERY_STATE.OPEN,
            onSelect: () => onQueryStateChange(GITHUB_QUERY_STATE.OPEN),
          },
          {
            key: GITHUB_QUERY_STATE.CLOSED,
            label: t("chat.panels.manageIssues.stateClosed"),
            count: issueScope
              ? closedIssuesLoaded
                ? issueStateCounts.closed
                : null
              : closedPrLoaded
                ? closedPrCount
                : null,
            icon: <CheckCircle2 size={13} strokeWidth={1.8} />,
            active: issueScope
              ? queryState === GITHUB_QUERY_STATE.CLOSED
              : queryState === GITHUB_QUERY_STATE.CLOSED ||
                queryState === GITHUB_QUERY_STATE.MERGED,
            onSelect: () => onQueryStateChange(GITHUB_QUERY_STATE.CLOSED),
          },
        ]}
        actions={
          issueScope ? (
            <Dropdown
              options={issuePersonalFilterOptions}
              value={selectedIssuePersonalFilters}
              mode="multiple"
              position="bottom-end"
              onSelect={(value) =>
                onIssuePersonalFiltersSelect(
                  Array.isArray(value) ? value : [value]
                )
              }
            >
              <Button
                htmlType="button"
                variant="secondary"
                appearance="outline"
                size="small"
              >
                {t("common:actions.filter")}
                {selectedIssuePersonalFilters.length > 0
                  ? ` (${selectedIssuePersonalFilters.length})`
                  : ""}
              </Button>
            </Dropdown>
          ) : undefined
        }
      />
    );

    content = (
      <GitHubWorkItemListFrame
        summary={summary}
        height={
          scope === GITHUB_QUERY_SCOPE.PR && filteredItemCount === 0
            ? 180
            : virtualHeight
        }
      >
        {scope === GITHUB_QUERY_SCOPE.PR && filteredItemCount === 0 ? (
          <Placeholder
            variant={loading ? "loading" : loadError ? "error" : "no-results"}
            subtitle={loadError ?? undefined}
            action={
              loadError
                ? { label: t("common:actions.retry"), onClick: onRefresh }
                : undefined
            }
            fillParentHeight
          />
        ) : (
          virtualRows.map((virtualRow) => {
            const item = pagedItems[virtualRow.index];
            return (
              <div
                key={`${item.kind}-${item.repo}-${item.id}`}
                ref={measureRow}
                data-index={virtualRow.index}
                className={`absolute left-0 top-0 w-full ${
                  virtualRow.index < pagedItems.length - 1
                    ? "border-b border-border-2"
                    : ""
                }`}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {item.kind === GITHUB_ITEM_KIND.ISSUE ? (
                  <ManagedIssueRow
                    issue={item}
                    addLabel={t("chat.panels.manageIssues.addToChat")}
                    openInBrowserLabel={t("common:previews.openInBrowser")}
                    openInMyStationLabel={t("layout.sidebar.openInMyStation")}
                    moreActionsLabel={t("common:actions.moreActions")}
                    onOpenIssue={onOpenIssue}
                    onOpenIssueInBrowser={onOpenIssueInBrowser}
                    onOpenIssueInMyStation={onOpenIssueInMyStation}
                    onAddIssue={onAddIssue}
                  />
                ) : (
                  <ManagedPrRow
                    pr={item}
                    addLabel={t("chat.panels.manageIssues.addToChat")}
                    onOpenPr={onOpenPr}
                    onAddPr={onAddPr}
                  />
                )}
              </div>
            );
          })
        )}
      </GitHubWorkItemListFrame>
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-hide"
      >
        {content}
      </div>
      {filteredItemCount > 0 ? (
        <GitHubWorkItemPagination
          totalLabel={t("common:pagination.pageOf", {
            current: currentPage,
            total: hasMoreRemoteItems
              ? `${totalLoadedPages}+`
              : totalLoadedPages,
          })}
          previousLabel={t("common:actions.previous")}
          nextLabel={t("common:actions.next")}
          loadingNext={loadingMore}
          canGoPrevious={currentPage > 1}
          canGoNext={canGoNext}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
        />
      ) : null}
    </>
  );
}
