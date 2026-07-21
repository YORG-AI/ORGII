import { useVirtualizer } from "@tanstack/react-virtual";
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import {
  IssueDetailHeaderContent,
  IssueDetailPanel,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import { DetailPanelContainer } from "@src/modules/shared/layouts/blocks";
import { reposAtom, selectedRepoPathAtom } from "@src/store/repo";

import { CreateIssueModal } from "./CreateIssueModal";
import { GitHubWorkItemToolbarActions } from "./GitHubWorkItemList";
import { GitHubWorkItemsListView } from "./GitHubWorkItemsListView";
import { canAdvanceGitHubWorkItemsPage } from "./githubWorkItemsPagination";
import {
  GITHUB_QUERY_SCOPE,
  type GitHubQueryScope,
} from "./githubWorkItemsSearchQuery";
import { useGitHubIssueDetail } from "./useGitHubIssueDetail";
import { useGitHubIssueMutations } from "./useGitHubIssueMutations";
import { useGitHubWorkItemActions } from "./useGitHubWorkItemActions";
import { useGitHubWorkItemsDerivedState } from "./useGitHubWorkItemsDerivedState";
import { useGitHubWorkItemsLoadLifecycle } from "./useGitHubWorkItemsLoadLifecycle";
import {
  GITHUB_FILTER_PRESET,
  ISSUE_REPO_FILTER,
  useGitHubWorkItemsViewState,
} from "./useGitHubWorkItemsViewState";

interface RepoFilterOption {
  key: string;
  label: string;
}

function RepoFilterPill({
  options,
  selectedRepo,
  allReposLabel,
  onSelectRepo,
}: {
  options: RepoFilterOption[];
  selectedRepo: string;
  allReposLabel: string;
  onSelectRepo: (repo: string) => void;
}): React.ReactNode {
  const selectOptions = useMemo<SelectOption[]>(
    () =>
      options.map((option) => ({
        value: option.key,
        label: option.label,
        triggerLabel: option.label,
      })),
    [options]
  );

  return (
    <Select
      value={selectedRepo}
      options={selectOptions}
      placeholder={allReposLabel}
      size="small"
      showSearch
      variant="default"
      radius="lg"
      dropdownWidthMode="match"
      className="min-w-[190px] max-w-[260px]"
      selectorClassName="h-7"
      onChange={(value) => onSelectRepo(String(value))}
    />
  );
}

interface GitHubWorkItemsSurfaceProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  onDetailViewChange: (open: boolean, onBack: (() => void) | null) => void;
}

