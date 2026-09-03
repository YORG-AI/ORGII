import { useMemo } from "react";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import type {
  GitHubIssueInteractionConfig,
  GitHubIssueStatusChangeOptions,
} from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import { workstationIssueDetailScopeKey } from "@src/store/workstation/codeEditor/workstationIssueAtom";

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
  /** Set once the request settled without the issue, so the host can say so. */
  error: string | null;
  interaction: GitHubIssueInteractionConfig;
}

/** Team Inbox adapter over the canonical GitHub issue-detail controller. */
export function useTeamInboxGitHubIssue({
  enabled,
  repoFullName,
  issueNumber,
  fallbackState,
  onStatusChanged,
}: UseTeamInboxGitHubIssueOptions): TeamInboxGitHubIssueState {
  const activeIssueNumber = enabled ? issueNumber : undefined;
  const activeRepo = enabled ? (repoFullName ?? "") : "";
  const detailState = useGitHubIssueDetailState({
    issueNumber: activeIssueNumber,
    repoPath: activeRepo,
    remoteUrl: activeRepo || undefined,
    stateScopeKey:
      activeRepo && activeIssueNumber
        ? workstationIssueDetailScopeKey(activeRepo, activeIssueNumber)
        : undefined,
  });

  const interaction = useMemo<GitHubIssueInteractionConfig>(() => {
    const canonical = detailState.interaction;
    return {
      ...canonical,
      issueState: detailState.selectedState.issue?.state ?? fallbackState,
      onStatusChange: async (
        state: GitHubIssue["state"],
        options?: GitHubIssueStatusChangeOptions
      ) => {
        await canonical.onStatusChange(state, options);
        onStatusChanged?.(state);
      },
    };
  }, [
    detailState.interaction,
    detailState.selectedState.issue?.state,
    fallbackState,
    onStatusChanged,
  ]);

  return {
    issue: detailState.selectedState.issue,
    timeline: detailState.selectedState.timeline,
    timelineLoading: detailState.selectedState.timelineLoading,
    error: enabled ? detailState.selectedState.error : null,
    interaction,
  };
}
