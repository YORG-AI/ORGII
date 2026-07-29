import { ClipboardList, ExternalLink } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { WorkItemThreadSurface } from "@src/modules/ProjectManager/WorkItems/components";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import {
  type AssignedWorkItem,
  type TeamInboxNavigationIntent,
  isGitHubIssueStatus,
} from "../domain";
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

interface AssignedWorkItemThreadProps {
  item: AssignedWorkItem;
  workItem: WorkItem;
  repoPath: string | null;
  members: Person[];
  currentUser: Person | null;
  issueMessage: string | null;
  issueTone: "warning" | "error" | null;
  updateWorkItem: (updates: Partial<WorkItem>) => void;
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
  updateWorkItem,
  refreshWorkItem,
  onNavigate,
}) => {
  const canUpdate = Boolean(item.target.projectId);
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
            propertyProps={
              canUpdate
                ? {
                    onUpdate: updateWorkItem,
                    availableProjects: workItem.project
                      ? [workItem.project]
                      : [],
                    availableMilestones: workItem.milestone
                      ? [workItem.milestone]
                      : [],
                    availableLabels: workItem.labels ?? [],
                    availableMembers: members,
                    projectIconType: isGitHubIssue ? "github" : undefined,
                    projectReadonly: true,
                  }
                : undefined
            }
            onUpdateWorkItem={canUpdate ? updateWorkItem : undefined}
            onUpdateWorkItemImmediate={canUpdate ? updateWorkItem : undefined}
            teamMembers={members}
            currentUser={currentUser ?? undefined}
            repoPath={repoPath}
            projectSlug={item.target.projectId || null}
            shortId={item.target.workItemId}
            onStartAgent={
              onNavigate
                ? () =>
                    onNavigate({
                      kind: "open_work_item",
                      projectId: item.target.projectId,
                      workItemId: item.target.workItemId,
                      action: "start_agent",
                    })
                : undefined
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
    refreshWorkItem,
  } = useTeamInboxWorkItem(item.target, onWorkItemUpdated);
  const issueMessage = ((): string | null => {
    const keyByIssue: Record<TeamInboxWorkItemIssue, string> = {
      context_unavailable: "teamInbox.errors.workItemContext",
      load_failed: "teamInbox.errors.workItemLoad",
      update_failed: "teamInbox.errors.workItemUpdate",
    };
    return issue ? t(keyByIssue[issue]) : null;
  })();

  return (
    <TeamInboxDetailLayout
      title={workItem?.name ?? item.payload.title}
      subtitle={t("teamInbox.detail.assignedSubtitle")}
      icon={ClipboardList}
      contentLayout="fill"
      unread={item.readAt === null}
      markReadLabel={t("teamInbox.actions.markRead")}
      markUnreadLabel={t("teamInbox.actions.markUnread")}
      openLabel={t("teamInbox.actions.openWorkItem")}
      openIcon={<ExternalLink size={14} aria-hidden />}
      openPlacement="header"
      onMarkRead={onMarkRead ? () => onMarkRead(item) : undefined}
      onMarkUnread={onMarkUnread ? () => onMarkUnread(item) : undefined}
      onOpen={
        onNavigate
          ? () =>
              onNavigate({
                kind: "open_work_item",
                projectId: item.target.projectId,
                workItemId: item.target.workItemId,
              })
          : undefined
      }
    >
      {status === "loading" ? (
        <Placeholder
          variant="loading"
          title={t("teamInbox.loading")}
          fillParentHeight
        />
      ) : status === "ready" && workItem ? (
        <AssignedWorkItemThread
          item={item}
          workItem={workItem}
          repoPath={repoPath}
          members={members}
          currentUser={currentUser}
          issueMessage={issueMessage}
          issueTone={
            issue === "context_unavailable" ? "warning" : issue ? "error" : null
          }
          updateWorkItem={updateWorkItem}
          refreshWorkItem={refreshWorkItem}
          onNavigate={onNavigate}
        />
      ) : (
        <Placeholder
          variant="error"
          title={t("teamInbox.errors.loadTitle")}
          subtitle={issueMessage ?? t("teamInbox.errors.workItemLoad")}
          fillParentHeight
        />
      )}
    </TeamInboxDetailLayout>
  );
};

export default AssignedWorkItemDetail;
