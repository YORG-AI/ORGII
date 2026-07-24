import { ClipboardList, ExternalLink } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import {
  WorkItemContent,
  WorkItemProperties,
} from "@src/modules/ProjectManager/WorkItems/components";
import { PropertiesRailFrame } from "@src/modules/ProjectManager/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import {
  type AssignedWorkItem,
  type TeamInboxNavigationIntent,
  isGitHubIssueStatus,
} from "../domain";
import { useTeamInboxWorkItem } from "../useTeamInboxWorkItem";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

/** Matches the work-item pane's info rail so both surfaces read identically. */
const PROPERTIES_RAIL_WIDTH = 240;

export interface AssignedWorkItemDetailProps {
  item: AssignedWorkItem;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead?: (item: AssignedWorkItem) => void;
  onMarkUnread?: (item: AssignedWorkItem) => void;
}

const AssignedWorkItemDetail: React.FC<AssignedWorkItemDetailProps> = ({
  item,
  onNavigate,
  onMarkRead,
  onMarkUnread,
}) => {
  const { t } = useTranslation();
  const { workItem, loading, updateWorkItem } = useTeamInboxWorkItem(
    item.target
  );
  const isGitHubIssue = isGitHubIssueStatus(item.payload.status);

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
      {loading ? (
        <Placeholder
          variant="loading"
          title={t("teamInbox.loading")}
          fillParentHeight
        />
      ) : workItem ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <WorkItemContent
              workItem={workItem}
              onUpdateWorkItem={updateWorkItem}
              onUpdateWorkItemImmediate={updateWorkItem}
              projectSlug={item.target.projectId || null}
              shortId={item.target.workItemId}
              onOpenSession={
                onNavigate
                  ? (sessionId) =>
                      onNavigate({
                        kind: "open_session_comment",
                        sessionId,
                        commentId: "",
                        threadId: "",
                      })
                  : undefined
              }
            />
          </div>
          {/* The inbox detail is narrower than the work-item pane, so the rail
              only appears once there is room for it beside the content. */}
          <div className="hidden @[720px]:block">
            <PropertiesRailFrame width={PROPERTIES_RAIL_WIDTH} floatingContent>
              <WorkItemProperties
                workItem={workItem}
                onUpdate={updateWorkItem}
                availableProjects={workItem.project ? [workItem.project] : []}
                availableMilestones={
                  workItem.milestone ? [workItem.milestone] : []
                }
                availableLabels={workItem.labels ?? []}
                availableMembers={workItem.assignee ? [workItem.assignee] : []}
                projectIconType={isGitHubIssue ? "github" : undefined}
                projectReadonly
              />
            </PropertiesRailFrame>
          </div>
        </div>
      ) : (
        <Placeholder
          variant="error"
          title={t("teamInbox.errors.loadTitle")}
          fillParentHeight
        />
      )}
    </TeamInboxDetailLayout>
  );
};

export default AssignedWorkItemDetail;
