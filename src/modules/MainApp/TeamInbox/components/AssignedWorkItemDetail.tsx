import React from "react";
import { useTranslation } from "react-i18next";

import { getGitRemotes } from "@src/api/http/git/remotes";
import type { WorkItemHandoffTransition } from "@src/api/http/project";
import type { GitHubIssue } from "@src/api/tauri/github";
import { Placeholder } from "@src/components/Placeholder";
import {
  ClipboardListIcon,
  HugeiconsIcon,
  InternetIcon,
  SquareArrowUpRightIcon,
} from "@src/icons";
import { WorkItemThreadSurface } from "@src/modules/ProjectManager/WorkItems/components";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import GitHubIssueHeaderContent from "@src/modules/shared/components/GitHubIssueHeaderContent";
import { LoadingBar } from "@src/modules/shared/layouts/blocks";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";
import { resolveGithubRepoFullName } from "@src/util/git/githubRemote";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  type AssignedWorkItem,
  type TeamInboxNavigationIntent,
  isGitHubIssueStatus,
  parseGitHubIssueNumber,
} from "../domain";
import {
  type TeamInboxGitHubIssueState,
  useTeamInboxGitHubIssue,
} from "../useTeamInboxGitHubIssue";
import { useTeamInboxWorkItem } from "../useTeamInboxWorkItem";
import type { TeamInboxWorkItemIssue } from "../useTeamInboxWorkItem";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

export interface AssignedWorkItemDetailProps {
  item: AssignedWorkItem;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead?: (item: AssignedWorkItem) => void;
  onMarkUnread?: (item: AssignedWorkItem) => void;
  onWorkItemUpdated?: (workItem: WorkItem) => void;
}

function getGitHubIssueNumber(
  item: AssignedWorkItem,
  workItem: WorkItem | null
): number | undefined {
  const shortIdNumber = parseGitHubIssueNumber(item.target.workItemId);
  if (shortIdNumber !== undefined) return shortIdNumber;

  const workItemShortIdNumber = parseGitHubIssueNumber(workItem?.shortId);
  if (workItemShortIdNumber !== undefined) return workItemShortIdNumber;

  const urlMatch = workItem?.session_id.match(/\/issues\/(\d+)(?:\/|$)/);
  return urlMatch ? Number(urlMatch[1]) : undefined;
}

function buildGitHubIssueUrl(
  item: AssignedWorkItem,
  workItem: WorkItem | null,
  issueNumber: number | undefined,
  repoFullName: string | null
): string | null {
  if (!isGitHubIssueStatus(item.payload.status) || issueNumber === undefined) {
    return null;
  }

  if (/^https?:\/\//.test(workItem?.session_id ?? "")) {
    try {
      const directUrl = new URL(workItem?.session_id ?? "");
      if (
        directUrl.hostname === "github.com" &&
        directUrl.pathname.match(/\/issues\/\d+(?:\/|$)/)
      ) {
        return directUrl.toString();
      }
    } catch {
      // Fall through to the repository-derived URL.
    }
  }

  if (!repoFullName) return null;
  return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}

interface AssignedWorkItemThreadProps {
  item: AssignedWorkItem;
  workItem: WorkItem;
  repoPath: string | null;
  members: Person[];
  currentUser: Person | null;
  issueMessage: string | null;
  issueTone: "warning" | "error" | null;
  githubIssue: TeamInboxGitHubIssueState;
  updateWorkItem: (updates: Partial<WorkItem>) => void;
  transitionHandoff: (
    transition: WorkItemHandoffTransition
  ) => Promise<WorkItem>;
  refreshWorkItem: () => void;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
}

