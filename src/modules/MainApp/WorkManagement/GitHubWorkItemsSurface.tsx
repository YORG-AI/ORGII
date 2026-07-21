import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import type { SelectOption } from "@src/components/Select";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs";
import {
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import {
  createIssue,
  fetchIssues,
} from "@src/services/git/operations/githubIssues";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { REPO_KIND, reposAtom, selectedRepoPathAtom } from "@src/store/repo";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { createGitHubPrDetailTab } from "@src/store/workstation/tabs";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { GitHubWorkItemsView } from "./GitHubWorkItemsView";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
  GITHUB_FILTER_PRESET,
  GITHUB_QUERY_SCOPE,
  type GitHubQueryScope,
  type GitHubRepoSource,
  ISSUE_PAGE_SIZE,
  ISSUE_REPO_FILTER,
  type IssueRepoFilter,
  type ManagedIssueItem,
  type ManagedPrItem,
  type ParsedGitHubSearchQuery,
  type RepoFilterOption,
  type RepoIssueState,
  type RepoPrState,
  getCachedRepoIssues,
  getCachedRepoPrs,
  getIssuePageStatesForQuery,
  getRepoIssueMapKey,
  itemMatchesParsedQuery,
  itemMatchesRepo,
  loadRepoIssues,
  loadRepoPrs,
  manageIssuesSelectedRepoAtom,
  mapIssueToManagedIssue,
  mapPrToManagedPr,
  mergeUniqueIssues,
  parseGitHubSearchQuery,
  resolveGitHubRepoSource,
  serializeGitHubSearchQuery,
} from "./githubWorkItemsModel";
import {
  getGitHubWorkItemsPage,
  getGitHubWorkItemsPageCount,
} from "./githubWorkItemsPagination";
import {
  getCachedOpsGitHubView,
  getOpsPrListStates,
  setCachedOpsGitHubView,
} from "./githubWorkItemsViewCache";
import { useGitHubIssueDetail } from "./useGitHubIssueDetail";

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
  const [selectedRepo, setSelectedRepo] = useAtom(manageIssuesSelectedRepoAtom);
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const { openTab } = useWorkStationTabs();
  const [repoSources, setRepoSources] = useState<GitHubRepoSource[]>([]);
  const [repoIssueMap, setRepoIssueMap] = useState<
    Record<string, RepoIssueState>
  >({});
  const [repoPrMap, setRepoPrMap] = useState<Record<string, RepoPrState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(
    () => getCachedOpsGitHubView(scope)?.currentPage ?? 1
  );
  const [searchQuery, setSearchQuery] = useState(
    () => getCachedOpsGitHubView(scope)?.searchQuery ?? `is:${scope} is:open`
  );
  const parsedSearchQuery = useMemo(() => {
    const query = parseGitHubSearchQuery(searchQuery);
    query.scope = scope;
    return query;
  }, [scope, searchQuery]);
  const deferredParsedSearchQuery = useDeferredValue(parsedSearchQuery);
  const selectedIssueListStates = useMemo(
    () => getIssuePageStatesForQuery(parsedSearchQuery),
    [parsedSearchQuery]
  );
  const selectedPrListStates = useMemo(
    () => getOpsPrListStates(parsedSearchQuery.state),
    [parsedSearchQuery.state]
  );
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const {
    issueDetail,
    clearIssueDetail,
    handleAddIssueDetailComment,
    handleBackFromDetail,
    handleCloseIssueDetail,
    handleOpenIssue,
    handleOpenIssueInMyStation,
    handleReopenIssueDetail,
  } = useGitHubIssueDetail(onDetailViewChange);
  const previousScopeRef = useRef(scope);
  const handledRefreshNonceRef = useRef(0);

  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );

  useEffect(() => {
    if (previousScopeRef.current !== scope) {
      previousScopeRef.current = scope;
      const cachedView = getCachedOpsGitHubView(scope);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Scope changes intentionally restore the cached view state as one transition.
      setSearchQuery(cachedView?.searchQuery ?? `is:${scope} is:open`);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Scope changes intentionally restore the cached view state as one transition.
      setCurrentPage(cachedView?.currentPage ?? 1);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Changing scope must synchronously close an issue detail from the previous scope.
    clearIssueDetail();
  }, [clearIssueDetail, scope]);

  useEffect(() => {
    setCachedOpsGitHubView(scope, { searchQuery, currentPage });
  }, [currentPage, scope, searchQuery]);

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = refreshNonce !== handledRefreshNonceRef.current;
    handledRefreshNonceRef.current = refreshNonce;

    void (async () => {
      setLoading(true);
      setLoadError(null);

      const resolvedSources = (
        await Promise.all(gitRepos.map((repo) => resolveGitHubRepoSource(repo)))
      ).filter((source): source is GitHubRepoSource => Boolean(source));

      if (cancelled) return;

      setRepoSources(resolvedSources);
      setRepoIssueMap(
        scope === GITHUB_QUERY_SCOPE.ISSUE
          ? Object.fromEntries(
              resolvedSources.map((source) => [
                getRepoIssueMapKey(source),
                getCachedRepoIssues(source),
              ])
            )
          : {}
      );
      setRepoPrMap(
        scope === GITHUB_QUERY_SCOPE.PR
          ? Object.fromEntries(
              resolvedSources.map((source) => [
                getRepoIssueMapKey(source),
                getCachedRepoPrs(source),
              ])
            )
          : {}
      );

      if (resolvedSources.length === 0) {
        setLoading(false);
        return;
      }

      const [issueResults, prResults] = await Promise.all([
        scope === GITHUB_QUERY_SCOPE.ISSUE
          ? Promise.all(
              resolvedSources.map((source) =>
                loadRepoIssues(source, selectedIssueListStates, forceRefresh)
              )
            )
          : Promise.resolve([]),
        scope === GITHUB_QUERY_SCOPE.PR
          ? Promise.all(
              resolvedSources.flatMap((source) =>
                selectedPrListStates.map((state) =>
                  loadRepoPrs(source, state, forceRefresh)
                )
              )
            )
          : Promise.resolve([]),
      ]);
      if (cancelled) return;

      if (scope === GITHUB_QUERY_SCOPE.ISSUE) {
        setRepoIssueMap(
          Object.fromEntries(
            issueResults.map((result) => [
              getRepoIssueMapKey(result.source),
              {
                openIssues: result.openIssues,
                closedIssues: result.closedIssues,
                openLoaded: result.openLoaded,
                closedLoaded: result.closedLoaded,
                openHasMore: result.openHasMore,
                closedHasMore: result.closedHasMore,
                openNextPage: result.openNextPage,
                closedNextPage: result.closedNextPage,
              },
            ])
          )
        );
      } else {
        setRepoPrMap((current) => {
          const next = { ...current };
          for (const result of prResults) {
            const key = getRepoIssueMapKey(result.source);
            const currentState = next[key] ?? EMPTY_REPO_PRS;
            next[key] =
              result.state === "open"
                ? {
                    ...currentState,
                    openPrs: result.prs,
                    openLoaded: result.loaded,
                    openError: result.error,
                  }
                : {
                    ...currentState,
                    closedPrs: result.prs,
                    closedLoaded: result.loaded,
                    closedError: result.error,
                  };
          }
          return next;
        });
      }
      setLoadError(
        issueResults.find((result) => result.error)?.error ??
          prResults.find((result) => result.error)?.error ??
          null
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    gitRepos,
    refreshNonce,
    scope,
    selectedIssueListStates,
    selectedPrListStates,
  ]);

  const selectedWorkstationRepoSource = useMemo(
    () =>
      repoSources.find((source) => source.repoPath === selectedRepoPath) ??
      null,
    [repoSources, selectedRepoPath]
  );

  const effectiveSelectedRepo =
    selectedRepo === ISSUE_REPO_FILTER.CURRENT_WORKSTATION
      ? (selectedWorkstationRepoSource?.repoFullName ?? ISSUE_REPO_FILTER.ALL)
      : selectedRepo === ISSUE_REPO_FILTER.ALL ||
          repoSources.some((source) => source.repoFullName === selectedRepo)
        ? selectedRepo
        : (selectedWorkstationRepoSource?.repoFullName ??
          ISSUE_REPO_FILTER.ALL);

  const selectedRepoSourceForCreate = useMemo(
    () =>
      effectiveSelectedRepo === ISSUE_REPO_FILTER.ALL
        ? selectedWorkstationRepoSource
        : (repoSources.find(
            (source) => source.repoFullName === effectiveSelectedRepo
          ) ?? null),
    [effectiveSelectedRepo, repoSources, selectedWorkstationRepoSource]
  );

  const updateSearchQuery = useCallback(
    (mutate: (query: ParsedGitHubSearchQuery) => void) => {
      const nextQuery = parseGitHubSearchQuery(searchQuery);
      mutate(nextQuery);
      setSearchQuery(serializeGitHubSearchQuery(nextQuery));
      setCurrentPage(1);
    },
    [searchQuery]
  );

  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
  }, []);

  const handleRepoSelect = useCallback(
    (repo: IssueRepoFilter) => {
      setSelectedRepo(repo);
      setCurrentPage(1);
    },
    [setSelectedRepo]
  );

  const handleIssuePersonalFiltersSelect = useCallback(
    (values: (string | number)[]) => {
      updateSearchQuery((query) => {
        query.author = values.includes(GITHUB_FILTER_PRESET.BY_ME)
          ? "@me"
          : null;
        query.assignee = values.includes(GITHUB_FILTER_PRESET.ASSIGNED_TO_ME)
          ? "@me"
          : null;
      });
    },
    [updateSearchQuery]
  );

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

  const selectedIssuePersonalFilters = useMemo(
    () => [
      ...(parsedSearchQuery.author === "@me"
        ? [GITHUB_FILTER_PRESET.BY_ME]
        : []),
      ...(parsedSearchQuery.assignee === "@me"
        ? [GITHUB_FILTER_PRESET.ASSIGNED_TO_ME]
        : []),
    ],
    [parsedSearchQuery.assignee, parsedSearchQuery.author]
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

  const issues = useMemo(
    () =>
      repoSources.flatMap((source) => {
        const sourceIssues =
          repoIssueMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_ISSUES;
        return [...sourceIssues.openIssues, ...sourceIssues.closedIssues].map(
          (issue) => mapIssueToManagedIssue(issue, source)
        );
      }),
    [repoIssueMap, repoSources]
  );

  const pullRequests = useMemo(
    () =>
      repoSources.flatMap((source) => {
        const sourcePrs =
          repoPrMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_PRS;
        return [...sourcePrs.openPrs, ...sourcePrs.closedPrs].map((pr) =>
          mapPrToManagedPr(pr, source)
        );
      }),
    [repoPrMap, repoSources]
  );

  const allItems = useMemo(
    () =>
      [...issues, ...pullRequests].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      ),
    [issues, pullRequests]
  );

  const filteredItems = useMemo(
    () =>
      allItems.filter((item) => {
        if (!itemMatchesRepo(item, effectiveSelectedRepo)) return false;
        return itemMatchesParsedQuery(item, deferredParsedSearchQuery);
      }),
    [allItems, deferredParsedSearchQuery, effectiveSelectedRepo]
  );

  const pageStates = useMemo(
    () => getIssuePageStatesForQuery(parsedSearchQuery),
    [parsedSearchQuery]
  );
  const paginatedSources = useMemo(
    () =>
      effectiveSelectedRepo === ISSUE_REPO_FILTER.ALL
        ? repoSources
        : repoSources.filter(
            (source) => source.repoFullName === effectiveSelectedRepo
          ),
    [effectiveSelectedRepo, repoSources]
  );
  const hasMoreFilteredIssues = useMemo(
    () =>
      paginatedSources.some((source) => {
        const state = repoIssueMap[getRepoIssueMapKey(source)];
        if (!state) return false;
        return pageStates.some((pageState) =>
          pageState === "open" ? state.openHasMore : state.closedHasMore
        );
      }),
    [pageStates, paginatedSources, repoIssueMap]
  );
  const totalLoadedPages = getGitHubWorkItemsPageCount(filteredItems.length);
  const pagedItems = useMemo(
    () => getGitHubWorkItemsPage(filteredItems, currentPage),
    [currentPage, filteredItems]
  );
  useEffect(() => {
    if (!loading && currentPage > totalLoadedPages) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Remote result shrinkage requires clamping the controlled page.
      setCurrentPage(totalLoadedPages);
    }
  }, [currentPage, loading, totalLoadedPages]);

  const handleRefresh = useCallback(() => {
    setCurrentPage(1);
    setRefreshNonce((current) => current + 1);
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMoreFilteredIssues) return;
    setLoadingMore(true);

    const requests = paginatedSources.flatMap((source) => {
      const repoIssueState = repoIssueMap[getRepoIssueMapKey(source)];
      if (!repoIssueState) return [];

      return pageStates.flatMap((pageState) => {
        const hasMore =
          pageState === "open"
            ? repoIssueState.openHasMore
            : repoIssueState.closedHasMore;
        const nextPage =
          pageState === "open"
            ? repoIssueState.openNextPage
            : repoIssueState.closedNextPage;
        if (!hasMore || !nextPage) return [];
        return [{ source, pageState, nextPage }];
      });
    });

    const results = await Promise.all(
      requests.map(async ({ source, pageState, nextPage }) => ({
        source,
        pageState,
        result: await fetchIssues(source.remoteUrl, {
          state: pageState,
          page: nextPage,
          perPage: ISSUE_PAGE_SIZE,
        }),
      }))
    );

    setRepoIssueMap((current) => {
      const next = { ...current };
      for (const { source, pageState, result } of results) {
        if (!result.data) continue;
        const key = getRepoIssueMapKey(source);
        const currentState = next[key] ?? EMPTY_REPO_ISSUES;
        if (pageState === "open") {
          const openIssues = mergeUniqueIssues(
            currentState.openIssues,
            result.data.issues
          );
          next[key] = {
            ...currentState,
            openIssues,
            openHasMore: result.data.has_more,
            openNextPage: result.data.next_page,
          };
          updateCachedOpenIssues(source.repoPath, openIssues);
        } else {
          const closedIssues = mergeUniqueIssues(
            currentState.closedIssues,
            result.data.issues
          );
          next[key] = {
            ...currentState,
            closedIssues,
            closedHasMore: result.data.has_more,
            closedNextPage: result.data.next_page,
          };
          updateCachedClosedIssues(source.repoPath, closedIssues);
        }
      }
      return next;
    });
    setLoadError(
      results.find(({ result }) => result.error)?.result.error ?? null
    );
    setLoadingMore(false);
  }, [
    hasMoreFilteredIssues,
    loadingMore,
    pageStates,
    paginatedSources,
    repoIssueMap,
  ]);

  const handlePreviousPage = useCallback(() => {
    setCurrentPage((page) => Math.max(1, page - 1));
  }, []);

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
    totalLoadedPages,
  ]);

  const handleOpenIssueInBrowser = useCallback((issue: ManagedIssueItem) => {
    void openExternalLink(issue.rawIssue.html_url);
  }, []);

  const handleAddIssue = useCallback(
    (issue: ManagedIssueItem) => {
      setAddToAgent({
        type: "issue",
        issueNumber: issue.id,
        issueTitle: issue.title,
        issueUrl: issue.rawIssue.html_url,
        issueState: issue.state,
        labels: issue.labels.map((label) => label.name),
        assignees: issue.rawIssue.assignees.map((assignee) => assignee.login),
        comments: issue.comments,
      });
      Message.success(t("toasts.addedAsContext", { name: `#${issue.id}` }));
    },
    [setAddToAgent, t]
  );

  const handleAddPr = useCallback(
    (pr: ManagedPrItem) => {
      setAddToAgent({
        type: "pr",
        prNumber: pr.id,
        prTitle: pr.title,
        prUrl: pr.rawPr.url,
        prStatus: pr.state,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
      });
      Message.success(t("toasts.addedAsContext", { name: `PR #${pr.id}` }));
    },
    [setAddToAgent, t]
  );

  const handleOpenPr = useCallback(
    (pr: ManagedPrItem) => {
      openTab(
        createGitHubPrDetailTab({
          prNumber: pr.id,
          prTitle: pr.title,
          prUrl: pr.rawPr.url,
          prStatus: pr.state,
          headBranch: pr.sourceBranch,
          baseBranch: pr.targetBranch,
          repoPath: pr.repoPath,
          repoId: pr.repoId,
        })
      );
      void WorkStationViewService.openStationMode("my-station");
    },
    [openTab]
  );

  const handleCreateIssue = useCallback(
    async (source: GitHubRepoSource, title: string, body: string) => {
      setCreatingIssue(true);
      const result = await createIssue({
        remoteUrl: source.remoteUrl,
        title,
        body: body || undefined,
      });
      setCreatingIssue(false);

      if (result.error || !result.data) {
        Message.error(
          result.error ?? t("chat.panels.manageIssues.createIssueFailed")
        );
        return;
      }
      const createdIssue = result.data;

      setRepoIssueMap((current) => {
        const key = getRepoIssueMapKey(source);
        const currentState = current[key] ?? EMPTY_REPO_ISSUES;
        const openIssues = mergeUniqueIssues(
          [createdIssue],
          currentState.openIssues
        );
        updateCachedOpenIssues(source.repoPath, openIssues);
        return {
          ...current,
          [key]: { ...currentState, openIssues },
        };
      });
      setCreateFormOpen(false);
      Message.success(
        t("toasts.addedAsContext", { name: `#${createdIssue.number}` })
      );
      setAddToAgent({
        type: "issue",
        issueNumber: createdIssue.number,
        issueTitle: createdIssue.title,
        issueUrl: createdIssue.html_url,
        issueState: createdIssue.state,
        labels: createdIssue.labels.map((label) => label.name),
        assignees: createdIssue.assignees.map((assignee) => assignee.login),
        comments: createdIssue.comments,
      });
    },
    [setAddToAgent, t]
  );

  return (
    <GitHubWorkItemsView
      scope={scope}
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
      onOpenIssue={handleOpenIssue}
      onOpenIssueInBrowser={handleOpenIssueInBrowser}
      onOpenIssueInMyStation={handleOpenIssueInMyStation}
      onAddIssue={handleAddIssue}
      onOpenPr={handleOpenPr}
      onAddPr={handleAddPr}
      onBackFromDetail={handleBackFromDetail}
      onCloseIssueDetail={handleCloseIssueDetail}
      onReopenIssueDetail={handleReopenIssueDetail}
      onAddIssueDetailComment={handleAddIssueDetailComment}
      onSetCreateFormOpen={setCreateFormOpen}
      onCreateIssue={handleCreateIssue}
    />
  );
};

export default GitHubWorkItemsSurface;
