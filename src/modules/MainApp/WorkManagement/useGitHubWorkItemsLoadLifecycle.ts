import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const [repoSources, setRepoSources] = useState<GitHubRepoSource[]>([]);
  const [repoIssueMap, setRepoIssueMap] = useState<
    Record<string, RepoIssueState>
  >({});
  const [repoPrMap, setRepoPrMap] = useState<Record<string, RepoPrState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const handledRefreshNonceRef = useRef(0);
  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = refreshNonce !== handledRefreshNonceRef.current;
    handledRefreshNonceRef.current = refreshNonce;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      const resolvedSources = (
        await Promise.all(gitRepos.map(resolveGitHubRepoSource))
      ).filter((source): source is GitHubRepoSource => Boolean(source));
      if (cancelled) return;
      setRepoSources(resolvedSources);
      setRepoIssueMap(
        scope === "issue"
          ? Object.fromEntries(
              resolvedSources.map((source) => [
                getRepoIssueMapKey(source),
                getCachedRepoIssues(source),
              ])
            )
          : {}
      );
      setRepoPrMap(
        scope === "pr"
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
        scope === "issue"
          ? Promise.all(
              resolvedSources.map((source) =>
                loadRepoIssues(source, issueStates, forceRefresh)
              )
            )
          : Promise.resolve([]),
        scope === "pr"
          ? Promise.all(
              resolvedSources.flatMap((source) =>
                prStates.map((state) =>
                  loadRepoPrs(source, state, forceRefresh)
                )
              )
            )
          : Promise.resolve([]),
      ]);
      if (cancelled) return;
      if (scope === "issue") {
        setRepoIssueMap(
          Object.fromEntries(
            issueResults.map(({ source, error: _error, ...state }) => [
              getRepoIssueMapKey(source),
              state,
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
  }, [gitRepos, issueStates, prStates, refreshNonce, scope]);

  const updateIssueMap = useCallback(
    (
      update: (
        current: Record<string, RepoIssueState>
      ) => Record<string, RepoIssueState>
    ) => setRepoIssueMap(update),
    []
  );
  const setListError = useCallback((error: string | null) => {
    setLoadError(error);
  }, []);

  return {
    repoSources,
    repoIssueMap,
    repoPrMap,
    loading,
    loadError,
    updateIssueMap,
    setListError,
  };
}
