import { useCallback, useMemo } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  getGitHubGitCredentialForRemote,
  listPRsLocal,
} from "@src/api/tauri/github";
import type {
  GitHubIssue,
  OpenPRItem,
  PullRequestListState,
} from "@src/api/tauri/github";
import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
import {
  coalesceGitHubListRequest,
  getCachedIssues,
  getCachedPrs,
  isIssueCacheStale,
  isPrCacheStale,
  setCachedPrs,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import { fetchIssues } from "@src/services/git/operations/githubIssues";
import { REPO_KIND } from "@src/store/repo";
import type { Repo } from "@src/store/repo/types";

import type {
  GitHubIssuePageState,
  GitHubQueryScope,
} from "./githubWorkItemsSearchQuery";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";

export const ISSUE_PAGE_SIZE = 50;
const PR_PAGE_SIZE = 50;

export interface RepoIssueState {
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openLoaded: boolean;
  closedLoaded: boolean;
  openHasMore: boolean;
  closedHasMore: boolean;
  openNextPage: number | null;
  closedNextPage: number | null;
}

export interface RepoPrState {
  openPrs: OpenPRItem[];
  closedPrs: OpenPRItem[];
  openLoaded: boolean;
  closedLoaded: boolean;
  openError: string | null;
  closedError: string | null;
}

interface RepoIssueLoadResult extends RepoIssueState {
  source: GitHubRepoSource;
  error: string | null;
}

interface RepoPrLoadResult {
  source: GitHubRepoSource;
  state: PullRequestListState;
  prs: OpenPRItem[];
  loaded: boolean;
  error: string | null;
}

export const EMPTY_REPO_ISSUES: RepoIssueState = {
  openIssues: [],
  closedIssues: [],
  openLoaded: false,
  closedLoaded: false,
  openHasMore: false,
  closedHasMore: false,
  openNextPage: null,
  closedNextPage: null,
};

export const EMPTY_REPO_PRS: RepoPrState = {
  openPrs: [],
  closedPrs: [],
  openLoaded: false,
  closedLoaded: false,
  openError: null,
  closedError: null,
};

interface GitHubWorkItemsLoadData {
  loadError: string | null;
  repoIssueMap: Record<string, RepoIssueState>;
  repoPrMap: Record<string, RepoPrState>;
  repoSources: GitHubRepoSource[];
}

interface GitHubWorkItemsLoadRequest {
  issueStates: GitHubIssuePageState[];
  prStates: PullRequestListState[];
  refreshNonce: number;
  repos: Repo[];
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
}

const EMPTY_GITHUB_WORK_ITEMS_LOAD_DATA: GitHubWorkItemsLoadData = {
  loadError: null,
  repoIssueMap: {},
  repoPrMap: {},
  repoSources: [],
};

export function getRepoIssueMapKey(source: GitHubRepoSource): string {
  return source.repoFullName;
}

export function mergeUniqueIssues(
  existingIssues: GitHubIssue[],
  incomingIssues: GitHubIssue[]
): GitHubIssue[] {
  const seenIssueNumbers = new Set(existingIssues.map((issue) => issue.number));
  return [
    ...existingIssues,
    ...incomingIssues.filter((issue) => !seenIssueNumbers.has(issue.number)),
  ];
}

function getCachedRepoIssues(source: GitHubRepoSource): RepoIssueState {
  const cached = getCachedIssues(source.repoPath);
  if (!cached) return EMPTY_REPO_ISSUES;
  return {
    openIssues: cached.openIssues,
    closedIssues: cached.closedIssues,
    openLoaded: typeof cached.openCachedAt === "number",
    closedLoaded: typeof cached.closedCachedAt === "number",
    openHasMore: cached.openIssues.length >= ISSUE_PAGE_SIZE,
    closedHasMore: cached.closedIssues.length >= ISSUE_PAGE_SIZE,
    openNextPage: cached.openIssues.length >= ISSUE_PAGE_SIZE ? 2 : null,
    closedNextPage: cached.closedIssues.length >= ISSUE_PAGE_SIZE ? 2 : null,
  };
}

function getCachedRepoPrs(source: GitHubRepoSource): RepoPrState {
  const open = getCachedPrs(source.repoPath, "open");
  const closed = getCachedPrs(source.repoPath, "closed");
  return {
    openPrs: open?.prs ?? [],
    closedPrs: closed?.prs ?? [],
    openLoaded: Boolean(open),
    closedLoaded: Boolean(closed),
    openError: null,
    closedError: null,
  };
}

async function resolveGitHubRepoSource(
  repo: Repo
): Promise<GitHubRepoSource | null> {
  if (repo.kind !== REPO_KIND.GIT || !repo.path) return null;
  const remoteUrl =
    repo.repo_url ??
    (
      await getGitRemotes({ repo_id: repo.id, repo_path: repo.path })
    )?.remotes?.find((remote) => remote.name === "origin")?.url;
  if (!remoteUrl) return null;
  const repoFullName = parseGithubRepoFullName(remoteUrl);
  if (!repoFullName) return null;
  const credential = await getGitHubGitCredentialForRemote(remoteUrl);
  return {
    repoId: repo.id,
    repoPath: repo.path,
    label: repo.name,
    remoteUrl,
    repoFullName,
    viewerLogin: credential?.username ?? null,
  };
}

async function loadRepoIssues(
  source: GitHubRepoSource,
  states: GitHubIssuePageState[],
  force: boolean
): Promise<RepoIssueLoadResult> {
  const cached = getCachedRepoIssues(source);
  if (
    !force &&
    states.every((state) => !isIssueCacheStale(source.repoPath, state))
  ) {
    return { source, ...cached, error: null };
  }
  const results = await coalesceGitHubListRequest(
    `work-management:issues:${states.join(",")}:${source.repoPath}`,
    () =>
      Promise.all(
        states.map((state) =>
          fetchIssues(source.remoteUrl, {
            state,
            page: 1,
            perPage: ISSUE_PAGE_SIZE,
          })
        )
      )
  );
  const resultByState = new Map(
    states.map((state, index) => [state, results[index]] as const)
  );
  const openResult = resultByState.get("open");
  const closedResult = resultByState.get("closed");
  const openIssues = openResult?.data?.issues ?? cached.openIssues;
  const closedIssues = closedResult?.data?.issues ?? cached.closedIssues;
  if (openResult?.data) updateCachedOpenIssues(source.repoPath, openIssues);
  if (closedResult?.data)
    updateCachedClosedIssues(source.repoPath, closedIssues);
  return {
    source,
    openIssues,
    closedIssues,
    openLoaded: Boolean(openResult?.data) || cached.openLoaded,
    closedLoaded: Boolean(closedResult?.data) || cached.closedLoaded,
    openHasMore: openResult?.data?.has_more ?? cached.openHasMore,
    closedHasMore: closedResult?.data?.has_more ?? cached.closedHasMore,
    openNextPage: openResult?.data?.next_page ?? cached.openNextPage,
    closedNextPage: closedResult?.data?.next_page ?? cached.closedNextPage,
    error: openResult?.error ?? closedResult?.error ?? null,
  };
}

async function loadRepoPrs(
  source: GitHubRepoSource,
  state: PullRequestListState,
  force: boolean
): Promise<RepoPrLoadResult> {
  const cached = getCachedPrs(source.repoPath, state);
  if (cached && !force && !isPrCacheStale(source.repoPath, state)) {
    return { source, state, prs: cached.prs, loaded: true, error: null };
  }
  try {
    const prs = await coalesceGitHubListRequest(
      `work-management:prs:${state}:${source.repoPath}`,
      () => listPRsLocal(source.repoFullName, state, PR_PAGE_SIZE)
    );
    setCachedPrs(source.repoPath, prs, state);
    return { source, state, prs, loaded: true, error: null };
  } catch (error: unknown) {
    return {
      source,
      state,
      prs: cached?.prs ?? [],
      loaded: Boolean(cached),
      error: String(error),
    };
  }
}

export function useGitHubWorkItemsLoadLifecycle({
  repos,
  scope,
  issueStates,
  prStates,
  refreshNonce,
}: {
  repos: Repo[];
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  issueStates: GitHubIssuePageState[];
  prStates: PullRequestListState[];
  refreshNonce: number;
}) {
  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );
  const scopeKey = JSON.stringify({
    issueStates,
    prStates,
    refreshNonce,
    repos: gitRepos,
    scope,
  } satisfies GitHubWorkItemsLoadRequest);
  const loadWorkItems = useCallback(
    async (
      serializedRequest: string,
      context: AsyncResourceFetchContext<GitHubWorkItemsLoadData>
    ) => {
      const request = JSON.parse(
        serializedRequest
      ) as GitHubWorkItemsLoadRequest;
      const resolvedSources = (
        await Promise.all(request.repos.map(resolveGitHubRepoSource))
      ).filter((source): source is GitHubRepoSource => Boolean(source));
      const cachedData: GitHubWorkItemsLoadData = {
        loadError: null,
        repoIssueMap:
          request.scope === "issue"
            ? Object.fromEntries(
                resolvedSources.map((source) => [
                  getRepoIssueMapKey(source),
                  getCachedRepoIssues(source),
                ])
              )
            : {},
        repoPrMap:
          request.scope === "pr"
            ? Object.fromEntries(
                resolvedSources.map((source) => [
                  getRepoIssueMapKey(source),
                  getCachedRepoPrs(source),
                ])
              )
            : {},
        repoSources: resolvedSources,
      };
      context.publish(cachedData, { keepLoading: true });
      if (resolvedSources.length === 0) return cachedData;

      const forceRefresh =
        context.cause === "refresh" || request.refreshNonce > 0;
      const [issueResults, prResults] = await Promise.all([
        request.scope === "issue"
          ? Promise.all(
              resolvedSources.map((source) =>
                loadRepoIssues(source, request.issueStates, forceRefresh)
              )
            )
          : Promise.resolve([]),
        request.scope === "pr"
          ? Promise.all(
              resolvedSources.flatMap((source) =>
                request.prStates.map((state) =>
                  loadRepoPrs(source, state, forceRefresh)
                )
              )
            )
          : Promise.resolve([]),
      ]);

      const repoIssueMap =
        request.scope === "issue"
          ? Object.fromEntries(
              issueResults.map(({ source, error: _error, ...state }) => [
                getRepoIssueMapKey(source),
                state,
              ])
            )
          : {};
      const repoPrMap: Record<string, RepoPrState> = {};
      if (request.scope === "pr") {
        for (const result of prResults) {
          const key = getRepoIssueMapKey(result.source);
          const currentState = repoPrMap[key] ?? EMPTY_REPO_PRS;
          repoPrMap[key] =
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
      }
      return {
        loadError:
          issueResults.find((result) => result.error)?.error ??
          prResults.find((result) => result.error)?.error ??
          null,
        repoIssueMap,
        repoPrMap,
        repoSources: resolvedSources,
      };
    },
    []
  );
  const resource = useAsyncResource({
    fetcher: loadWorkItems,
    initialData: EMPTY_GITHUB_WORK_ITEMS_LOAD_DATA,
    scopeKey,
  });
  const setLoadData = resource.setData;

  const updateIssueMap = useCallback(
    (
      update: (
        current: Record<string, RepoIssueState>
      ) => Record<string, RepoIssueState>
    ) =>
      setLoadData((current) => ({
        ...current,
        repoIssueMap: update(current.repoIssueMap),
      })),
    [setLoadData]
  );
  const setListError = useCallback(
    (error: string | null) => {
      setLoadData((current) => ({ ...current, loadError: error }));
    },
    [setLoadData]
  );

  return {
    repoSources: resource.data.repoSources,
    repoIssueMap: resource.data.repoIssueMap,
    repoPrMap: resource.data.repoPrMap,
    loading: resource.loading,
    loadError: resource.error ?? resource.data.loadError,
    updateIssueMap,
    setListError,
  };
}
