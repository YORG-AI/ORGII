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
import { createLogger } from "@src/hooks/logger";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  addIssueComment,
  closeIssue,
  createIssue,
  fetchIssueComments,
  fetchIssues,
  fetchRepoCollaborators,
  fetchRepoLabels,
  reopenIssue,
  updateIssue,
} from "@src/services/git/operations/githubIssues";
import type {
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueUser,
} from "@src/services/git/operations/githubIssues";
import {
  workstationIssueCallbackAtom,
  workstationIssueListAtom,
  workstationSelectedIssueAtom,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
import type { IssueFilterState } from "@src/store/workstation/codeEditor/workstationIssueAtom";

import {
  getCachedIssues,
  isIssueCacheStale,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "./githubListCache";

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

export function useWorkstationIssues({
  repoPath,
  repoId = "default",
  remoteUrl: remoteUrlProp,
}: UseWorkstationIssuesOptions) {
  const setListState = useSetAtom(workstationIssueListAtom);
  const setSelectedState = useSetAtom(workstationSelectedIssueAtom);
  const setCallbackAtom = useSetAtom(workstationIssueCallbackAtom);

  const selectedState = useAtomValue(workstationSelectedIssueAtom);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Auth / remote URL resolution ──────────────────────────────────────────

  const [resolvedRemoteUrl, setResolvedRemoteUrl] = useState<string | null>(
    null
  );
  // Optimistic auth flag: true when the remote is a GitHub URL.
  // Credentials are resolved Rust-side from connection_token_store — no
  // pre-flight token ping needed. Real auth failures from API calls will
  // flip this to false, matching the trust model used by the PR panel.
  // Track whether we're still waiting for the remote URL to resolve so the
  // panel shows a spinner instead of the empty-state placeholder.
  const [remoteUrlLoading, setRemoteUrlLoading] = useState(true);
  // Set to true when the API returns a re-authorization error so the UI can
  // show a targeted prompt instead of a generic error or empty state.
  const [needsReAuth, setNeedsReAuth] = useState(false);

  const [repoLabels, setRepoLabels] = useState<GitHubIssueLabel[]>([]);
  const [collaborators, setCollaborators] = useState<GitHubIssueUser[]>([]);

  // Resolve origin remote URL if not provided via props
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (remoteUrlProp) {
        logger.debug("remote URL from prop", remoteUrlProp);
        if (!cancelled) {
          setResolvedRemoteUrl(remoteUrlProp);
          setRemoteUrlLoading(false);
        }
        return;
      }
      if (!repoPath) {
        if (!cancelled) setRemoteUrlLoading(false);
        return;
      }

      logger.debug("fetching remotes", { repoPath, repoId });
      try {
        const remotesData = await getGitRemotes({
          repo_id: repoId,
          repo_path: repoPath,
        });
        logger.debug("getGitRemotes result", remotesData);
        const origin = remotesData?.remotes?.find((r) => r.name === "origin");
        logger.debug("origin remote", origin);
        if (!cancelled) {
          if (origin?.url) {
            setResolvedRemoteUrl(origin.url);
          }
          setRemoteUrlLoading(false);
        }
      } catch (err) {
        logger.warn("getGitRemotes failed", err);
        if (!cancelled) setRemoteUrlLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repoPath, repoId, remoteUrlProp]);

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
  const cached = getCachedIssues(repoKey);
  const [openLoadState, setOpenLoadState] = useState<SectionLoadState>(
    cached ? "ready" : "idle"
  );
  const [closedLoadState, setClosedLoadState] = useState<SectionLoadState>(
    cached?.closedIssues.length ? "ready" : "idle"
  );
  const [openIssues, setOpenIssues] = useState<GitHubIssue[]>(
    cached?.openIssues ?? []
  );
  const [closedIssues, setClosedIssues] = useState<GitHubIssue[]>(
    cached?.closedIssues ?? []
  );
  const [openHasMore, setOpenHasMore] = useState(
    (cached?.openIssues.length ?? 0) >= ISSUE_PAGE_SIZE
  );
  const [closedHasMore, setClosedHasMore] = useState(
    (cached?.closedIssues.length ?? 0) >= ISSUE_PAGE_SIZE
  );
  const [openNextPage, setOpenNextPage] = useState<number | null>(
    (cached?.openIssues.length ?? 0) >= ISSUE_PAGE_SIZE ? 2 : null
  );
  const [closedNextPage, setClosedNextPage] = useState<number | null>(
    (cached?.closedIssues.length ?? 0) >= ISSUE_PAGE_SIZE ? 2 : null
  );
  const [openLoadingMore, setOpenLoadingMore] = useState(false);
  const [closedLoadingMore, setClosedLoadingMore] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [closedError, setClosedError] = useState<string | null>(null);

  const handleFetchError = useCallback(
    (
      error: string,
      setError: (e: string | null) => void,
      setLoad: (s: SectionLoadState) => void
    ) => {
      const isReAuth =
        /ReAuthError/i.test(error) || /re-authorization required/i.test(error);
      if (isReAuth) {
        setNeedsReAuth(true);
      } else {
        setError(error);
      }
      setLoad("error");
    },
    [setNeedsReAuth]
  );

  const fetchOpen = useCallback(async () => {
    if (!resolvedRemoteUrl || !hasGitHubAuth) return;
    setOpenLoadState("loading");
    setOpenError(null);
    const result = await fetchIssues(resolvedRemoteUrl, {
      state: "open",
      page: 1,
      perPage: ISSUE_PAGE_SIZE,
    });
    if (!mountedRef.current) return;
    if (result.error) {
      handleFetchError(result.error, setOpenError, setOpenLoadState);
      return;
    }
    const issues = result.data!.issues;
    setOpenIssues(issues);
    setOpenHasMore(result.data!.has_more);
    setOpenNextPage(result.data!.next_page);
    setOpenLoadState("ready");
    updateCachedOpenIssues(repoKey, issues);
  }, [resolvedRemoteUrl, hasGitHubAuth, handleFetchError, repoKey]);

  const fetchClosed = useCallback(async () => {
    if (!resolvedRemoteUrl || !hasGitHubAuth) return;
    setClosedLoadState("loading");
    setClosedError(null);
    const result = await fetchIssues(resolvedRemoteUrl, {
      state: "closed",
      page: 1,
      perPage: ISSUE_PAGE_SIZE,
    });
    if (!mountedRef.current) return;
    if (result.error) {
      handleFetchError(result.error, setClosedError, setClosedLoadState);
      return;
    }
    const issues = result.data!.issues;
    setClosedIssues(issues);
    setClosedHasMore(result.data!.has_more);
    setClosedNextPage(result.data!.next_page);
    setClosedLoadState("ready");
    updateCachedClosedIssues(repoKey, issues);
  }, [resolvedRemoteUrl, hasGitHubAuth, handleFetchError, repoKey]);

  const loadMoreOpen = useCallback(async () => {
    if (!resolvedRemoteUrl || !hasGitHubAuth || !openHasMore || !openNextPage)
      return;
    setOpenLoadingMore(true);
    setOpenError(null);
    const result = await fetchIssues(resolvedRemoteUrl, {
      state: "open",
      page: openNextPage,
      perPage: ISSUE_PAGE_SIZE,
    });
    if (!mountedRef.current) return;
    setOpenLoadingMore(false);
    if (result.error) {
      handleFetchError(result.error, setOpenError, setOpenLoadState);
      return;
    }
    setOpenIssues((current) => {
      const issues = mergeUniqueIssues(current, result.data!.issues);
      updateCachedOpenIssues(repoKey, issues);
      return issues;
    });
    setOpenHasMore(result.data!.has_more);
    setOpenNextPage(result.data!.next_page);
  }, [
    resolvedRemoteUrl,
    hasGitHubAuth,
    openHasMore,
    openNextPage,
    handleFetchError,
    repoKey,
  ]);

  const loadMoreClosed = useCallback(async () => {
    if (
      !resolvedRemoteUrl ||
      !hasGitHubAuth ||
      !closedHasMore ||
      !closedNextPage
    )
      return;
    setClosedLoadingMore(true);
    setClosedError(null);
    const result = await fetchIssues(resolvedRemoteUrl, {
      state: "closed",
      page: closedNextPage,
      perPage: ISSUE_PAGE_SIZE,
    });
    if (!mountedRef.current) return;
    setClosedLoadingMore(false);
    if (result.error) {
      handleFetchError(result.error, setClosedError, setClosedLoadState);
      return;
    }
    setClosedIssues((current) => {
      const issues = mergeUniqueIssues(current, result.data!.issues);
      updateCachedClosedIssues(repoKey, issues);
      return issues;
    });
    setClosedHasMore(result.data!.has_more);
    setClosedNextPage(result.data!.next_page);
  }, [
    resolvedRemoteUrl,
    hasGitHubAuth,
    closedHasMore,
    closedNextPage,
    handleFetchError,
    repoKey,
  ]);

  // Fetch open issues on mount / auth ready.
  // Skip the network hit when the cache is still fresh (< 5 min) — the UI
  // already shows cached rows so there's no spinner flash on re-entry.
  // Deferred via setTimeout to avoid synchronous setState inside effect body.
  useEffect(() => {
    if (!resolvedRemoteUrl || !hasGitHubAuth) return;
    if (!isIssueCacheStale(repoKey)) return;
    const timer = setTimeout(() => void fetchOpen(), 0);
    return () => clearTimeout(timer);
  }, [resolvedRemoteUrl, hasGitHubAuth, fetchOpen, repoKey]);

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

  // Fetch repo labels + collaborators once auth is available
  useEffect(() => {
    if (!resolvedRemoteUrl || !hasGitHubAuth) return;
    let cancelled = false;

    void (async () => {
      const [labelsResult, collabResult] = await Promise.all([
        fetchRepoLabels(resolvedRemoteUrl),
        fetchRepoCollaborators(resolvedRemoteUrl),
      ]);
      if (cancelled) return;
      if (labelsResult.data) setRepoLabels(labelsResult.data);
      if (collabResult.data) setCollaborators(collabResult.data);
    })();

    return () => {
      cancelled = true;
    };
  }, [resolvedRemoteUrl, hasGitHubAuth]);

  // ── Issue selection ───────────────────────────────────────────────────────

  const selectIssue = useCallback(
    (issue: GitHubIssue | null) => {
      if (!issue) {
        setSelectedState((prev) => ({ ...prev, issue: null, comments: [] }));
        return;
      }
      setSelectedState((prev) => ({
        ...prev,
        issue,
        comments: [],
        commentsLoading: true,
      }));

      if (!resolvedRemoteUrl) return;
      void (async () => {
        const result = await fetchIssueComments({
          remoteUrl: resolvedRemoteUrl,
          issueNumber: issue.number,
        });
        if (!mountedRef.current) return;
        if (result.data) {
          setSelectedState((prev) => ({
            ...prev,
            comments: result.data!,
            commentsLoading: false,
          }));
        } else {
          setSelectedState((prev) => ({
            ...prev,
            commentsLoading: false,
          }));
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
          comments: [...prev.comments, result.data!],
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
        comments: [],
        loading: false,
        commentsLoading: false,
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
    (list: GitHubIssue[]) => {
      if (!debouncedSearch.trim()) return list;
      const q = debouncedSearch.toLowerCase();
      return list.filter(
        (issue) =>
          issue.title.toLowerCase().includes(q) ||
          issue.labels.some((l) => l.name.toLowerCase().includes(q)) ||
          issue.user.login.toLowerCase().includes(q)
      );
    },
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
    comments: selectedState.comments,
    commentsLoading: selectedState.commentsLoading,
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
