import { ClipboardList, ExternalLink } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import {
  WorkItemContent,
  WorkItemProperties,
} from "@src/modules/ProjectManager/WorkItems/components";
import type { WorkItemPropertyFieldKey } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import {
  type AssignedWorkItem,
  type TeamInboxNavigationIntent,
  isGitHubIssueStatus,
} from "../domain";
import { useTeamInboxWorkItem } from "../useTeamInboxWorkItem";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

const WORK_ITEM_THREAD_PROPERTY_FIELDS: WorkItemPropertyFieldKey[] = [
  "project",
  "status",
  "priority",
  "assignee",
  "reviewer",
  "date",
];

export interface AssignedWorkItemDetailProps {
  item: AssignedWorkItem;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead?: (item: AssignedWorkItem) => void;
  onMarkUnread?: (item: AssignedWorkItem) => void;
}

interface AssignedWorkItemThreadProps {
  item: AssignedWorkItem;
  workItem: WorkItem;
  repoPath: string | null;
  members: Person[];
  error: string | null;
  updateWorkItem: (updates: Partial<WorkItem>) => void;
  refreshWorkItem: () => void;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
}

const AssignedWorkItemThread: React.FC<AssignedWorkItemThreadProps> = ({
  item,
  workItem,
  repoPath,
  members,
  error,
  updateWorkItem,
  refreshWorkItem,
  onNavigate,
}) => {
  const canUpdate = Boolean(item.target.projectId);
  const isGitHubIssue = isGitHubIssueStatus(item.payload.status);

  const properties = canUpdate ? (
    <WorkItemProperties
      workItem={workItem}
      onUpdate={updateWorkItem}
      availableProjects={workItem.project ? [workItem.project] : []}
      availableMilestones={workItem.milestone ? [workItem.milestone] : []}
      availableLabels={workItem.labels ?? []}
      availableMembers={members}
      projectIconType={isGitHubIssue ? "github" : undefined}
      projectReadonly
      fieldVariant="pill"
      pillLayout="wrap"
      visibleFields={WORK_ITEM_THREAD_PROPERTY_FIELDS}
      showMoreMenu
    />
  ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {error ? (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-30 border-b border-danger-3 bg-danger-1 px-3 py-2 text-xs text-danger-6"
        >
          {error}
        </div>
      ) : null}
      <div className="min-w-0 flex-1 overflow-hidden">
        <WorkItemContent
          workItem={workItem}
          presentation="thread"
          headerProperties={properties}
          onUpdateWorkItem={canUpdate ? updateWorkItem : undefined}
          onUpdateWorkItemImmediate={canUpdate ? updateWorkItem : undefined}
          teamMembers={members}
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
  );
};

const AssignedWorkItemDetail: React.FC<AssignedWorkItemDetailProps> = ({
  item,
  onNavigate,
  onMarkRead,
  onMarkUnread,
}) => {
  const { t } = useTranslation();
  const {
    workItem,
    status,
    error,
    repoPath,
    members,
    updateWorkItem,
    refreshWorkItem,
  } = useTeamInboxWorkItem(item.target);

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
          error={error}
          updateWorkItem={updateWorkItem}
          refreshWorkItem={refreshWorkItem}
          onNavigate={onNavigate}
        />
      ) : (
        <Placeholder
          variant="error"
          title={t("teamInbox.errors.loadTitle")}
          subtitle={error ?? undefined}
          fillParentHeight
        />
      )}
    </TeamInboxDetailLayout>
  );
};

export default AssignedWorkItemDetail;
