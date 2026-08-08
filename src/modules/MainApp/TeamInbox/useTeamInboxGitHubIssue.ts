import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createIssueCommentLocal,
  getGitHubRepoPermissionsLocal,
  getGitHubViewerLogin,
  getIssueLocal,
  listIssueTimelineLocal,
  listIssuesLocal,
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
import { issueCommentToTimelineItem } from "@src/services/git/operations/githubIssues";

interface GitHubIssueResolution {
  key: string;
  issue: GitHubIssue | null;
  timeline: GitHubIssueTimelineItem[];
  viewer: GitHubIssueUser | null;
  permissions: GitHubRepoPermissions | null;
  duplicateCandidates: GitHubIssue[];
  duplicateCandidatesLoaded: boolean;
  loadingDuplicateCandidates: boolean;
  duplicateCandidatesError: boolean;
  submittingComment: boolean;
  updatingBody: boolean;
  updatingStatus: boolean;
  error: GitHubIssueInteractionConfig["error"];
}

interface UseTeamInboxGitHubIssueOptions {
  enabled: boolean;
  repoFullName: string | null;
  issueNumber: number | undefined;
  fallbackState: GitHubIssue["state"];
  onStatusChanged?: (state: GitHubIssue["state"]) => void;
}

export interface TeamInboxGitHubIssueState {
  issue: GitHubIssue | null;
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  interaction: GitHubIssueInteractionConfig;
}

function sameLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function canEditIssue(resolution: GitHubIssueResolution | null): boolean {
  return (
    resolution?.permissions?.can_manage_issues === true ||
    Boolean(
      resolution?.issue &&
      resolution.viewer &&
      sameLogin(resolution.issue.user.login, resolution.viewer.login)
    )
  );
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

export function useTeamInboxGitHubIssue({
  enabled,
  repoFullName,
  issueNumber,
  fallbackState,
  onStatusChanged,
}: UseTeamInboxGitHubIssueOptions): TeamInboxGitHubIssueState {
  const requestKey =
    enabled && repoFullName && issueNumber
      ? `${repoFullName}#${issueNumber}`
      : null;
  const [resolution, setResolution] = useState<GitHubIssueResolution | null>(
    null
  );
  const duplicateRequestRef = useRef<{
    key: string;
    generation: number;
    promise: Promise<void>;
  } | null>(null);
  const requestGenerationRef = useRef(0);
  const currentResolution = resolution?.key === requestKey ? resolution : null;

  useEffect(() => {
    if (!requestKey || !repoFullName || !issueNumber) return;
    let cancelled = false;
    const generation = ++requestGenerationRef.current;

    void Promise.allSettled([
      getIssueLocal(repoFullName, issueNumber),
      listIssueTimelineLocal(repoFullName, issueNumber),
      getGitHubViewerLogin(),
      getGitHubRepoPermissionsLocal(repoFullName),
    ]).then(
      ([issueResult, timelineResult, viewerResult, permissionsResult]) => {
        if (cancelled || requestGenerationRef.current !== generation) return;
        const issue =
          issueResult.status === "fulfilled" ? issueResult.value : null;
        const timeline =
          timelineResult.status === "fulfilled" ? timelineResult.value : [];
        const viewer =
          viewerResult.status === "fulfilled"
            ? resolveViewer(viewerResult.value, issue, timeline)
            : null;

        setResolution({
          key: requestKey,
          issue,
          timeline,
          viewer,
          permissions:
            permissionsResult.status === "fulfilled"
              ? permissionsResult.value
              : null,
          duplicateCandidates: [],
          duplicateCandidatesLoaded: false,
          loadingDuplicateCandidates: false,
          duplicateCandidatesError: false,
          submittingComment: false,
          updatingBody: false,
          updatingStatus: false,
          error: null,
        });
      }
    );

    return () => {
      cancelled = true;
      if (requestGenerationRef.current === generation) {
        requestGenerationRef.current += 1;
      }
      if (duplicateRequestRef.current?.key === requestKey) {
        duplicateRequestRef.current = null;
      }
    };
  }, [issueNumber, repoFullName, requestKey]);

  const loadDuplicateCandidates = useCallback((): Promise<void> => {
    if (!requestKey || !repoFullName || !issueNumber || !currentResolution) {
      return Promise.reject(new Error("github_duplicate_issues_unavailable"));
    }
    if (currentResolution.duplicateCandidatesLoaded) {
      return Promise.resolve();
    }
    const generation = requestGenerationRef.current;
    if (
      duplicateRequestRef.current?.key === requestKey &&
      duplicateRequestRef.current.generation === generation
    ) {
      return duplicateRequestRef.current.promise;
    }

    setResolution((current) =>
      current?.key === requestKey
        ? {
            ...current,
            loadingDuplicateCandidates: true,
            duplicateCandidatesError: false,
          }
        : current
    );

    const promise = listIssuesLocal(repoFullName, {
      state: "all",
      page: 1,
      perPage: 100,
      includeLinkedPullRequests: false,
    })
      .then(({ issues }) => {
        const candidates = issues.filter(
          (candidate) =>
            candidate.number !== issueNumber &&
            typeof candidate.id === "number" &&
            candidate.id > 0
        );
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
      })
      .finally(() => {
        if (duplicateRequestRef.current?.promise === promise) {
          duplicateRequestRef.current = null;
        }
      });

    duplicateRequestRef.current = { key: requestKey, generation, promise };
    return promise;
  }, [currentResolution, issueNumber, repoFullName, requestKey]);

  const addComment = useCallback(
    async (body: string) => {
      if (
        !requestKey ||
        !repoFullName ||
        !issueNumber ||
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
          issueNumber,
          body
        );
        setResolution((current) =>
          current?.key === requestKey
            ? {
                ...current,
                issue: current.issue
                  ? { ...current.issue, comments: current.issue.comments + 1 }
                  : null,
                timeline: [
                  ...current.timeline,
                  issueCommentToTimelineItem(comment),
                ],
                submittingComment: false,
                error: null,
              }
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
    [currentResolution, issueNumber, repoFullName, requestKey]
  );

  const updateBody = useCallback(
    async (body: string) => {
      if (
        !requestKey ||
        !repoFullName ||
        !issueNumber ||
        !currentResolution ||
        currentResolution.updatingBody ||
        currentResolution.updatingStatus
      ) {
        throw new Error("github_body_update_unavailable");
      }
      if (!canEditIssue(currentResolution)) {
        throw new Error("github_body_update_forbidden");
      }

      setResolution((current) =>
        current?.key === requestKey
          ? { ...current, updatingBody: true, error: null }
          : current
      );
      try {
        const issue = await updateIssueLocal(repoFullName, issueNumber, {
          body,
        });
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, issue, updatingBody: false, error: null }
            : current
        );
      } catch (error) {
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, updatingBody: false }
            : current
        );
        throw error;
      }
    },
    [currentResolution, issueNumber, repoFullName, requestKey]
  );

  const changeStatus = useCallback(
    async (
      state: GitHubIssue["state"],
      options?: GitHubIssueStatusChangeOptions
    ) => {
      if (
        !requestKey ||
        !repoFullName ||
        !issueNumber ||
        !currentResolution ||
        currentResolution.updatingStatus ||
        currentResolution.updatingBody
      ) {
        throw new Error("github_status_unavailable");
      }
      const canManageStatus = canEditIssue(currentResolution);
      if (!canManageStatus) {
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
        const issue = await updateIssueLocal(repoFullName, issueNumber, {
          state,
          stateReason,
          ...(stateReason === "duplicate"
            ? { duplicateIssueId: options?.duplicateIssueId }
            : {}),
        });
        const timeline = await listIssueTimelineLocal(
          repoFullName,
          issueNumber
        ).catch(() => currentResolution.timeline);
        setResolution((current) =>
          current?.key === requestKey
            ? {
                ...current,
                issue,
                timeline,
                updatingStatus: false,
                error: null,
              }
            : current
        );
        onStatusChanged?.(issue.state);
      } catch (error) {
        setResolution((current) =>
          current?.key === requestKey
            ? { ...current, updatingStatus: false, error: "status" }
            : current
        );
        throw error;
      }
    },
    [currentResolution, issueNumber, onStatusChanged, repoFullName, requestKey]
  );

  const interaction = useMemo<GitHubIssueInteractionConfig>(() => {
    const issueState = currentResolution?.issue?.state ?? fallbackState;
    const viewer = currentResolution?.viewer ?? null;
    const canManageStatus = canEditIssue(currentResolution);

    return {
      viewer,
      issueState,
      duplicateCandidates: currentResolution?.duplicateCandidates ?? [],
      duplicateCandidatesLoaded:
        currentResolution?.duplicateCandidatesLoaded ?? false,
      loadingDuplicateCandidates:
        currentResolution?.loadingDuplicateCandidates ?? false,
      duplicateCandidatesError:
        currentResolution?.duplicateCandidatesError ?? false,
      loading: Boolean(requestKey) && !currentResolution,
      canComment: Boolean(viewer),
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
    fallbackState,
    loadDuplicateCandidates,
    requestKey,
    updateBody,
  ]);

  return {
    issue: currentResolution?.issue ?? null,
    timeline: currentResolution?.timeline ?? [],
    timelineLoading: Boolean(requestKey) && !currentResolution,
    interaction,
  };
}