const AssignedWorkItemThread: React.FC<AssignedWorkItemThreadProps> = ({
  item,
  workItem,
  repoPath,
  members,
  currentUser,
  issueMessage,
  issueTone,
  githubIssue,
  updateWorkItem,
  transitionHandoff,
  refreshWorkItem,
  onNavigate,
}) => {
  const { t } = useTranslation("common");
  const isGitHubIssue = isGitHubIssueStatus(item.payload.status);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {issueMessage ? (
        <div
          role="status"
          className={`absolute inset-x-0 top-0 z-30 border-b px-3 py-2 text-xs ${
            issueTone === "warning"
              ? "border-warning-3 bg-warning-6/10 text-warning-6"
              : "border-danger-3 bg-danger-1 text-danger-6"
          }`}
        >
          {issueMessage}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkItemThreadSurface
            workItem={workItem}
            propertyFields={
              isGitHubIssue ? ["status", "assignee", "labels"] : undefined
            }
            propertiesPlacement="rail"
            propertyProps={{
              showSchedule: !isGitHubIssue,
              labelsReadonly: isGitHubIssue,
              onUpdate: updateWorkItem,
              externalStatusConfig: isGitHubIssue
                ? {
                    currentStatusId: githubIssue.interaction.issueState,
                    options: [
                      {
                        id: "open",
                        label: t("git.issues.status.open"),
                        color: "var(--color-success-6)",
                      },
                      {
                        id: "closed",
                        label: t("git.issues.status.closed"),
                        color: "var(--color-text-3)",
                      },
                    ],
                    loading: githubIssue.timelineLoading,
                    disabled: !githubIssue.interaction.canManageStatus,
                    onChangeStatusId: async (statusId) => {
                      try {
                        await githubIssue.interaction.onStatusChange(
                          statusId as GitHubIssue["state"]
                        );
                      } catch {
                        // The inline interaction owns and renders the error.
                      }
                    },
                  }
                : undefined,
              availableProjects: workItem.project ? [workItem.project] : [],
              availableMilestones: workItem.milestone
                ? [workItem.milestone]
                : [],
              availableLabels: workItem.labels ?? [],
              availableMembers: members,
              projectReadonly: true,
            }}
            onUpdateWorkItem={updateWorkItem}
            onUpdateWorkItemImmediate={updateWorkItem}
            onTransitionHandoff={transitionHandoff}
            teamMembers={members}
            currentUser={currentUser ?? undefined}
            repoPath={repoPath}
            projectSlug={item.target.projectId || null}
            shortId={item.target.workItemId}
            githubIssueTimeline={
              isGitHubIssue
                ? {
                    items: githubIssue.timeline,
                    loading: githubIssue.timelineLoading,
                  }
                : undefined
            }
            githubIssueInteraction={
              isGitHubIssue ? githubIssue.interaction : undefined
            }
            onOpenSession={
              onNavigate
                ? (sessionId) =>
                    onNavigate({
                      kind: "open_session",
                      sessionId,
                    })
                : undefined
            }
            onRefreshWorkflow={refreshWorkItem}
          />
        </div>
      </div>
    </div>
  );
};

const AssignedWorkItemDetail: React.FC<AssignedWorkItemDetailProps> = ({
  item,
  onNavigate,
  onMarkRead,
  onMarkUnread,
  onWorkItemUpdated,
}) => {
  const { t } = useTranslation();
  const {
    workItem,
    status,
    issue,
    repoPath,
    members,
    currentUser,
    updateWorkItem,
    transitionHandoff,
    refreshWorkItem,
  } = useTeamInboxWorkItem(
    item.target,
    onWorkItemUpdated,
    item.payload.updatedAt
  );
  const issueMessage = ((): string | null => {
    const keyByIssue: Record<TeamInboxWorkItemIssue, string> = {
      context_unavailable: "teamInbox.errors.workItemContext",
      load_failed: "teamInbox.errors.workItemLoad",
      update_failed: "teamInbox.errors.workItemUpdate",
    };
    return issue ? t(keyByIssue[issue]) : null;
  })();
  const isGitHubIssue = isGitHubIssueStatus(item.payload.status);
  const githubIssueNumber = getGitHubIssueNumber(item, workItem);
  const inlineRepoFullName = resolveGithubRepoFullName(
    [item.target.repository, repoPath].filter(
      (candidate): candidate is string => Boolean(candidate)
    )
  );
  const remoteResolutionKey =
    isGitHubIssue && !inlineRepoFullName && repoPath ? repoPath : null;
  const [remoteResolution, setRemoteResolution] = React.useState<{
    key: string;
    repoFullName: string | null;
  } | null>(null);
  React.useEffect(() => {
    if (!remoteResolutionKey || !repoPath) return;
    let cancelled = false;

    void getGitRemotes({ repo_id: "default", repo_path: repoPath })
      .then((result) => {
        if (cancelled) return;
        const origin = result?.remotes?.find(
          (remote) => remote.name === "origin"
        );
        const fallback = result?.remotes?.[0];
        setRemoteResolution({
          key: remoteResolutionKey,
          repoFullName: resolveGithubRepoFullName(
            [
              origin?.url,
              origin?.fetch_url,
              fallback?.url,
              fallback?.fetch_url,
            ].filter((candidate): candidate is string => Boolean(candidate))
          ),
        });
      })
      .catch(() => {
        if (cancelled) return;
        setRemoteResolution({ key: remoteResolutionKey, repoFullName: null });
      });

    return () => {
      cancelled = true;
    };
  }, [remoteResolutionKey, repoPath]);
  const resolvedRepoFullName =
    inlineRepoFullName ??
    (remoteResolution?.key === remoteResolutionKey
      ? remoteResolution.repoFullName
      : null);
  const githubIssueUrl = buildGitHubIssueUrl(
    item,
    workItem,
    githubIssueNumber,
    resolvedRepoFullName
  );
  const handleGitHubStatusChanged = React.useCallback(
    (state: GitHubIssue["state"]) => {
      updateWorkItem({ status: state, workItemStatus: state });
    },
    [updateWorkItem]
  );
  const githubIssue = useTeamInboxGitHubIssue({
    enabled: isGitHubIssue,
    repoFullName: resolvedRepoFullName,
    issueNumber: githubIssueNumber,
    fallbackState: item.payload.status === "closed" ? "closed" : "open",
    onStatusChanged: handleGitHubStatusChanged,
  });
  const githubIssueHydrating =
    isGitHubIssue &&
    !githubIssue.issue &&
    (githubIssue.timelineLoading ||
      (Boolean(remoteResolutionKey) &&
        remoteResolution?.key !== remoteResolutionKey));
  const githubIssueAuthor = githubIssue.issue?.user ?? null;
  const displayWorkItem =
    workItem && githubIssue.issue && githubIssueAuthor
      ? {
          ...workItem,
          status: githubIssue.issue.state,
          workItemStatus: githubIssue.issue.state,
          spec: githubIssue.issue.body ?? "",
          updated_time: githubIssue.issue.updated_at,
          user_id: githubIssueAuthor.login,
          createdBy: {
            id: githubIssueAuthor.login,
            name: githubIssueAuthor.login,
            avatar: githubIssueAuthor.avatar_url,
          },
        }
      : workItem;
  const detailTitle =
    githubIssue.issue?.title ?? workItem?.name ?? item.payload.title;
  const githubIssueHeader = isGitHubIssue ? (
    <GitHubIssueHeaderContent
      issue={{
        number: githubIssueNumber,
        state: githubIssue.interaction.issueState,
        title: detailTitle,
      }}
    />
  ) : undefined;

  return (
    <TeamInboxDetailLayout
      title={detailTitle}
      subtitle={t("teamInbox.detail.assignedSubtitle")}
      icon={ClipboardListIcon}
      headerContent={githubIssueHeader}
      contentLayout="fill"
      unread={item.readAt === null}
      markReadLabel={t("teamInbox.actions.markRead")}
      markUnreadLabel={t("teamInbox.actions.markUnread")}
      openLabel={t("teamInbox.actions.openWorkItem")}
      openIcon={
        <HugeiconsIcon
          icon={SquareArrowUpRightIcon}
          data-icon="square-arrow-out-up-right"
          size={14}
          strokeWidth={1.75}
          aria-hidden
        />
      }
      headerAuxiliaryAction={
        githubIssueUrl
          ? {
              label: t("previews.openInExternalBrowser"),
              icon: (
                <HugeiconsIcon
                  icon={InternetIcon}
                  data-icon="chrome"
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                />
              ),
              onClick: () => void openExternalLink(githubIssueUrl),
              testId: "team-inbox-open-github",
            }
          : undefined
      }
      openPlacement="header"
      onMarkRead={onMarkRead ? () => onMarkRead(item) : undefined}
      onMarkUnread={onMarkUnread ? () => onMarkUnread(item) : undefined}
      onOpen={
        onNavigate
          ? () =>
              onNavigate({
                kind: "open_work_item",
                orgId: item.target.orgId,
                projectId: item.target.projectId,
                workItemId: item.target.workItemId,
              })
          : undefined
      }
    >
      {isGitHubIssue && (status === "loading" || githubIssueHydrating) ? (
        <GitHubDetailSkeleton kind="issue" showHeader={false} />
      ) : status === "loading" ? (
        <LoadingBar />
      ) : status === "ready" && displayWorkItem ? (
        <AssignedWorkItemThread
          item={item}
          workItem={displayWorkItem}
          repoPath={repoPath}
          members={members}
          currentUser={currentUser}
          issueMessage={issueMessage}
          issueTone={
            issue === "context_unavailable" ? "warning" : issue ? "error" : null
          }
          githubIssue={githubIssue}
          updateWorkItem={updateWorkItem}
          transitionHandoff={transitionHandoff}
          refreshWorkItem={refreshWorkItem}
          onNavigate={onNavigate}
        />
      ) : (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("teamInbox.errors.loadTitle")}
          subtitle={issueMessage ?? t("teamInbox.errors.workItemLoad")}
          onRetry={refreshWorkItem}
          fillParentHeight
        />
      )}
    </TeamInboxDetailLayout>
  );
};

export default AssignedWorkItemDetail;
