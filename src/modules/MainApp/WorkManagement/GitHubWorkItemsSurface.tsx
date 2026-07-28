import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption } from "@src/components/Select";
import { reposAtom, selectedRepoPathAtom } from "@src/store/repo";

import { GitHubWorkItemsView } from "./GitHubWorkItemsView";
import type { RepoFilterOption } from "./githubWorkItemsModel";
import { GITHUB_QUERY_SCOPE } from "./githubWorkItemsSearchQuery";
import type { GitHubQueryScope } from "./githubWorkItemsSearchQuery";
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

interface GitHubWorkItemsSurfaceProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  singleRowHeader: boolean;
  onDetailViewChange: (open: boolean, onBack: (() => void) | null) => void;
}

const GitHubWorkItemsSurface: React.FC<GitHubWorkItemsSurfaceProps> = ({
  scope,
  singleRowHeader,
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
  } = useGitHubIssueDetail({ onDetailViewChange });
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Remote result shrinkage requires clamping the controlled page.
      setCurrentPage(totalLoadedPages);
    }
  }, [currentPage, loading, setCurrentPage, totalLoadedPages]);

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
  }, [setCurrentPage]);

  const handleNextPage = useCallback(async () => {
    if (currentPage < totalLoadedPages) {
      setCurrentPage((page) => page + 1);
      return;
    }
    if (!hasMoreFilteredIssues || loadingMore) return;
    await handleLoadMore();
    setCurrentPage((page) => page + 1);
  }, [
    currentPage,
    handleLoadMore,
    hasMoreFilteredIssues,
    loadingMore,
    setCurrentPage,
    totalLoadedPages,
  ]);

  return (
    <GitHubWorkItemsView
      scope={scope}
      singleRowHeader={singleRowHeader}
      loading={loading}
      loadError={loadError}
      loadingMore={loadingMore}
      allItemsCount={allItems.length}
      filteredItems={filteredItems}
      pagedItems={pagedItems}
      repoSources={repoSources}
      repoOptions={repoOptions}
      effectiveSelectedRepo={effectiveSelectedRepo}
      selectedRepoSourceForCreate={selectedRepoSourceForCreate}
      searchQuery={searchQuery}
      parsedSearchQuery={parsedSearchQuery}
      issuePersonalFilterOptions={issuePersonalFilterOptions}
      selectedIssuePersonalFilters={selectedIssuePersonalFilters}
      currentPage={currentPage}
      totalLoadedPages={totalLoadedPages}
      hasMoreFilteredIssues={hasMoreFilteredIssues}
      createFormOpen={createFormOpen}
      creatingIssue={creatingIssue}
      issueDetail={issueDetail}
      updateSearchQuery={updateSearchQuery}
      onSearchQueryChange={handleSearchQueryChange}
      onRepoSelect={handleRepoSelect}
      onIssuePersonalFiltersSelect={handleIssuePersonalFiltersSelect}
      onRefresh={handleRefresh}
      onPreviousPage={handlePreviousPage}
      onNextPage={handleNextPage}
      onOpenIssue={openDetail}
      onOpenIssueInBrowser={openIssueInBrowser}
      onOpenIssueInMyStation={openIssueInMyStation}
      onAddIssue={addIssue}
      onOpenPr={openPr}
      onAddPr={addPr}
      onBackFromDetail={closeDetail}
      onCloseIssueDetail={closeCurrentIssue}
      onReopenIssueDetail={reopenCurrentIssue}
      onAddIssueDetailComment={addIssueDetailComment}
      onSetCreateFormOpen={setCreateFormOpen}
      onCreateIssue={handleCreateIssue}
    />
  );
};

export default GitHubWorkItemsSurface;
