import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import type { WorkItem } from "@src/types/core/workItem";

import type { GitHubIssueInteractionConfig } from "./WorkItemContent/types";
import type { WorkItemExternalAssigneeConfig } from "./WorkItemProperties/types";
import WorkItemThreadSurface from "./WorkItemThreadSurface";

interface GitHubIssueThreadSurfaceProps {
  issue: GitHubIssue;
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  interaction: GitHubIssueInteractionConfig;
  assigneeConfig?: WorkItemExternalAssigneeConfig;
}

/** Convert a remote GitHub issue into the shared Work Item thread contract. */
export function mapGitHubIssueToThreadWorkItem(issue: GitHubIssue): WorkItem {
  const primaryAssignee = issue.assignees[0];

  return {
    session_id: issue.html_url,
    shortId: `#${issue.number}`,
    user_id: issue.user.login,
    name: issue.title,
    status: issue.state,
    workItemStatus: issue.state,
    priority: "none",
    spec: issue.body ?? "",
    star: false,
    target_date: null,
    created_time: issue.created_at,
    updated_time: issue.updated_at,
    createdBy: {
      id: issue.user.login,
      name: issue.user.login,
      avatar: issue.user.avatar_url,
    },
    assignee: primaryAssignee
      ? {
          id: primaryAssignee.login,
          name: primaryAssignee.login,
          avatar: primaryAssignee.avatar_url,
        }
      : undefined,
    labels: issue.labels.map((label) => ({
      id: String(label.id),
      name: label.name,
      color: label.color.startsWith("#") ? label.color : `#${label.color}`,
    })),
    milestone: issue.milestone
      ? { id: issue.milestone, name: issue.milestone }
      : undefined,
    todos: [],
    linkedSessions: [],
    comments: [],
  };
}

/**
 * GitHub adapter for the same canonical thread composition used by Inbox.
 * Remote-only fields stay constrained to repository, status, and assignee so
 * the UI does not offer local Work Item properties that GitHub cannot persist.
 */
const GitHubIssueThreadSurface: React.FC<GitHubIssueThreadSurfaceProps> = ({
  issue,
  timeline,
  timelineLoading,
  interaction,
  assigneeConfig,
}) => {
  const { t } = useTranslation("common");
  const workItem = useMemo(
    () => mapGitHubIssueToThreadWorkItem(issue),
    [issue]
  );
  const handleUpdate = useCallback(
    (updates: Partial<WorkItem>) => {
      const nextStatus = updates.workItemStatus;
      if (
        (nextStatus === "open" || nextStatus === "closed") &&
        nextStatus !== issue.state
      ) {
        void interaction.onStatusChange(nextStatus);
      }
    },
    [interaction, issue.state]
  );

  return (
    <WorkItemThreadSurface
      workItem={workItem}
      propertyFields={["status", "assignee"]}
      propertyProps={{
        onUpdate: handleUpdate,
        externalStatusConfig: {
          currentStatusId: issue.state,
          options: [
            {
              id: "open",
              label: t("git.issues.status.open"),
              color: "var(--color-success-6)",
            },
            {
              id: "closed",
              label: t("git.issues.status.closed"),
              color: "var(--color-purple-6)",
            },
          ],
          disabled: !interaction.canManageStatus || interaction.updatingStatus,
          onChangeStatusId: (statusId) => {
            if (statusId === "open" || statusId === "closed") {
              return interaction.onStatusChange(statusId);
            }
          },
        },
        assigneeReadonly: !assigneeConfig,
        externalAssigneeConfig: assigneeConfig,
        showMoreMenu: false,
      }}
      githubIssueTimeline={{
        items: timeline,
        loading: timelineLoading,
      }}
      githubIssueInteraction={interaction}
    />
  );
};

export default GitHubIssueThreadSurface;