const GitHubWorkItemsSurface: React.FC<GitHubWorkItemsSurfaceProps> = ({
  scope,
  onDetailViewChange,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const repos = useAtomValue(reposAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const {
    openIssueInBrowser,
    openIssueInMyStation,
    addIssue,
    addCreatedIssue,
    addPr,
    openPr,
  } = useGitHubWorkItemActions();
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const {
    detail: issueDetail,
    closeDetail,
    openDetail,
    closeCurrentIssue,
    reopenCurrentIssue,
    addComment: addIssueDetailComment,
  } = useGitHubIssueDetail({
    onDetailViewChange,
  });
  const {
    selectedRepo,
    refreshNonce,
    currentPage,
    setCurrentPage,
    searchQuery,
    parsedSearchQuery,
    selectedIssueListStates,
    selectedPrListStates,
    selectedPersonalFilters: selectedIssuePersonalFilters,
    updateSearchQuery,
    changeSearchQuery: handleSearchQueryChange,
    selectRepo: handleRepoSelect,
    selectPersonalFilters: handleIssuePersonalFiltersSelect,
    refresh: handleRefresh,
  } = useGitHubWorkItemsViewState({
    scope,
    onScopeChange: closeDetail,
  });
  const {
    repoSources,
    repoIssueMap,
    repoPrMap,
    loading,
    loadError,
    updateIssueMap,
    setListError,
  } = useGitHubWorkItemsLoadLifecycle({
    repos,
    scope,
    issueStates: selectedIssueListStates,
    prStates: selectedPrListStates,
    refreshNonce,
  });

  const deferredParsedSearchQuery = useDeferredValue(parsedSearchQuery);

  const {
    selectedRepoSourceForCreate,
    effectiveSelectedRepo,
    allItems,
    filteredItems,
    pageStates,
    paginatedSources,
    hasMoreFilteredIssues,
    totalLoadedPages,
    pagedItems,
    issueStateCounts,
    openIssuesLoaded,
    closedIssuesLoaded,
    openPrCount,
    closedPrCount,
    openPrLoaded,
    closedPrLoaded,
  } = useGitHubWorkItemsDerivedState({
    repoSources,
    repoIssueMap,
    repoPrMap,
    parsedSearchQuery: deferredParsedSearchQuery,
    selectedRepo,
    selectedRepoPath,
    currentPage,
    allReposValue: ISSUE_REPO_FILTER.ALL,
    currentWorkstationValue: ISSUE_REPO_FILTER.CURRENT_WORKSTATION,
  });

  const issuePersonalFilterOptions = useMemo<SelectOption[]>(
    () =>
      scope === GITHUB_QUERY_SCOPE.ISSUE
        ? [
            {
              value: GITHUB_FILTER_PRESET.BY_ME,
              label: t("chat.panels.manageIssues.createdByMe"),
            },
            {
              value: GITHUB_FILTER_PRESET.ASSIGNED_TO_ME,
              label: t("chat.panels.manageIssues.assignedToMe"),
            },
          ]
        : [],
    [scope, t]
  );

  const repoOptions = useMemo<RepoFilterOption[]>(
    () => [
      {
        key: ISSUE_REPO_FILTER.ALL,
        label: t("chat.manageIssues.allRepositories"),
      },
      ...repoSources.map((source) => ({
        key: source.repoFullName,
        label: source.repoFullName,
      })),
    ],
    [repoSources, t]
  );

  useEffect(() => {
    if (!loading && currentPage > totalLoadedPages) {
      setCurrentPage(totalLoadedPages);
    }
  }, [currentPage, loading, setCurrentPage, totalLoadedPages]);

  const listScrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const itemVirtualizer = useVirtualizer({
    count: pagedItems.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => (scope === GITHUB_QUERY_SCOPE.ISSUE ? 72 : 82),
    overscan: 8,
  });
  const virtualItems = itemVirtualizer.getVirtualItems();

  const handleBackToIssueList = closeDetail;

  const surfaceTitle =
    scope === GITHUB_QUERY_SCOPE.PR
      ? t("sessions:kanban.sidebar.githubPrs")
      : t("sessions:kanban.sidebar.githubIssues");

  const headerContent = useMemo(
    () => (
      <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text-1">
        {issueDetail ? (
          <IssueDetailHeaderContent issue={issueDetail.issue} />
        ) : (
          surfaceTitle
        )}
      </span>
    ),
    [issueDetail, surfaceTitle]
  );

  const {
    loadingMore,
    creatingIssue,
    loadMore: handleLoadMore,
    createIssue: handleCreateIssue,
  } = useGitHubIssueMutations({
    repoIssueMap,
    paginatedSources,
    pageStates,
    hasMoreFilteredIssues,
    updateIssueMap,
    setListError,
    addCreatedIssue,
    onCreated: () => setCreateFormOpen(false),
    createErrorMessage: t("chat.panels.manageIssues.createIssueFailed"),
  });

  const handlePreviousPage = useCallback(() => {
    setCurrentPage((page) => Math.max(1, page - 1));
    listScrollRef.current?.scrollTo({ top: 0 });
  }, [setCurrentPage]);

  const handleNextPage = useCallback(async () => {
    if (currentPage < totalLoadedPages) {
      setCurrentPage((page) => page + 1);
      listScrollRef.current?.scrollTo({ top: 0 });
      return;
    }
    if (!hasMoreFilteredIssues || loadingMore) return;

    await handleLoadMore();
    setCurrentPage((page) => page + 1);
    listScrollRef.current?.scrollTo({ top: 0 });
  }, [
    currentPage,
    handleLoadMore,
    hasMoreFilteredIssues,
    loadingMore,
    setCurrentPage,
    totalLoadedPages,
  ]);

  const handleOpenIssue = openDetail;
  const handleOpenIssueInBrowser = openIssueInBrowser;
  const handleOpenIssueInMyStation = openIssueInMyStation;

  const handleCloseIssueDetail = closeCurrentIssue;
  const handleReopenIssueDetail = reopenCurrentIssue;
  const handleAddIssueDetailComment = addIssueDetailComment;
  const handleAddIssue = addIssue;
  const handleAddPr = addPr;
  const handleOpenPr = openPr;

  const headerContribution = useMemo(
    () => ({ content: headerContent }),
    [headerContent]
  );

  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: headerContribution,
  });

  const listContent = (
    <GitHubWorkItemsListView
      scope={scope}
      loading={loading}
      loadingMore={loadingMore}
      loadError={loadError}
      repoSourceCount={repoSources.length}
      allItemCount={allItems.length}
      filteredItemCount={filteredItems.length}
      pagedItems={pagedItems}
      virtualRows={virtualItems}
      virtualHeight={itemVirtualizer.getTotalSize()}
      measureRow={itemVirtualizer.measureElement}
      scrollRef={listScrollRef}
      queryState={parsedSearchQuery.state}
      issueStateCounts={issueStateCounts}
      openIssuesLoaded={openIssuesLoaded}
      closedIssuesLoaded={closedIssuesLoaded}
      openPrCount={openPrCount}
      closedPrCount={closedPrCount}
      openPrLoaded={openPrLoaded}
      closedPrLoaded={closedPrLoaded}
      issuePersonalFilterOptions={issuePersonalFilterOptions}
      selectedIssuePersonalFilters={selectedIssuePersonalFilters}
      currentPage={currentPage}
      totalLoadedPages={totalLoadedPages}
      hasMoreRemoteItems={hasMoreFilteredIssues}
      canGoNext={canAdvanceGitHubWorkItemsPage({
        currentPage,
        loadedPageCount: totalLoadedPages,
        hasMoreRemoteItems: hasMoreFilteredIssues,
      })}
      onQueryStateChange={(state) =>
        updateSearchQuery((query) => {
          query.state = state;
        })
      }
      onIssuePersonalFiltersSelect={handleIssuePersonalFiltersSelect}
      onRefresh={handleRefresh}
      onPreviousPage={handlePreviousPage}
      onNextPage={() => void handleNextPage()}
      onOpenIssue={handleOpenIssue}
      onOpenIssueInBrowser={handleOpenIssueInBrowser}
      onOpenIssueInMyStation={handleOpenIssueInMyStation}
      onAddIssue={handleAddIssue}
      onOpenPr={handleOpenPr}
      onAddPr={handleAddPr}
    />
  );

  const issueDetailContent = issueDetail ? (
    <IssueDetailPanel
      issue={issueDetail.issue}
      comments={issueDetail.comments}
      commentsLoading={issueDetail.commentsLoading}
      submittingComment={issueDetail.submittingComment}
      showHeader={false}
      contentPadding="default"
      onClose={handleBackToIssueList}
      onCloseIssue={handleCloseIssueDetail}
      onReopenIssue={handleReopenIssueDetail}
      onAddComment={handleAddIssueDetailComment}
    />
  ) : null;

  const listDescriptionContent = (
    <section
      className="flex min-h-0 flex-1"
      data-testid={`work-management-github-${scope}`}
    >
      <CreateIssueModal
        open={createFormOpen}
        repoSources={repoSources}
        selectedRepo={selectedRepoSourceForCreate}
        creating={creatingIssue}
        labels={{
          title: t("chat.panels.manageIssues.newIssueTitle"),
          issueTitlePlaceholder: t(
            "chat.panels.manageIssues.issueTitlePlaceholder"
          ),
          issueBodyPlaceholder: t(
            "chat.panels.manageIssues.issueBodyPlaceholder"
          ),
          repository: t("chat.panels.manageIssues.repositoryLabel"),
          cancel: t("common:actions.cancel"),
          create: t("chat.panels.manageIssues.createIssue"),
          creating: t("chat.panels.manageIssues.creatingIssue"),
        }}
        onCreateIssue={handleCreateIssue}
        onCancel={() => setCreateFormOpen(false)}
      />
      <div className="bg-bg-0 flex min-w-0 flex-1 flex-col">
        {issueDetailContent ?? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-2 px-3">
              <RepoFilterPill
                options={repoOptions}
                selectedRepo={effectiveSelectedRepo}
                allReposLabel={t("chat.manageIssues.allRepositories")}
                onSelectRepo={handleRepoSelect}
              />
              <SearchInput
                value={searchQuery}
                onChange={handleSearchQueryChange}
                placeholder={t("chat.panels.manageIssues.searchPlaceholder")}
                variant="panel"
                surface="pane"
                hideChevron
                showClearButton
                inputBoxClassName="flex-1"
                className="min-w-0 flex-1"
              />
              <GitHubWorkItemToolbarActions
                openHref={
                  selectedRepoSourceForCreate
                    ? `https://github.com/${selectedRepoSourceForCreate.repoFullName}`
                    : null
                }
                openLabel={t("chat.panels.manageIssues.openInGitHub")}
                refreshLabel={t("common:actions.refresh")}
                refreshing={loading}
                createAction={
                  scope === GITHUB_QUERY_SCOPE.ISSUE
                    ? {
                        label: t("chat.panels.manageIssues.createIssueTrigger"),
                        disabled: repoSources.length === 0,
                        onClick: () => setCreateFormOpen(true),
                      }
                    : undefined
                }
                onRefresh={handleRefresh}
              />
            </div>
            {listContent}
          </>
        )}
      </div>
    </section>
  );

  return (
    <>
      <div
        className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="work-management-github"
      >
        <DetailPanelContainer testId="work-management-github-panel">
          {listDescriptionContent}
        </DetailPanelContainer>
      </div>
    </>
  );
};

export default GitHubWorkItemsSurface;
