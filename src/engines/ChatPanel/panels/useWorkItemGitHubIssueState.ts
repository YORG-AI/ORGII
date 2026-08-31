import { useStore } from "jotai";
import { useEffect, useMemo, useState } from "react";

import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";
import { parseGitHubIssueNumber } from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/hooks/useGitHubIssueTimeline";
import type { GitHubIssueInteractionConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";
import { resolveGitHubIssueRemoteUrl } from "@src/modules/ProjectManager/WorkItems/githubIssueRemote";
import { loadGitHubRemoteUrl } from "@src/modules/shared/githubIssueDetailCoordinator";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import { workstationIssueDetailScopeKey } from "@src/store/workstation/codeEditor/workstationIssueAtom";

interface RemoteResolutionState {
  requestKey: string;
  remoteUrl: string | null;
  loading: boolean;
}

interface WorkItemGitHubIssueState {
  externalUrl?: string;
  timeline?: {
    items: GitHubIssueTimelineItem[];
    loading: boolean;
  };
  interaction?: GitHubIssueInteractionConfig;
}

interface UseWorkItemGitHubIssueStateOptions {
  enabled: boolean;
  repoPath: string | null;
  shortId: string | null | undefined;
  stateScopeKey: string;
}

/** Hydrate a synced Work Item with the same GitHub controller as Issues pages. */
export function useWorkItemGitHubIssueState({
  enabled,
  repoPath,
  shortId,
  stateScopeKey,
}: UseWorkItemGitHubIssueStateOptions): WorkItemGitHubIssueState {
  const store = useStore();
  const issueNumber = useMemo(() => parseGitHubIssueNumber(shortId), [shortId]);
  const requestKey =
    enabled && repoPath && issueNumber ? `${repoPath}:${issueNumber}` : "";
  const [remoteResolution, setRemoteResolution] =
    useState<RemoteResolutionState | null>(null);
  const currentRemoteResolution =
    remoteResolution?.requestKey === requestKey ? remoteResolution : null;

  const canonicalStateScopeKey =
    repoPath && issueNumber
      ? workstationIssueDetailScopeKey(repoPath, issueNumber)
      : stateScopeKey;

  const detailState = useGitHubIssueDetailState({
    issueNumber: enabled ? (issueNumber ?? undefined) : undefined,
    repoPath: enabled ? (repoPath ?? "") : "",
    remoteUrl: currentRemoteResolution?.remoteUrl ?? undefined,
    stateScopeKey: canonicalStateScopeKey,
  });
  const hasMatchingIssue =
    detailState.selectedState.issue?.number === issueNumber;

  useEffect(() => {
    if (!requestKey || !repoPath || hasMatchingIssue) return;

    let cancelled = false;
    void loadGitHubRemoteUrl(store, repoPath, () =>
      resolveGitHubIssueRemoteUrl(repoPath)
    )
      .then((remoteUrl) => {
        if (!cancelled) {
          setRemoteResolution({ requestKey, remoteUrl, loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteResolution({ requestKey, remoteUrl: null, loading: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasMatchingIssue, repoPath, requestKey, store]);

  if (!enabled || !requestKey) return {};
  if (
    currentRemoteResolution &&
    !currentRemoteResolution.remoteUrl &&
    !hasMatchingIssue
  ) {
    // A GitHub-shaped status without a resolvable GitHub repository must not
    // surface a permanently disabled composer. Keep the local task readable;
    // a later repo/data refresh can retry resolution on a new request key.
    return {};
  }

  const resolvingRemote =
    Boolean(requestKey) &&
    !hasMatchingIssue &&
    (currentRemoteResolution?.loading ?? true);
  const waitingForIssue = Boolean(
    currentRemoteResolution?.remoteUrl && !hasMatchingIssue
  );

  return {
    externalUrl: hasMatchingIssue
      ? detailState.selectedState.issue?.html_url
      : undefined,
    timeline: {
      items: hasMatchingIssue ? detailState.selectedState.timeline : [],
      loading:
        resolvingRemote ||
        waitingForIssue ||
        (hasMatchingIssue && detailState.selectedState.timelineLoading),
    },
    interaction: {
      ...detailState.interaction,
      loading:
        detailState.interaction.loading || resolvingRemote || waitingForIssue,
    },
  };
}
