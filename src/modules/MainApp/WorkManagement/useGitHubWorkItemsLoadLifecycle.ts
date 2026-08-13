import { useStore } from "jotai";
import type { Store } from "jotai/vanilla/store";
import isEqual from "lodash/isEqual";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  getGitHubRepoPermissionsLocal,
  getGitHubViewerLogin,
  listPRsLocal,
} from "@src/api/tauri/github";
import type { GitHubRepoPermissions } from "@src/api/tauri/github";
import type {
  GitHubIssue,
  OpenPRItem,
  PullRequestListState,
} from "@src/api/tauri/github";
import {
  loadGitHubDetailAuthScope,
  loadGitHubRepoPermissions,
  loadGitHubViewer,
} from "@src/modules/shared/githubIssueDetailCoordinator";
import {
  GITHUB_LIST_CACHE_TTL_MS,
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
import { StoreScopedSnapshotCache } from "@src/util/cache/storeScopedSnapshotCache";
import { mapWithConcurrency } from "@src/util/collections/mapWithConcurrency";

import type {
  GitHubIssuePageState,
  GitHubQueryScope,
} from "./githubWorkItemsSearchQuery";
import {
  type GitHubRepoSource,
  getGitHubListCacheKey,
} from "./githubWorkItemsTypes";

export const ISSUE_PAGE_SIZE = 50;
const PR_PAGE_SIZE = 50;
const GITHUB_SOURCE_CONCURRENCY = 4;
const MAX_RETAINED_GITHUB_LIST_SCOPES = 4;
const MAX_RETAINED_GITHUB_REPOS = 8;
const MAX_RETAINED_ISSUES_PER_STATE = 100;
const MAX_RETAINED_PRS_PER_STATE = 100;

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

export interface GitHubWorkItemsLifecycleSnapshot {
  viewerLogin: string;
  repoSources: GitHubRepoSource[];
  repoIssueMap: Record<string, RepoIssueState>;
  repoPrMap: Record<string, RepoPrState>;
  loadError: string | null;
}

const retainedLifecycleSnapshots = new StoreScopedSnapshotCache<
  string,
  GitHubWorkItemsLifecycleSnapshot
>(MAX_RETAINED_GITHUB_LIST_SCOPES, GITHUB_LIST_CACHE_TTL_MS);
const resolvedViewerByStore = new WeakMap<Store, string>();

export interface RepoIssueLoadResult extends RepoIssueState {
  source: GitHubRepoSource;
  error: string | null;
}

export interface RepoPrLoadResult {
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

export function getGitHubLifecycleRetentionKey(
  repos: readonly Repo[],
  scope: Extract<GitHubQueryScope, "issue" | "pr">
): string {
  return JSON.stringify([
    scope,
    ...repos
      .filter((repo) => repo.kind === REPO_KIND.GIT && repo.path)
      .map(
        (repo) =>
          [
            repo.id ?? "",
            repo.path ?? "",
            repo.repo_url ?? "",
            repo.name,
          ] as const
      )
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
  ]);
}

function boundedIssueState(state: RepoIssueState): RepoIssueState {
  return {
    ...state,
    openIssues: state.openIssues.slice(0, MAX_RETAINED_ISSUES_PER_STATE),
    closedIssues: state.closedIssues.slice(0, MAX_RETAINED_ISSUES_PER_STATE),
  };
}

function boundedPrState(state: RepoPrState): RepoPrState {
  return {
    ...state,
    openPrs: state.openPrs.slice(0, MAX_RETAINED_PRS_PER_STATE),
    closedPrs: state.closedPrs.slice(0, MAX_RETAINED_PRS_PER_STATE),
  };
}

export function retainGitHubWorkItemsLifecycleSnapshot({
  current,
  viewerLogin,
  repoSources,
  repoIssueMap,
  repoPrMap,
  loadError,
}: {
  current?: GitHubWorkItemsLifecycleSnapshot;
  viewerLogin: string;
  repoSources: GitHubRepoSource[];
  repoIssueMap: Record<string, RepoIssueState>;
  repoPrMap: Record<string, RepoPrState>;
  loadError: string | null;
}): GitHubWorkItemsLifecycleSnapshot {
  const boundedSources = repoSources.slice(0, MAX_RETAINED_GITHUB_REPOS);
  const retainedRepoNames = new Set(
    boundedSources.map((source) => source.repoFullName)
  );
  const boundedIssueMap = Object.fromEntries(
    Object.entries(repoIssueMap)
      .filter(([repoFullName]) => retainedRepoNames.has(repoFullName))
      .map(([repoFullName, state]) => [repoFullName, boundedIssueState(state)])
  );
  const boundedPrMap = Object.fromEntries(
    Object.entries(repoPrMap)
      .filter(([repoFullName]) => retainedRepoNames.has(repoFullName))
      .map(([repoFullName, state]) => [repoFullName, boundedPrState(state)])
  );
  const next = {
    viewerLogin,
    repoSources: boundedSources,
    repoIssueMap: boundedIssueMap,
    repoPrMap: boundedPrMap,
    loadError,
  };
  return current && isEqual(current, next) ? current : next;
}

function setIfChanged<T>(
  setValue: Dispatch<SetStateAction<T>>,
  nextValue: NoInfer<T>
): void {
  setValue((current) => (isEqual(current, nextValue) ? current : nextValue));
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

export function mergeRepoIssueLoadResults(
  current: Record<string, RepoIssueState>,
  resolvedSources: readonly GitHubRepoSource[],
  results: readonly RepoIssueLoadResult[]
): Record<string, RepoIssueState> {
  const next = Object.fromEntries(
    resolvedSources.map((source) => {
      const key = getRepoIssueMapKey(source);
      return [key, current[key] ?? EMPTY_REPO_ISSUES];
    })
  );
  for (const { source, error: _error, ...state } of results) {
    next[getRepoIssueMapKey(source)] = state;
  }
  return isEqual(current, next) ? current : next;
}

function getCachedRepoIssues(source: GitHubRepoSource): RepoIssueState {
  const cached = getCachedIssues(getGitHubListCacheKey(source));
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
  const cacheKey = getGitHubListCacheKey(source);
  const open = getCachedPrs(cacheKey, "open");
  const closed = getCachedPrs(cacheKey, "closed");
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
  let remoteUrl = repo.repo_url;
  if (!remoteUrl) {
    try {
      remoteUrl = (
        await getGitRemotes({ repo_id: repo.id, repo_path: repo.path })
      )?.remotes?.find((remote) => remote.name === "origin")?.url;
    } catch {
      return null;
    }
  }
  if (!remoteUrl) return null;
  const repoFullName = parseGithubRepoFullName(remoteUrl);
  if (!repoFullName) return null;
  return {
    repoId: repo.id,
    repoPath: repo.path,
    label: repo.name,
    remoteUrl,
    repoFullName,
    viewerLogin: null,
    permissions: null,
    authScope: null,
  };
}

export async function loadRepoPermissions(
  store: Store,
  source: GitHubRepoSource,
  authScope: string
): Promise<[string, GitHubRepoPermissions | null]> {
  const permissions = await loadGitHubRepoPermissions(
    store,
    authScope,
    source.repoFullName,
    () => getGitHubRepoPermissionsLocal(source.repoFullName)
  ).catch(() => null);
  return [source.repoFullName, permissions];
}

async function loadRepoIssues(
  source: GitHubRepoSource,
  states: GitHubIssuePageState[],
  force: boolean
): Promise<RepoIssueLoadResult> {
  const cacheKey = getGitHubListCacheKey(source);
  const cached = getCachedRepoIssues(source);
  if (!force && states.every((state) => !isIssueCacheStale(cacheKey, state))) {
    return { source, ...cached, error: null };
  }
  const results = await coalesceGitHubListRequest(
    `work-management:issues:${states.join(",")}:${cacheKey}`,
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
  if (openResult?.data) updateCachedOpenIssues(cacheKey, openIssues);
  if (closedResult?.data) updateCachedClosedIssues(cacheKey, closedIssues);
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

export async function loadRepoPrs(
  source: GitHubRepoSource,
  state: PullRequestListState,
  force: boolean
): Promise<RepoPrLoadResult> {
  const cacheKey = getGitHubListCacheKey(source);
  const cached = getCachedPrs(cacheKey, state);
  if (cached && !force && !isPrCacheStale(cacheKey, state)) {
    return { source, state, prs: cached.prs, loaded: true, error: null };
  }
  try {
    const prs = await coalesceGitHubListRequest(
      `work-management:prs:${state}:${cacheKey}`,
      () => listPRsLocal(source.repoFullName, state, PR_PAGE_SIZE)
    );
    setCachedPrs(cacheKey, prs, state);
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

export function selectGitHubLoadSources({
  sources,
  selectedRepo,
  selectedRepoPath,
  allReposValue,
  currentWorkstationValue,
}: {
  sources: GitHubRepoSource[];
  selectedRepo: string;
  selectedRepoPath: string | null;
  allReposValue: string;
  currentWorkstationValue: string;
}): GitHubRepoSource[] {
  if (selectedRepo === allReposValue) return sources;
  if (selectedRepo === currentWorkstationValue) {
    const currentSource = sources.find(
      (source) => source.repoPath === selectedRepoPath
    );
    return currentSource ? [currentSource] : [];
  }
  const selectedSource = sources.find(
    (source) => source.repoFullName === selectedRepo
  );
  return selectedSource ? [selectedSource] : [];
}

export function useGitHubWorkItemsLoadLifecycle({
  repos,
  scope,
  issueStates,
  prStates,
  refreshNonce,
  selectedRepo = "__all__",
  selectedRepoPath = null,
  allReposValue = "__all__",
  currentWorkstationValue = "__current__",
}: {
  repos: Repo[];
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  issueStates: GitHubIssuePageState[];
  prStates: PullRequestListState[];
  refreshNonce: number;
  selectedRepo?: string;
  selectedRepoPath?: string | null;
  allReposValue?: string;
  currentWorkstationValue?: string;
}) {
  const store = useStore();
  const gitRepos = useMemo(
    () => repos.filter((repo) => repo.kind === REPO_KIND.GIT && repo.path),
    [repos]
  );
  const retentionKey = useMemo(
    () => getGitHubLifecycleRetentionKey(gitRepos, scope),
    [gitRepos, scope]
  );
  const retainedSnapshot = useMemo(() => {
    const currentViewer = resolvedViewerByStore.get(store);
    const snapshot = retainedLifecycleSnapshots.get(store, retentionKey);
    return snapshot && snapshot.viewerLogin === currentViewer ? snapshot : null;
  }, [retentionKey, store]);
  const [repoSources, setRepoSources] = useState<GitHubRepoSource[]>(
    () => retainedSnapshot?.repoSources ?? []
  );
  const [repoIssueMap, setRepoIssueMap] = useState<
    Record<string, RepoIssueState>
  >(() => retainedSnapshot?.repoIssueMap ?? {});
  const [repoPrMap, setRepoPrMap] = useState<Record<string, RepoPrState>>(
    () => retainedSnapshot?.repoPrMap ?? {}
  );
  const [loading, setLoading] = useState(() => !retainedSnapshot);
  const [loadError, setLoadError] = useState<string | null>(
    () => retainedSnapshot?.loadError ?? null
  );
  const loadedRef = useRef(Boolean(retainedSnapshot));
  const handledRefreshNonceRef = useRef(0);
  const permissionViewerRef = useRef<string | null>(
    retainedSnapshot?.viewerLogin ?? null
  );

  useEffect(() => {
    const viewerLogin = permissionViewerRef.current;
    if (!viewerLogin || !loadedRef.current || loading) return;
    const current = retainedLifecycleSnapshots.get(store, retentionKey);
    retainedLifecycleSnapshots.set(
      store,
      retentionKey,
      retainGitHubWorkItemsLifecycleSnapshot({
        current,
        viewerLogin,
        repoSources,
        repoIssueMap,
        repoPrMap,
        loadError,
      })
    );
  }, [
    loadError,
    loading,
    repoIssueMap,
    repoPrMap,
    repoSources,
    retentionKey,
    store,
  ]);

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = refreshNonce !== handledRefreshNonceRef.current;
    handledRefreshNonceRef.current = refreshNonce;
    void (async () => {
      if (forceRefresh || !loadedRef.current) setLoading(true);
      setLoadError(null);
      if (gitRepos.length === 0) {
        permissionViewerRef.current = null;
        loadedRef.current = true;
        setIfChanged(setRepoSources, []);
        setIfChanged(setRepoIssueMap, {});
        setIfChanged(setRepoPrMap, {});
        setLoading(false);
        return;
      }
      const authScopePromise = loadGitHubDetailAuthScope(store).catch(
        () => null
      );
      const viewerResultPromise = authScopePromise.then((authScope) =>
        loadGitHubViewer(
          store,
          authScope ?? "github.com:unresolved",
          getGitHubViewerLogin
        ).then(
          (login) => ({ login, error: null }),
          (error: unknown) => ({ login: null, error: String(error) })
        )
      );
      const [authScope, viewerResult, sources] = await Promise.all([
        authScopePromise,
        viewerResultPromise,
        mapWithConcurrency(
          gitRepos,
          GITHUB_SOURCE_CONCURRENCY,
          resolveGitHubRepoSource
        ),
      ]);
      if (cancelled) return;
      const viewerLoginError = viewerResult.error;
      const resolvedSources = sources
        .filter((source): source is GitHubRepoSource => Boolean(source))
        .map((source) => ({
          ...source,
          viewerLogin: viewerResult.login,
          authScope,
        }));
      if (cancelled) return;
      if (!viewerResult.login) {
        permissionViewerRef.current = null;
        resolvedViewerByStore.delete(store);
        retainedLifecycleSnapshots.delete(store, retentionKey);
        loadedRef.current = false;
        setIfChanged(setRepoSources, resolvedSources);
        setIfChanged(setRepoIssueMap, {});
        setIfChanged(setRepoPrMap, {});
        setLoadError(
          viewerLoginError ?? "GitHub viewer identity is unavailable"
        );
        setLoading(false);
        return;
      }
      const viewerChanged =
        permissionViewerRef.current !== null &&
        permissionViewerRef.current !== viewerResult.login;
      if (permissionViewerRef.current !== viewerResult.login) {
        permissionViewerRef.current = viewerResult.login;
      }
      resolvedViewerByStore.set(store, viewerResult.login);
      if (viewerChanged) {
        retainedLifecycleSnapshots.delete(store, retentionKey);
        setIfChanged(setRepoSources, []);
        setIfChanged(setRepoIssueMap, {});
        setIfChanged(setRepoPrMap, {});
      }
      setIfChanged(
        setRepoIssueMap,
        scope === "issue"
          ? Object.fromEntries(
              resolvedSources.map((source) => [
                getRepoIssueMapKey(source),
                getCachedRepoIssues(source),
              ])
            )
          : {}
      );
      setIfChanged(
        setRepoPrMap,
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
        loadedRef.current = true;
        setIfChanged(setRepoSources, []);
        setLoading(false);
        return;
      }
      const sourcesToLoad = selectGitHubLoadSources({
        sources: resolvedSources,
        selectedRepo,
        selectedRepoPath,
        allReposValue,
        currentWorkstationValue,
      });
      const [permissionResults, issueResults, prResults] = await Promise.all([
        mapWithConcurrency(sourcesToLoad, GITHUB_SOURCE_CONCURRENCY, (source) =>
          loadRepoPermissions(
            store,
            source,
            authScope ?? "github.com:unresolved"
          )
        ),
        scope === "issue"
          ? mapWithConcurrency(
              sourcesToLoad,
              GITHUB_SOURCE_CONCURRENCY,
              (source) => loadRepoIssues(source, issueStates, forceRefresh)
            )
          : Promise.resolve([]),
        scope === "pr"
          ? mapWithConcurrency(
              sourcesToLoad.flatMap((source) =>
                prStates.map((state) => ({ source, state }))
              ),
              GITHUB_SOURCE_CONCURRENCY,
              ({ source, state }) => loadRepoPrs(source, state, forceRefresh)
            )
          : Promise.resolve([]),
      ]);
      if (cancelled) return;
      const permissionByRepo = new Map(permissionResults);
      loadedRef.current = true;
      setIfChanged(
        setRepoSources,
        resolvedSources.map((source) => ({
          ...source,
          permissions: permissionByRepo.get(source.repoFullName) ?? null,
        }))
      );
      if (scope === "issue") {
        setRepoIssueMap((current) =>
          mergeRepoIssueLoadResults(current, resolvedSources, issueResults)
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
          return isEqual(current, next) ? current : next;
        });
      }
      setLoadError(
        viewerLoginError ??
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
    allReposValue,
    currentWorkstationValue,
    gitRepos,
    issueStates,
    prStates,
    refreshNonce,
    scope,
    selectedRepo,
    selectedRepoPath,
    store,
    retentionKey,
  ]);

  const updateIssueMap = useCallback(
    (
      update: (
        current: Record<string, RepoIssueState>
      ) => Record<string, RepoIssueState>
    ) =>
      setRepoIssueMap((current) => {
        const next = update(current);
        return isEqual(current, next) ? current : next;
      }),
    []
  );
  const updatePrMap = useCallback(
    (
      update: (
        current: Record<string, RepoPrState>
      ) => Record<string, RepoPrState>
    ) =>
      setRepoPrMap((current) => {
        const next = update(current);
        return isEqual(current, next) ? current : next;
      }),
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
    updatePrMap,
    setListError,
  };
}
