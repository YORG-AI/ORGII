import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createIssueCommentLocal,
  getGitHubRepoPermissionsLocal,
  getGitHubViewerLogin,
  getIssueLocal,
  listIssueTimelineLocal,
  listIssuesLocal,
  listRepoAssigneesLocal,
  updateIssueLocal,
} from "@src/api/tauri/github";
import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
  GitHubIssueUser,
  GitHubRepoPermissions,
} from "@src/api/tauri/github";
import type {
  GitHubIssueInteractionConfig,
  GitHubIssueStatusChangeOptions,
} from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";
import type { WorkItemExternalAssigneeConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import {
  issueHasAssigneeLogins,
  resolveGitHubAssigneeUsers,
} from "@src/modules/shared/githubIssueAssignees";
import {
  githubIssueResourceKey,
  invalidateGitHubIssueDetailBundle,
  invalidateGitHubIssueTimeline,
  loadGitHubAssignableUsers,
  loadGitHubDetailAuthScope,
  loadGitHubDuplicateCandidates,
  loadGitHubIssueDetailBundle,
  loadGitHubIssueTimeline,
  loadGitHubRepoPermissions,
  loadGitHubViewer,
  primeGitHubIssueDetailBundle,
  primeGitHubIssueTimeline,
  primeGitHubRepoPermissions,
  primeGitHubViewer,
} from "@src/modules/shared/githubIssueDetailCoordinator";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  fetchIssue,
  fetchIssueTimeline,
  issueCommentToTimelineItem,
} from "@src/services/git/operations/githubIssues";
import {
  retainWorkstationIssueDetailScope,
  workstationIssueCallbackAtomFamily,
  workstationSelectedIssueAtomFamily,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";

/**
 * Reported when a request settled without an issue and the failing call left no
 * message of its own — an unresolvable repository, or auth-scope resolution
 * that failed before any request could be keyed.
 */
export const GITHUB_ISSUE_UNAVAILABLE_ERROR = "github_issue_unavailable";

/** Reported when the detail request outlived its deadline without settling. */
export const GITHUB_ISSUE_TIMEOUT_ERROR = "github_issue_request_timeout";

/**
 * Deadline for one issue-detail read. A transport that never settles is
 * indistinguishable from a slow one, so without a bound the surface waits on a
 * skeleton forever and can never explain itself. The underlying request is not
 * cancellable and keeps running — if it does finish, it still populates the
 * shared cache for the next attempt.
 */
const ISSUE_DETAIL_REQUEST_TIMEOUT_MS = 30_000;

function withDeadline<T>(
  request: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

export interface GitHubIssueDetailStateOptions {
  /** Omit for repo-scoped Source Control, which already owns the selection. */
  issueNumber?: number;
  repoPath: string;
  repoId?: string;
  remoteUrl?: string;
  stateScopeKey?: string;
  /** Identity-scoped list data can provide these to skip duplicate requests. */
  authScope?: string;
  viewerLogin?: string | null;
  repoPermissions?: GitHubRepoPermissions | null;
}

interface GitHubIssueInteractionResolution {
  key: string;
  viewer: GitHubIssueUser | null;
  permissions: GitHubRepoPermissions | null;
  duplicateCandidates: GitHubIssue[];
  duplicateCandidatesLoaded: boolean;
  loadingDuplicateCandidates: boolean;
  duplicateCandidatesError: boolean;
  assignableUsers: GitHubIssueUser[];
  assignableUsersLoaded: boolean;
  loadingAssignableUsers: boolean;
  assigneesError: string | null;
  submittingComment: boolean;
  updatingBody: boolean;
  updatingStatus: boolean;
  updatingAssignees: boolean;
  error: GitHubIssueInteractionConfig["error"];
}

function sameLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function resolveViewer(
  login: string,
  issue: GitHubIssue | null,
  timeline: GitHubIssueTimelineItem[]
): GitHubIssueUser {
  const knownUsers = [
    issue?.user,
    ...(issue?.assignees ?? []),
    ...timeline.map((item) => item.actor),
  ].filter((user): user is GitHubIssueUser => Boolean(user));
  const knownViewer = knownUsers.find((user) => sameLogin(user.login, login));

  return (
    knownViewer ?? {
      login,
      avatar_url: `https://github.com/${encodeURIComponent(login)}.png?size=64`,
    }
  );
}

function isRepoFullName(value: string | null): value is string {
  return Boolean(value && /^[^/:@\s]+\/[^/\s]+$/.test(value));
}

export function resolveGitHubIssueRepoFullName(
  remoteUrl: string | undefined,
  issueUrl: string | undefined
): string | null {
  if (isRepoFullName(remoteUrl ?? null)) return remoteUrl ?? null;
  const remoteRepo = remoteUrl ? parseGithubRepoFullName(remoteUrl) : null;
  if (isRepoFullName(remoteRepo)) return remoteRepo;

  if (!issueUrl) return null;
  try {
    const url = new URL(issueUrl);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, repo, kind] = url.pathname.split("/").filter(Boolean);
    return owner && repo && kind === "issues" ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

function canEditIssue(
  resolution: GitHubIssueInteractionResolution | null,
  issue: GitHubIssue | null
): boolean {
  return (
    resolution?.permissions?.can_manage_issues === true ||
    Boolean(
      issue &&
      resolution?.viewer &&
      sameLogin(issue.user.login, resolution.viewer.login)
    )
  );
}

/** Shared issue-detail state and Inbox-style interactions for every host. */
export function useGitHubIssueDetailState({
  issueNumber: requestedIssueNumber,
  repoPath,
  repoId,
  remoteUrl,
  stateScopeKey: requestedStateScopeKey,
  authScope: providedAuthScope,
  viewerLogin: providedViewerLogin,
  repoPermissions: providedRepoPermissions,
}: GitHubIssueDetailStateOptions) {
  const store = useStore();
  const repoScopeKey = workstationRepoScopeKey(repoId, repoPath);
  const stateScopeKey = requestedStateScopeKey ?? repoScopeKey;
  const selectedState = useAtomValue(
    workstationSelectedIssueAtomFamily(stateScopeKey)
  );
  const issueNumber = requestedIssueNumber ?? selectedState.issue?.number ?? 0;
  const callbacks = useAtomValue(
    workstationIssueCallbackAtomFamily(repoScopeKey)
  );
  const setSelectedState = useSetAtom(
    workstationSelectedIssueAtomFamily(stateScopeKey)
  );
  const [resolution, setResolution] =
    useState<GitHubIssueInteractionResolution | null>(null);
  const authResolutionKey = `${repoPath}|${remoteUrl ?? ""}`;
  const [resolvedAuth, setResolvedAuth] = useState<{
    key: string;
    scope: string | null;
  } | null>(null);
  const authScope =
    providedAuthScope ??
    (resolvedAuth?.key === authResolutionKey ? resolvedAuth.scope : null);
  /**
   * Auth-scope resolution has produced an answer for this repository — either a
   * scope or a definitive failure. Until it has, a missing scope is pending
   * rather than terminal.
   */
  const authScopeResolved =
    providedAuthScope !== undefined || resolvedAuth?.key === authResolutionKey;
  const selectedIssueRef = useRef(selectedState.issue);
  const selectedTimelineRef = useRef(selectedState.timeline);
  const requestGenerationRef = useRef(0);
  const assigneeMutationRef = useRef<{
    key: string;
    generation: number;
  } | null>(null);

  useEffect(() => {
    selectedIssueRef.current = selectedState.issue;
    selectedTimelineRef.current = selectedState.timeline;
  }, [selectedState.issue, selectedState.timeline]);

  useEffect(() => {
    // Repo-scoped Source Control state owns the user's current selection and
    // must survive switching editor panes. Standalone detail scopes are
    // disposable and otherwise grow the primitive-key atom family forever.
    const preserveSelection = stateScopeKey === repoScopeKey;
    const release = retainWorkstationIssueDetailScope(stateScopeKey, {
      evictOnFinalRelease: !preserveSelection,
    });
    return () => {
      if (release() && preserveSelection) {
        // The issue remains selected for the next Source Control visit, but
        // the potentially large timeline has a bounded mounted lifetime.
        setSelectedState((current) => ({
          ...current,
          resourceKey: null,
          timeline: [],
          timelineLoading: false,
        }));
      }
    };
  }, [repoScopeKey, setSelectedState, stateScopeKey]);

  useEffect(() => {
    if (providedAuthScope || (!repoPath && !remoteUrl)) return;
    let cancelled = false;
    void loadGitHubDetailAuthScope(store)
      .then((scope) => {
        if (!cancelled) setResolvedAuth({ key: authResolutionKey, scope });
      })
      .catch(() => {
        if (!cancelled)
          setResolvedAuth({ key: authResolutionKey, scope: null });
      });
    return () => {
      cancelled = true;
    };
  }, [authResolutionKey, providedAuthScope, remoteUrl, repoPath, store]);

  const repoFullName = resolveGitHubIssueRepoFullName(
    remoteUrl,
    selectedState.issue?.html_url
  );
  const requestKey =
    authScope && repoFullName && issueNumber > 0
      ? githubIssueResourceKey(authScope, repoFullName, issueNumber)
      : null;
  const selectedStateMatches =
    Boolean(requestKey) &&
    selectedState.resourceKey === requestKey &&
    selectedState.issue?.number === issueNumber;
  const currentResolution = resolution?.key === requestKey ? resolution : null;
  /**
   * A host that names its own issue has three outcomes, not two: the request is
   * still running, it settled with the issue, or it settled without one — a
   * failed fetch, an unresolvable repository, or auth-scope resolution that
   * failed outright. Only the first is loading. Folding the third into
   * "loading" strands every consumer on a skeleton that never resolves and
   * erases the error that explains it, so keep the outcomes separable here.
   */
  const ownsRequestedIssue = Boolean(requestedIssueNumber && remoteUrl);
  const requestSettledWithoutIssue =
    ownsRequestedIssue &&
    !selectedStateMatches &&
    (requestKey
      ? selectedState.resourceKey === requestKey && !selectedState.loading
      : authScopeResolved);

  useEffect(() => {
    if (!requestKey || issueNumber <= 0 || selectedStateMatches) {
      return;
    }
    let cancelled = false;
    setSelectedState((prev) => ({
      ...prev,
      resourceKey: requestKey,
      issue: null,
      timeline: [],
      loading: true,
      timelineLoading: true,
      error: null,
    }));
    void withDeadline(
      loadGitHubIssueDetailBundle(store, requestKey, async () => {
        const issueResultPromise = remoteUrl
          ? fetchIssue(remoteUrl, issueNumber)
          : getIssueLocal(repoFullName!, issueNumber).then((issue) => ({
              data: issue,
              error: null,
            }));
        let timeline: GitHubIssueTimelineItem[] = [];
        let timelineError: string | null = null;
        try {
          timeline = await loadGitHubIssueTimeline(
            store,
            requestKey,
            async () => {
              if (!remoteUrl) {
                return listIssueTimelineLocal(repoFullName!, issueNumber);
              }
              const timelineResult = await fetchIssueTimeline({
                remoteUrl,
                issueNumber,
              });
              if (timelineResult.error) throw new Error(timelineResult.error);
              return timelineResult.data ?? [];
            }
          );
        } catch (error) {
          timelineError =
            error instanceof Error ? error.message : String(error);
        }
        const issueResult = await issueResultPromise;
        return {
          issue: issueResult.data ?? null,
          timeline,
          error: issueResult.error ?? timelineError,
        };
      }),
      ISSUE_DETAIL_REQUEST_TIMEOUT_MS,
      () => ({
        issue: null,
        timeline: [],
        error: GITHUB_ISSUE_TIMEOUT_ERROR,
      })
    )
      .then((bundle) => {
        if (cancelled) return;
        setSelectedState((prev) =>
          prev.resourceKey === requestKey
            ? {
                ...prev,
                issue: bundle.issue,
                timeline: bundle.timeline,
                loading: false,
                timelineLoading: false,
                error: bundle.error,
              }
            : prev
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSelectedState((prev) =>
          prev.resourceKey === requestKey
            ? {
                ...prev,
                loading: false,
                timelineLoading: false,
                error: error instanceof Error ? error.message : String(error),
              }
            : prev
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    issueNumber,
    repoFullName,
    remoteUrl,
    requestKey,
    selectedStateMatches,
    setSelectedState,
    store,
  ]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    if (!requestKey || !repoFullName || !authScope) return;
    let cancelled = false;
    const currentIssue =
      selectedState.resourceKey === requestKey
        ? selectedIssueRef.current
        : null;
    const currentTimeline =
      selectedState.resourceKey === requestKey
        ? selectedTimelineRef.current
        : [];

    if (providedViewerLogin) {
      primeGitHubViewer(store, authScope, providedViewerLogin);
    }
    if (providedRepoPermissions) {
      primeGitHubRepoPermissions(
        store,
        authScope,
        repoFullName,
        providedRepoPermissions
      );
    }
    void Promise.allSettled([
      loadGitHubViewer(store, authScope, getGitHubViewerLogin),
      loadGitHubRepoPermissions(store, authScope, repoFullName, () =>
        getGitHubRepoPermissionsLocal(repoFullName)
      ),
    ]).then(([viewerResult, permissionsResult]) => {
      if (cancelled || requestGenerationRef.current !== generation) return;
      setResolution({
        key: requestKey,
        viewer:
          viewerResult.status === "fulfilled"
            ? resolveViewer(viewerResult.value, currentIssue, currentTimeline)
            : null,
        permissions:
          permissionsResult.status === "fulfilled"
            ? permissionsResult.value
            : null,
        duplicateCandidates: [],
        duplicateCandidatesLoaded: false,
        loadingDuplicateCandidates: false,
        duplicateCandidatesError: false,
        assignableUsers: [],
        assignableUsersLoaded: false,
        loadingAssignableUsers: false,
        assigneesError: null,
        submittingComment: false,
        updatingBody: false,
        updatingStatus: false,
        updatingAssignees: false,
        error: null,
      });
    });

    return () => {
      cancelled = true;
      if (requestGenerationRef.current === generation) {
        requestGenerationRef.current += 1;
      }
    };
  }, [
    authScope,
    providedRepoPermissions,
    providedViewerLogin,
    repoFullName,
    requestKey,
    selectedState.resourceKey,
    store,
  ]);

  const loadDuplicateCandidates = useCallback((): Promise<void> => {
    if (!requestKey || !repoFullName || !authScope || !currentResolution) {
      return Promise.reject(new Error("github_duplicate_issues_unavailable"));
    }
    if (currentResolution.duplicateCandidatesLoaded) {
      return Promise.resolve();
    }
    const generation = requestGenerationRef.current;

    setResolution((current) =>
      current?.key === requestKey
        ? {
            ...current,
            loadingDuplicateCandidates: true,
            duplicateCandidatesError: false,
          }
        : current
    );

    return loadGitHubDuplicateCandidates(
      store,
      authScope,
      repoFullName,
      issueNumber,
      async () => {
        const { issues } = await listIssuesLocal(repoFullName, {
          state: "all",
          page: 1,
          perPage: 100,
          includeLinkedPullRequests: false,
        });
        return issues.filter(
          (candidate) =>
            candidate.number !== issueNumber &&
            typeof candidate.id === "number" &&
            candidate.id > 0
        );
      }
    )
      .then((candidates) => {
        setResolution((current) =>
          current?.key === requestKey &&
          requestGenerationRef.current === generation
            ? {
                ...current,
                duplicateCandidates: candidates,
                duplicateCandidatesLoaded: true,
                loadingDuplicateCandidates: false,
                duplicateCandidatesError: false,
              }
            : current
        );
      })
      .catch((error) => {
        setResolution((current) =>
          current?.key === requestKey &&
          requestGenerationRef.current === generation
            ? {
                ...current,
                loadingDuplicateCandidates: false,
                duplicateCandidatesError: true,
              }
            : current
        );
        throw error;
      });
  }, [
    authScope,
    currentResolution,
    issueNumber,
    repoFullName,
    requestKey,
    store,
  ]);

  const loadAssignableUsers = useCallback((): Promise<void> => {
    if (
      !requestKey ||
      !repoFullName ||
      !authScope ||
      !currentResolution ||
      currentResolution.permissions?.can_manage_issues !== true
    ) {
      return Promise.resolve();
    }
    if (currentResolution.assignableUsersLoaded) {
      return Promise.resolve();
    }
    const generation = requestGenerationRef.current;

    setResolution((current) =>
      current?.key === requestKey
        ? {
            ...current,
            loadingAssignableUsers: true,
            assigneesError: null,
          }
        : current
    );

    return loadGitHubAssignableUsers(store, authScope, repoFullName, () =>
      listRepoAssigneesLocal(repoFullName)
    )
      .then((users) => {
        setResolution((current) =>
          current?.key === requestKey &&
          requestGenerationRef.current === generation
            ? {
                ...current,
                assignableUsers: users,
                assignableUsersLoaded: true,
                loadingAssignableUsers: false,
                assigneesError: null,
              }
            : current
        );
      })
      .catch((error: unknown) => {
        setResolution((current) =>
          current?.key === requestKey &&
          requestGenerationRef.current === generation
            ? {
                ...current,
                loadingAssignableUsers: false,
                assigneesError:
                  error instanceof Error ? error.message : String(error),
              }
            : current
        );
      });
  }, [authScope, currentResolution, repoFullName, requestKey, store]);

  const changeAssignees = useCallback(
    async (assigneeLogins: string[]): Promise<void> => {
      const issue = selectedState.issue;
      if (
        !requestKey ||
        !repoFullName ||
        !issue ||
        !currentResolution ||
        currentResolution.permissions?.can_manage_issues !== true ||
        currentResolution.updatingAssignees
      ) {
        return;
      }

      const generation = requestGenerationRef.current;
      if (
        assigneeMutationRef.current?.key === requestKey &&
        assigneeMutationRef.current.generation === generation
      ) {
        return;
      }
      assigneeMutationRef.current = { key: requestKey, generation };

      const previousAssignees = issue.assignees;
      const optimisticAssignees = resolveGitHubAssigneeUsers(
        previousAssignees,
        currentResolution.assignableUsers,
        assigneeLogins
      );
      setResolution((current) =>
        current?.key === requestKey
          ? { ...current, updatingAssignees: true, assigneesError: null }
          : current
      );
      setSelectedState((current) =>
        requestGenerationRef.current === generation &&
        current.issue?.id === issue.id
          ? {
              ...current,
              issue: { ...current.issue, assignees: optimisticAssignees },
            }
          : current
      );

      try {
        const updatedIssue = await updateIssueLocal(
          repoFullName,
          issue.number,
          { assignees: assigneeLogins }
        );
        if (!issueHasAssigneeLogins(updatedIssue, assigneeLogins)) {
          throw new Error("GitHub did not apply the assignee update.");
        }
        invalidateGitHubIssueDetailBundle(store, requestKey);
        setSelectedState((current) =>
          requestGenerationRef.current === generation &&
          current.issue?.id === issue.id
            ? { ...current, issue: updatedIssue }
            : current
        );
        setResolution((current) =>
          current?.key === requestKey &&
          requestGenerationRef.current === generation
            ? {
                ...current,
                updatingAssignees: false,
                assigneesError: null,
              }
            : current
        );
        callbacks.refreshIssues?.();
      } catch (error) {
        setSelectedState((current) =>
          requestGenerationRef.current === generation &&
          current.issue?.id === issue.id
            ? {
                ...current,
                issue: { ...current.issue, assignees: previousAssignees },
              }
            : current
        );
        setResolution((current) =>
          current?.key === requestKey &&
          requestGenerationRef.current === generation
            ? {
                ...current,
                updatingAssignees: false,
                assigneesError:
                  error instanceof Error ? error.message : String(error),
              }
            : current
        );
      } finally {
        if (
          assigneeMutationRef.current?.key === requestKey &&
          assigneeMutationRef.current.generation === generation
        ) {
          assigneeMutationRef.current = null;
        }
      }
    },
    [
      callbacks,
      currentResolution,
      repoFullName,
      requestKey,
      selectedState.issue,
      setSelectedState,
      store,
    ]
  );

  const addComment = useCallback(
    async (body: string) => {
      const issue = selectedState.issue;
      if (
        !requestKey ||
        !repoFullName ||
        !issue ||
        !currentResolution?.viewer ||
        currentResolution.submittingComment
      ) {
        throw new Error("github_comment_unavailable");
      }
      setResolution((current) =>
        current?.key === requestKey
          ? { ...current, submittingComment: true, error: null }
          : current
      );

      try {
        const comment = await createIssueCommentLocal(
          repoFullName,
          issue.number,
          body
        );
        invalidateGitHubIssueDetailBundle(store, requestKey);
        invalidateGitHubIssueTimeline(store, requestKey);
        setSelectedState((current) =>
          current.issue?.number === issue.number
            ? {
                ...current,
                issue: {
                  ...current.issue,
                  comments: current.issue.comments + 1,
                },
                timeline: [
                  ...current.timeline,
                  issueCommentToTimelineItem(comment),
                ],
              }
            : current
        );
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, submittingComment: false, error: null }
            : current
        );
      } catch (error) {
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, submittingComment: false, error: "comment" }
            : current
        );
        throw error;
      }
    },
    [
      currentResolution,
      repoFullName,
      requestKey,
      selectedState.issue,
      setSelectedState,
      store,
    ]
  );

  const updateBody = useCallback(
    async (body: string) => {
      const issue = selectedState.issue;
      if (
        !requestKey ||
        !repoFullName ||
        !issue ||
        !currentResolution ||
        currentResolution.updatingBody ||
        currentResolution.updatingStatus
      ) {
        throw new Error("github_body_update_unavailable");
      }
      if (!canEditIssue(currentResolution, issue)) {
        throw new Error("github_body_update_forbidden");
      }

      setResolution((current) =>
        current?.key === requestKey
          ? { ...current, updatingBody: true, error: null }
          : current
      );
      try {
        const updatedIssue = await updateIssueLocal(
          repoFullName,
          issue.number,
          { body }
        );
        invalidateGitHubIssueDetailBundle(store, requestKey);
        setSelectedState((current) =>
          current.issue?.number === issue.number
            ? { ...current, issue: updatedIssue }
            : current
        );
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, updatingBody: false }
            : current
        );
        callbacks.refreshIssues?.();
      } catch (error) {
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, updatingBody: false }
            : current
        );
        throw error;
      }
    },
    [
      callbacks,
      currentResolution,
      repoFullName,
      requestKey,
      selectedState.issue,
      setSelectedState,
      store,
    ]
  );

  const changeStatus = useCallback(
    async (
      state: GitHubIssue["state"],
      options?: GitHubIssueStatusChangeOptions
    ) => {
      const issue = selectedState.issue;
      if (
        !requestKey ||
        !repoFullName ||
        !issue ||
        !currentResolution ||
        currentResolution.updatingStatus ||
        currentResolution.updatingBody
      ) {
        throw new Error("github_status_unavailable");
      }
      if (!canEditIssue(currentResolution, issue)) {
        throw new Error("github_status_forbidden");
      }
      const stateReason =
        state === "closed" ? (options?.stateReason ?? "completed") : undefined;
      if (
        stateReason === "duplicate" &&
        (!options?.duplicateIssueId || options.duplicateIssueId <= 0)
      ) {
        throw new Error("github_duplicate_issue_required");
      }

      setResolution((current) =>
        current?.key === requestKey
          ? { ...current, updatingStatus: true, error: null }
          : current
      );
      try {
        const updatedIssue = await updateIssueLocal(
          repoFullName,
          issue.number,
          {
            state,
            stateReason,
            ...(stateReason === "duplicate"
              ? { duplicateIssueId: options?.duplicateIssueId }
              : {}),
          }
        );
        const timeline = await loadGitHubIssueTimeline(
          store,
          requestKey,
          () => listIssueTimelineLocal(repoFullName, issue.number),
          { force: true }
        ).catch(() => selectedState.timeline);
        primeGitHubIssueTimeline(store, requestKey, timeline);
        primeGitHubIssueDetailBundle(store, requestKey, {
          issue: updatedIssue,
          timeline,
          error: null,
        });
        setSelectedState((current) =>
          current.issue?.number === issue.number
            ? { ...current, issue: updatedIssue, timeline }
            : current
        );
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, updatingStatus: false, error: null }
            : current
        );
        callbacks.refreshIssues?.();
      } catch (error) {
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, updatingStatus: false, error: "status" }
            : current
        );
        throw error;
      }
    },
    [
      callbacks,
      currentResolution,
      repoFullName,
      requestKey,
      selectedState.issue,
      selectedState.timeline,
      setSelectedState,
      store,
    ]
  );

  const interaction = useMemo<GitHubIssueInteractionConfig>(() => {
    const issue = selectedState.issue;
    const canManageStatus = canEditIssue(currentResolution, issue);
    const viewer = currentResolution?.viewer
      ? resolveViewer(
          currentResolution.viewer.login,
          issue,
          selectedState.timeline
        )
      : null;

    return {
      viewer,
      issueState: issue?.state ?? "open",
      duplicateCandidates: currentResolution?.duplicateCandidates ?? [],
      duplicateCandidatesLoaded:
        currentResolution?.duplicateCandidatesLoaded ?? false,
      loadingDuplicateCandidates:
        currentResolution?.loadingDuplicateCandidates ?? false,
      duplicateCandidatesError:
        currentResolution?.duplicateCandidatesError ?? false,
      loading:
        ownsRequestedIssue &&
        !requestSettledWithoutIssue &&
        (!authScope || !selectedStateMatches || !currentResolution),
      canComment: Boolean(currentResolution?.viewer),
      canEditBody: canManageStatus,
      canManageStatus,
      submittingComment: currentResolution?.submittingComment ?? false,
      updatingBody: currentResolution?.updatingBody ?? false,
      updatingStatus: currentResolution?.updatingStatus ?? false,
      error: currentResolution?.error ?? null,
      onAddComment: addComment,
      onUpdateBody: updateBody,
      onLoadDuplicateCandidates: loadDuplicateCandidates,
      onStatusChange: changeStatus,
    };
  }, [
    addComment,
    changeStatus,
    currentResolution,
    loadDuplicateCandidates,
    authScope,
    ownsRequestedIssue,
    requestSettledWithoutIssue,
    selectedStateMatches,
    selectedState.issue,
    selectedState.timeline,
    updateBody,
  ]);

  const assigneeConfig = useMemo<
    WorkItemExternalAssigneeConfig | undefined
  >(() => {
    const issue = selectedState.issue;
    if (!issue || !requestKey || !currentResolution) return undefined;

    const usersByLogin = new Map<string, GitHubIssueUser>();
    for (const user of [
      ...issue.assignees,
      ...currentResolution.assignableUsers,
    ]) {
      usersByLogin.set(user.login.toLowerCase(), user);
    }
    const canManageAssignees =
      currentResolution.permissions?.can_manage_issues === true;

    return {
      currentAssigneeIds: issue.assignees.map((assignee) => assignee.login),
      options: Array.from(usersByLogin.values()).map((user) => ({
        id: user.login,
        label: user.login,
        avatar: user.avatar_url,
      })),
      loading: currentResolution.loadingAssignableUsers,
      error: currentResolution.assigneesError,
      disabled: !canManageAssignees || currentResolution.updatingAssignees,
      readonlyReason: canManageAssignees
        ? undefined
        : "Repository permission is required to manage issue assignees.",
      onOpen: loadAssignableUsers,
      onChangeAssigneeIds: changeAssignees,
    };
  }, [
    changeAssignees,
    currentResolution,
    loadAssignableUsers,
    requestKey,
    selectedState.issue,
  ]);

  const visibleSelectedState =
    !ownsRequestedIssue || selectedStateMatches
      ? selectedState
      : requestSettledWithoutIssue
        ? {
            ...selectedState,
            issue: null,
            timeline: [],
            loading: false,
            timelineLoading: false,
            // Never surface an error left behind by a previous selection.
            error:
              requestKey &&
              selectedState.resourceKey === requestKey &&
              selectedState.error
                ? selectedState.error
                : GITHUB_ISSUE_UNAVAILABLE_ERROR,
          }
        : {
            ...selectedState,
            issue: null,
            timeline: [],
            loading: true,
            timelineLoading: true,
            error: null,
          };

  return { selectedState: visibleSelectedState, interaction, assigneeConfig };
}
