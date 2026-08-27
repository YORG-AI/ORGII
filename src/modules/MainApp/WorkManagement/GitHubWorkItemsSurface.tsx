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
import { GITHUB_QUERY_SCOPE } from "./githubWorkItemsSearchQuery";
import type { GitHubQueryScope } from "./githubWorkItemsSearchQuery";
import {
  DEFAULT_GITHUB_ISSUES_SORT,
  DEFAULT_GITHUB_PULL_REQUESTS_SORT,
  type GitHubWorkItemsSort,
} from "./githubWorkItemsSort";
import type { RepoFilterOption } from "./githubWorkItemsTypes";
import { useGitHubIssueAssigneeMutations } from "./useGitHubIssueAssigneeMutations";
import { useGitHubIssueMutations } from "./useGitHubIssueMutations";
import { useGitHubWorkItemActions } from "./useGitHubWorkItemActions";
import { useGitHubWorkItemStatusMutations } from "./useGitHubWorkItemStatusMutations";
import { useGitHubWorkItemsDerivedState } from "./useGitHubWorkItemsDerivedState";
import { useGitHubWorkItemsLoadLifecycle } from "./useGitHubWorkItemsLoadLifecycle";
import {
  GITHUB_FILTER_PRESET,
  ISSUE_REPO_FILTER,
  areRequestedPrStatesLoaded,
  useGitHubWorkItemsViewState,
} from "./useGitHubWorkItemsViewState";
import type { WorkManagementDetailHost } from "./workManagementDetailHost";

interface GitHubWorkItemsSurfaceProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  detailHost: WorkManagementDetailHost;
}

const GitHubWorkItemsSurface: React.FC<GitHubWorkItemsSurfaceProps> = ({
  scope,
  detailHost,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const permissionErrorMessage = t("common:errors.messages.forbidden");
  const repos = useAtomValue(reposAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const {
    openIssueInBrowser,
    openIssueInTab,
    openPrInTab,
    addIssue,
    addCreatedIssue,
    addPr,
  } = useGitHubWorkItemActions({ detailHost });
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [workItemsSortByScope, setWorkItemsSortByScope] = useState<
    Record<Extract<GitHubQueryScope, "issue" | "pr">, GitHubWorkItemsSort>
  >({
    issue: DEFAULT_GITHUB_ISSUES_SORT,
    pr: DEFAULT_GITHUB_PULL_REQUESTS_SORT,
  });
  const workItemsSort = workItemsSortByScope[scope];
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
  } = useGitHubWorkItemsViewState({ scope });
  const {
    repoSources,
    repoIssueMap,
    repoPrMap,
    loading,
    loadError,
    updateIssueMap,
    updatePrMap,
    setListError,
  } = useGitHubWorkItemsLoadLifecycle({
    repos,
    scope,
    issueStates: selectedIssueListStates,
    prStates: selectedPrListStates,
    refreshNonce,
    selectedRepo,
    selectedRepoPath,
    allReposValue: ISSUE_REPO_FILTER.ALL,
    currentWorkstationValue: ISSUE_REPO_FILTER.CURRENT_WORKSTATION,
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
    sort: workItemsSort,
  });
  const requestedPrDataLoaded = areRequestedPrStatesLoaded(
    selectedPrListStates,
    openPrLoaded,
    closedPrLoaded
  );
  const listLoading =
    loading ||
    (scope === GITHUB_QUERY_SCOPE.PR &&
      loadError === null &&
      paginatedSources.length > 0 &&
      !requestedPrDataLoaded);

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
  const { updateIssueStatus, updatePrStatus } =
    useGitHubWorkItemStatusMutations({
      repoSources,
      updateIssueMap,
      updatePrMap,
      setListError,
      updateErrorMessage: t("chat.panels.manageIssues.statusUpdateFailed", {
        defaultValue: "Failed to update GitHub status",
      }),
      permissionErrorMessage,
    });
  const {
    getIssueAssigneeControlState,
    loadAssignableUsers,
    updateIssueAssignees,
  } = useGitHubIssueAssigneeMutations({
    repoSources,
    updateIssueMap,
    setListError,
    updateErrorMessage: t("chat.panels.manageIssues.updateIssueFailed", {
      defaultValue: "Failed to update GitHub issue",
    }),
    updateNotAppliedMessage: t(
      "chat.panels.manageIssues.assigneeUpdateNotApplied",
      {
        defaultValue: "GitHub did not apply the assignee change",
      }
    ),
    updateSuccessMessage: t("chat.panels.manageIssues.assigneeUpdateSuccess", {
      defaultValue: "Assignees updated on GitHub",
    }),
    permissionErrorMessage,
  });
  const handleIssueAssigneesChange = useCallback(
    async (
      issue: Parameters<typeof updateIssueAssignees>[0],
      assignees: string[]
    ) => {
      await updateIssueAssignees(issue, assignees);
    },
    [updateIssueAssignees]
  );

  const handleGoToPage = useCallback(
    (page: number) => {
      setCurrentPage(Math.min(Math.max(1, page), totalLoadedPages));
    },
    [setCurrentPage, totalLoadedPages]
  );

  const handleSortChange = useCallback(
    (nextSort: GitHubWorkItemsSort) => {
      setWorkItemsSortByScope((current) => ({
        ...current,
        [scope]: nextSort,
      }));
      setCurrentPage(1);
    },
    [scope, setCurrentPage]
  );

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
      loading={listLoading}
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
      sort={workItemsSort}
      createFormOpen={createFormOpen}
      creatingIssue={creatingIssue}
      updateSearchQuery={updateSearchQuery}
      onSearchQueryChange={handleSearchQueryChange}
      onRepoSelect={handleRepoSelect}
      onIssuePersonalFiltersSelect={handleIssuePersonalFiltersSelect}
      onRefresh={handleRefresh}
      onGoToPage={handleGoToPage}
      onNextPage={handleNextPage}
      onSortChange={handleSortChange}
      onOpenIssue={openIssueInTab}
      onOpenIssueInBrowser={openIssueInBrowser}
      onAddIssue={addIssue}
      onIssueStatusChange={updateIssueStatus}
      getIssueAssigneeControlState={getIssueAssigneeControlState}
      onLoadIssueAssignees={loadAssignableUsers}
      onIssueAssigneesChange={handleIssueAssigneesChange}
      onOpenPr={openPrInTab}
      onAddPr={addPr}
      onPrStatusChange={updatePrStatus}
      onSetCreateFormOpen={setCreateFormOpen}
      onCreateIssue={handleCreateIssue}
    />
  );
};

export default GitHubWorkItemsSurface;
