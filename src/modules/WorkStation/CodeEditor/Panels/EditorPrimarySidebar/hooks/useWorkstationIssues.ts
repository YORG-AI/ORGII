/**
 * useWorkstationIssues
 *
 * Core data layer for the GitHub Issues panel in the workstation sidebar.
 * Owns fetch/create/update/close/reopen/comment logic, writes to
 * workstationIssueListAtom and workstationSelectedIssueAtom, and exposes
 * stable callbacks that the UI components consume.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import {
  getCachedIssues,
  isIssueCacheStale,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  addIssueComment,
  closeIssue,
  createIssue,
  fetchIssueTimeline,
  fetchIssues,
  fetchRepoCollaborators,
  fetchRepoLabels,
  issueCommentToTimelineItem,
  reopenIssue,
  updateIssue,
} from "@src/services/git/operations/githubIssues";
import type {
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueUser,
} from "@src/services/git/operations/githubIssues";
import {
  workstationIssueCallbackAtomFamily,
  workstationIssueListAtomFamily,
  workstationSelectedIssueAtomFamily,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
import type { IssueFilterState } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import { LatestScopedTask } from "@src/util/core/latestScopedTask";

import { filterIssuesByQuery } from "./workstationIssueHelpers";

export type { IssueFilterState };

const logger = createLogger("WorkstationIssues");
const ISSUE_PAGE_SIZE = 50;

export interface UpdateIssueFields {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface UseWorkstationIssuesOptions {
  repoPath: string;
  repoId?: string;
  branchName?: string;
  remoteUrl?: string;
}

function mergeUniqueIssues(
  existingIssues: GitHubIssue[],
  incomingIssues: GitHubIssue[]
): GitHubIssue[] {
  const seenIssueNumbers = new Set(existingIssues.map((issue) => issue.number));
  return [
    ...existingIssues,
    ...incomingIssues.filter((issue) => !seenIssueNumbers.has(issue.number)),
  ];
}

interface IssueSectionData {
  hasMore: boolean;
  issues: GitHubIssue[];
  nextPage: number | null;
}

interface IssueSectionScope {
  remoteUrl: string;
  repoKey: string;
  state: "closed" | "open";
}

interface PaginationState {
  error: string | null;
  scopeKey: string | null;
  status: "error" | "idle" | "loading";
}

interface IssueRepoMetadata {
  collaborators: GitHubIssueUser[];
  labels: GitHubIssueLabel[];
}

const EMPTY_PAGINATION_STATE: PaginationState = {
  error: null,
  scopeKey: null,
  status: "idle",
};
const EMPTY_ISSUE_REPO_METADATA: IssueRepoMetadata = {
  collaborators: [],
  labels: [],
};

export function useWorkstationIssues({
  repoPath,
  repoId,
  remoteUrl: remoteUrlProp,
}: UseWorkstationIssuesOptions) {
  const apiRepoId = repoId ?? "default";
  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const setListState = useSetAtom(workstationIssueListAtomFamily(scopeKey));
  const setSelectedState = useSetAtom(
    workstationSelectedIssueAtomFamily(scopeKey)
  );
  const setCallbackAtom = useSetAtom(
    workstationIssueCallbackAtomFamily(scopeKey)
  );

  const selectedState = useAtomValue(
    workstationSelectedIssueAtomFamily(scopeKey)
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Auth / remote URL resolution ──────────────────────────────────────────

  // Optimistic auth flag: true when the remote is a GitHub URL.
  // Credentials are resolved Rust-side from connection_token_store — no
  // pre-flight token ping needed. Real auth failures from API calls will
  // flip this to false, matching the trust model used by the PR panel.
  // Track whether we're still waiting for the remote URL to resolve so the
  // panel shows a spinner instead of the empty-state placeholder.
  // Set to true when the API returns a re-authorization error so the UI can
  // show a targeted prompt instead of a generic error or empty state.
  const [reAuthScopeKey, setReAuthScopeKey] = useState<string | null>(null);

  const remoteScopeKey = JSON.stringify({
    apiRepoId,
    remoteUrl: remoteUrlProp ?? null,
    repoPath,
  });
  const resolveRemoteUrl = useCallback(async (serializedScope: string) => {
    const scope = JSON.parse(serializedScope) as {
      apiRepoId: string;
      remoteUrl: string | null;
      repoPath: string;
    };
    if (scope.remoteUrl) {
      logger.debug("remote URL from prop", scope.remoteUrl);
      return scope.remoteUrl;
    }
    if (!scope.repoPath) return null;

    logger.debug("fetching remotes", {
      repoPath: scope.repoPath,
      repoId: scope.apiRepoId,
    });
    try {
      const remotesData = await getGitRemotes({
        repo_id: scope.apiRepoId,
        repo_path: scope.repoPath,
      });
      const origin = remotesData?.remotes?.find(
        (remote) => remote.name === "origin"
      );
      logger.debug("origin remote", origin);
      return origin?.url ?? null;
    } catch (error) {
      logger.warn("getGitRemotes failed", error);
      return null;
    }
  }, []);
  const remoteResource = useAsyncResource<string | null>({
    fetcher: resolveRemoteUrl,
    initialData: null,
    scopeKey: remoteScopeKey,
  });
  const resolvedRemoteUrl = remoteResource.data;
  const remoteUrlLoading = remoteResource.loading;

  // Optimistically true when the remote resolves to a GitHub URL.
  // A valid GitHub URL means credentials should be available via
  // connection_token_store — no need for a separate /user ping.
  const hasGitHubAuth = useMemo(() => {
    if (!resolvedRemoteUrl) return false;
    const repoFullName = parseGithubRepoFullName(resolvedRemoteUrl);
    logger.debug("resolved remote URL", { resolvedRemoteUrl, repoFullName });
    return !!repoFullName;
  }, [resolvedRemoteUrl]);

  // Stable cache key — use repoPath so it survives workspace switches
  const repoKey = repoPath;

  // ── Search debounce ───────────────────────────────────────────────────────

  const [searchQuery, setSearchQuery] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const handleSetSearchQuery = useCallback((q: string) => {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(q);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // ── Separate open / closed fetch state ───────────────────────────────────

  type SectionLoadState = "idle" | "loading" | "ready" | "error";

  // Seed from cache immediately so the list shows on re-entry without a spinner
  const cached = useMemo(() => getCachedIssues(repoKey), [repoKey]);
  const openCacheStale = useMemo(() => isIssueCacheStale(repoKey), [repoKey]);
  const closedCacheReady = useMemo(
    () =>
      Boolean(cached?.closedIssues.length) &&
      !isIssueCacheStale(repoKey, "closed"),
    [cached, repoKey]
  );
  const openInitialData = useMemo<IssueSectionData>(
    () => ({
      hasMore: (cached?.openIssues.length ?? 0) >= ISSUE_PAGE_SIZE,
      issues: cached?.openIssues ?? [],
      nextPage: (cached?.openIssues.length ?? 0) >= ISSUE_PAGE_SIZE ? 2 : null,
    }),
    [cached]
  );
  const closedInitialData = useMemo<IssueSectionData>(
    () => ({
      hasMore: (cached?.closedIssues.length ?? 0) >= ISSUE_PAGE_SIZE,
      issues: cached?.closedIssues ?? [],
      nextPage:
        (cached?.closedIssues.length ?? 0) >= ISSUE_PAGE_SIZE ? 2 : null,
    }),
    [cached]
  );

  const openScopeKey = useMemo(
    () =>
      resolvedRemoteUrl && hasGitHubAuth
        ? JSON.stringify({
            remoteUrl: resolvedRemoteUrl,
            repoKey,
            state: "open",
          } satisfies IssueSectionScope)
        : null,
    [hasGitHubAuth, repoKey, resolvedRemoteUrl]
  );
  const closedScopeKey = useMemo(
    () =>
      resolvedRemoteUrl && hasGitHubAuth
        ? JSON.stringify({
            remoteUrl: resolvedRemoteUrl,
            repoKey,
            state: "closed",
          } satisfies IssueSectionScope)
        : null,
    [hasGitHubAuth, repoKey, resolvedRemoteUrl]
  );
  const needsReAuth =
    reAuthScopeKey === openScopeKey || reAuthScopeKey === closedScopeKey;

  const fetchIssueSection = useCallback(
    async (
      serializedScope: string,
      context: AsyncResourceFetchContext<IssueSectionData>
    ) => {
      const scope = JSON.parse(serializedScope) as IssueSectionScope;
      const result = await fetchIssues(scope.remoteUrl, {
        state: scope.state,
        page: 1,
        perPage: ISSUE_PAGE_SIZE,
      });
      if (result.error) {
        const isReAuth =
          /ReAuthError/i.test(result.error) ||
          /re-authorization required/i.test(result.error);
        if (isReAuth && context.isCurrent()) {
          setReAuthScopeKey(serializedScope);
        }
        throw new Error(result.error);
      }
      const data = {
        hasMore: result.data!.has_more,
        issues: result.data!.issues,
        nextPage: result.data!.next_page,
      };
      if (context.isCurrent()) {
        if (scope.state === "open") {
          updateCachedOpenIssues(scope.repoKey, data.issues);
        } else {
          updateCachedClosedIssues(scope.repoKey, data.issues);
        }
      }
      return data;
    },
    []
  );

  const openResource = useAsyncResource({
    autoLoad: Boolean(openScopeKey) && openCacheStale,
    enabled: Boolean(openScopeKey),
    fetcher: fetchIssueSection,
    initialData: openInitialData,
    initialStatus: cached ? "ready" : "idle",
    scopeKey: openScopeKey,
  });
  const closedResource = useAsyncResource({
    autoLoad: false,
    enabled: Boolean(closedScopeKey),
    fetcher: fetchIssueSection,
    initialData: closedInitialData,
    initialStatus: closedCacheReady ? "ready" : "idle",
    scopeKey: closedScopeKey,
  });

  const {
    data: openData,
    error: openResourceError,
    refresh: fetchOpen,
    setData: setOpenData,
    status: openResourceStatus,
  } = openResource;
  const {
    data: closedData,
    error: closedResourceError,
    refresh: fetchClosed,
    setData: setClosedData,
    status: closedResourceStatus,
  } = closedResource;
  const [openPagination, setOpenPagination] = useState<PaginationState>(
    EMPTY_PAGINATION_STATE
  );
  const [closedPagination, setClosedPagination] = useState<PaginationState>(
    EMPTY_PAGINATION_STATE
  );
  const openPageCoordinator = useMemo(() => new LatestScopedTask(), []);
  const closedPageCoordinator = useMemo(() => new LatestScopedTask(), []);

  useEffect(() => {
    openPageCoordinator.supersede();
    return () => openPageCoordinator.supersede();
  }, [openPageCoordinator, openScopeKey]);
  useEffect(() => {
    closedPageCoordinator.supersede();
    return () => closedPageCoordinator.supersede();
  }, [closedPageCoordinator, closedScopeKey]);

  const loadMoreOpen = useCallback(async () => {
    if (!openScopeKey || !openData.hasMore || !openData.nextPage) return;
    const scope = JSON.parse(openScopeKey) as IssueSectionScope;
    await openPageCoordinator.run(
      `${openScopeKey}:${openData.nextPage}`,
      async (context) => {
        setOpenPagination({
          error: null,
          scopeKey: openScopeKey,
          status: "loading",
        });
        const result = await fetchIssues(scope.remoteUrl, {
          state: "open",
          page: openData.nextPage!,
          perPage: ISSUE_PAGE_SIZE,
        });
        if (!context.isCurrent()) return;
        if (result.error) {
          const isReAuth =
            /ReAuthError/i.test(result.error) ||
            /re-authorization required/i.test(result.error);
          if (isReAuth) setReAuthScopeKey(openScopeKey);
          setOpenPagination({
            error: isReAuth ? null : result.error,
            scopeKey: openScopeKey,
            status: "error",
          });
          return;
        }
        setOpenData((current) => {
          const issues = mergeUniqueIssues(current.issues, result.data!.issues);
          updateCachedOpenIssues(scope.repoKey, issues);
          return {
            hasMore: result.data!.has_more,
            issues,
            nextPage: result.data!.next_page,
          };
        });
        setOpenPagination({
          error: null,
          scopeKey: openScopeKey,
          status: "idle",
        });
      }
    );
  }, [openData, openPageCoordinator, openScopeKey, setOpenData]);

  const loadMoreClosed = useCallback(async () => {
    if (!closedScopeKey || !closedData.hasMore || !closedData.nextPage) return;
    const scope = JSON.parse(closedScopeKey) as IssueSectionScope;
    await closedPageCoordinator.run(
      `${closedScopeKey}:${closedData.nextPage}`,
      async (context) => {
        setClosedPagination({
          error: null,
          scopeKey: closedScopeKey,
          status: "loading",
        });
        const result = await fetchIssues(scope.remoteUrl, {
          state: "closed",
          page: closedData.nextPage!,
          perPage: ISSUE_PAGE_SIZE,
        });
        if (!context.isCurrent()) return;
        if (result.error) {
          const isReAuth =
            /ReAuthError/i.test(result.error) ||
            /re-authorization required/i.test(result.error);
          if (isReAuth) setReAuthScopeKey(closedScopeKey);
          setClosedPagination({
            error: isReAuth ? null : result.error,
            scopeKey: closedScopeKey,
            status: "error",
          });
          return;
        }
        setClosedData((current) => {
          const issues = mergeUniqueIssues(current.issues, result.data!.issues);
          updateCachedClosedIssues(scope.repoKey, issues);
          return {
            hasMore: result.data!.has_more,
            issues,
            nextPage: result.data!.next_page,
          };
        });
        setClosedPagination({
          error: null,
          scopeKey: closedScopeKey,
          status: "idle",
        });
      }
    );
  }, [closedData, closedPageCoordinator, closedScopeKey, setClosedData]);

  const openLoadState: SectionLoadState =
    openResourceStatus === "refreshing" ? "loading" : openResourceStatus;
  const closedLoadState: SectionLoadState =
    closedResourceStatus === "refreshing" ? "loading" : closedResourceStatus;
  const openIssues = openData.issues;
  const closedIssues = closedData.issues;
  const openHasMore = openData.hasMore;
  const closedHasMore = closedData.hasMore;
  const openLoadingMore =
    openPagination.scopeKey === openScopeKey &&
    openPagination.status === "loading";
  const closedLoadingMore =
    closedPagination.scopeKey === closedScopeKey &&
    closedPagination.status === "loading";
  const openError = needsReAuth
    ? null
    : (openResourceError ??
      (openPagination.scopeKey === openScopeKey ? openPagination.error : null));
  const closedError = needsReAuth
    ? null
    : (closedResourceError ??
      (closedPagination.scopeKey === closedScopeKey
        ? closedPagination.error
        : null));

  const refresh = useCallback(() => {
    void fetchOpen();
    if (closedLoadState === "ready") void fetchClosed();
  }, [fetchOpen, fetchClosed, closedLoadState]);

  // Keep the shared atom in sync (used by external consumers like agent callbacks)
  useEffect(() => {
    const combined = [...openIssues, ...closedIssues];
    setListState((prev) => ({
      ...prev,
      issues: combined,
      loading: openLoadState === "loading",
      error: openError,
    }));
  }, [openIssues, closedIssues, openLoadState, openError, setListState]);

  // Keep legacy filterState around so mutation callbacks that reference it compile
  const filterState: IssueFilterState = "all";
  const setFilterState = (_: IssueFilterState) => {
    /* no-op — UI no longer drives this */
  };

  // Refetch on debounced search change (client-side filter applied in UI)
  // Search filtering is done client-side via filterIssuesByQuery helper

  const fetchRepoMetadata = useCallback(async (remoteUrl: string) => {
    const [labelsResult, collaboratorsResult] = await Promise.all([
      fetchRepoLabels(remoteUrl),
      fetchRepoCollaborators(remoteUrl),
    ]);
    return {
      collaborators: collaboratorsResult.data ?? [],
      labels: labelsResult.data ?? [],
    };
  }, []);
  const repoMetadataResource = useAsyncResource({
    enabled: Boolean(resolvedRemoteUrl && hasGitHubAuth),
    fetcher: fetchRepoMetadata,
    initialData: EMPTY_ISSUE_REPO_METADATA,
    scopeKey: resolvedRemoteUrl && hasGitHubAuth ? resolvedRemoteUrl : null,
  });
  const repoLabels = repoMetadataResource.data.labels;
  const collaborators = repoMetadataResource.data.collaborators;

  // ── Issue selection ───────────────────────────────────────────────────────

  const selectIssue = useCallback(
    (issue: GitHubIssue | null) => {
      if (!issue) {
        setSelectedState((prev) => ({ ...prev, issue: null, timeline: [] }));
        return;
      }
      setSelectedState((prev) => ({
        ...prev,
        issue,
        timeline: [],
        timelineLoading: true,
      }));

      if (!resolvedRemoteUrl) {
        setSelectedState((prev) =>
          prev.issue?.number === issue.number
            ? { ...prev, timelineLoading: false }
            : prev
        );
        return;
      }
      void (async () => {
        const result = await fetchIssueTimeline({
          remoteUrl: resolvedRemoteUrl,
          issueNumber: issue.number,
        });
        if (!mountedRef.current) return;
        if (result.data) {
          setSelectedState((prev) =>
            prev.issue?.number === issue.number
              ? {
                  ...prev,
                  timeline: result.data!,
                  timelineLoading: false,
                }
              : prev
          );
        } else {
          setSelectedState((prev) =>
            prev.issue?.number === issue.number
              ? { ...prev, timelineLoading: false }
              : prev
          );
        }
      })();
    },
    [resolvedRemoteUrl, setSelectedState]
  );

  // ── Mutations ─────────────────────────────────────────────────────────────

  const handleCreateIssue = useCallback(
    async (
      title: string,
      body?: string,
      labels?: string[],
      assignees?: string[]
    ): Promise<GitHubIssue | null> => {
      if (!resolvedRemoteUrl) return null;
      const result = await createIssue({
        remoteUrl: resolvedRemoteUrl,
        title,
        body,
        labels,
        assignees,
      });
      if (result.data && mountedRef.current) {
        setListState((prev) => ({
          ...prev,
          issues: [result.data!, ...prev.issues],
        }));
        return result.data;
      }
      return null;
    },
    [resolvedRemoteUrl, setListState]
  );

  const handleUpdateIssue = useCallback(
    async (number: number, fields: UpdateIssueFields): Promise<void> => {
      if (!resolvedRemoteUrl) return;
      const result = await updateIssue({
        remoteUrl: resolvedRemoteUrl,
        issueNumber: number,
        updates: fields,
      });
      if (result.data && mountedRef.current) {
        const updated = result.data;
        setListState((prev) => ({
          ...prev,
          issues: prev.issues.map((i) => (i.number === number ? updated : i)),
        }));
        setSelectedState((prev) =>
          prev.issue?.number === number ? { ...prev, issue: updated } : prev
        );
      }
    },
    [resolvedRemoteUrl, setListState, setSelectedState]
  );

  const handleCloseIssue = useCallback(
    async (number: number): Promise<void> => {
      if (!resolvedRemoteUrl) return;
      const result = await closeIssue({
        remoteUrl: resolvedRemoteUrl,
        issueNumber: number,
      });
      if (result.data && mountedRef.current) {
        const updated = result.data;
        setListState((prev) => ({
          ...prev,
          issues: prev.issues.map((i) => (i.number === number ? updated : i)),
        }));
        setSelectedState((prev) =>
          prev.issue?.number === number ? { ...prev, issue: updated } : prev
        );
      }
    },
    [resolvedRemoteUrl, setListState, setSelectedState]
  );

  const handleReopenIssue = useCallback(
    async (number: number): Promise<void> => {
      if (!resolvedRemoteUrl) return;
      const result = await reopenIssue({
        remoteUrl: resolvedRemoteUrl,
        issueNumber: number,
      });
      if (result.data && mountedRef.current) {
        const updated = result.data;
        setListState((prev) => ({
          ...prev,
          issues: prev.issues.map((i) => (i.number === number ? updated : i)),
        }));
        setSelectedState((prev) =>
          prev.issue?.number === number ? { ...prev, issue: updated } : prev
        );
      }
    },
    [resolvedRemoteUrl, setListState, setSelectedState]
  );

  const handleAddComment = useCallback(
    async (number: number, body: string): Promise<void> => {
      if (!resolvedRemoteUrl) return;
      setSelectedState((prev) => ({ ...prev, submittingComment: true }));
      const result = await addIssueComment({
        remoteUrl: resolvedRemoteUrl,
        issueNumber: number,
        body,
      });
      if (!mountedRef.current) return;
      if (result.data) {
        setSelectedState((prev) => ({
          ...prev,
          timeline: [
            ...prev.timeline,
            issueCommentToTimelineItem(result.data!),
          ],
          submittingComment: false,
        }));
        setListState((prev) => ({
          ...prev,
          issues: prev.issues.map((i) =>
            i.number === number ? { ...i, comments: i.comments + 1 } : i
          ),
        }));
      } else {
        setSelectedState((prev) => ({ ...prev, submittingComment: false }));
      }
    },
    [resolvedRemoteUrl, setSelectedState, setListState]
  );

  // ── Expose openNewIssueForm callback ──────────────────────────────────────
  // This is populated by IssuesContent once it mounts; the atom acts as a
  // shared signal so PinnedActionsBar / agents can trigger it externally.

  // Clean up atoms on unmount
  useEffect(() => {
    return () => {
      if (!mountedRef.current) return;
      setListState({
        issues: [],
        loading: false,
        error: null,
        filter: "open",
        labelFilter: "",
        searchQuery: "",
        page: 1,
        hasMore: false,
      });
      setSelectedState({
        issue: null,
        timeline: [],
        loading: false,
        timelineLoading: false,
        error: null,
        submittingComment: false,
      });
      setCallbackAtom({
        openNewIssueForm: null,
        closeIssue: null,
        reopenIssue: null,
        addComment: null,
        refreshIssues: null,
      });
    };
  }, [setListState, setSelectedState, setCallbackAtom]);

  // ── Derived values ────────────────────────────────────────────────────────

  const applySearch = useCallback(
    (list: GitHubIssue[]) => filterIssuesByQuery(list, debouncedSearch),
    [debouncedSearch]
  );

  const filteredOpen = useMemo(
    () => applySearch(openIssues),
    [openIssues, applySearch]
  );
  const filteredClosed = useMemo(
    () => applySearch(closedIssues),
    [closedIssues, applySearch]
  );

  return {
    // Per-section data
    openIssues: filteredOpen,
    closedIssues: filteredClosed,
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
    // Legacy combined — kept for atom sync / mutation callbacks
    issues: useMemo(
      () => applySearch([...openIssues, ...closedIssues]),
      [openIssues, closedIssues, applySearch]
    ),
    loading: openLoadState === "loading",
    remoteUrlLoading,
    needsReAuth,
    error: openError,
    filterState,
    setFilterState,
    searchQuery,
    setSearchQuery: handleSetSearchQuery,
    selectedIssue: selectedState.issue,
    selectIssue,
    timeline: selectedState.timeline,
    timelineLoading: selectedState.timelineLoading,
    submittingComment: selectedState.submittingComment,
    handleCreateIssue,
    handleUpdateIssue,
    handleCloseIssue,
    handleReopenIssue,
    handleAddComment,
    refresh,
    repoLabels,
    collaborators,
    hasGitHubAuth,
  };
}
