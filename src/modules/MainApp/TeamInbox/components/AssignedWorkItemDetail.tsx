import { ClipboardList, ExternalLink } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";

import {
  type AssignedWorkItem,
  type TeamInboxNavigationIntent,
  humanizeToken,
  workItemPriorityLabelKey,
  workItemStatusLabelKey,
} from "../domain";
import { useTeamInboxWorkItemBody } from "../useTeamInboxWorkItemBody";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

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
  const { body } = useTeamInboxWorkItemBody(item.target);
  const excerpt = item.payload.summary ?? null;
  const statusLabel = t(workItemStatusLabelKey(item.payload.status), {
    defaultValue: humanizeToken(item.payload.status),
  });
  const priorityLabel = t(workItemPriorityLabelKey(item.payload.priority), {
    defaultValue: humanizeToken(item.payload.priority),
  });

  return (
    <TeamInboxDetailLayout
      title={item.payload.title}
      subtitle={t("teamInbox.detail.assignedSubtitle")}
      icon={ClipboardList}
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
      metadata={[
        { label: t("teamInbox.fields.status"), value: statusLabel },
        { label: t("teamInbox.fields.priority"), value: priorityLabel },
        {
          label: t("teamInbox.fields.assignee"),
          value: item.payload.assigneeName ?? item.payload.assigneeMemberId,
        },
        {
          label: t("teamInbox.fields.workItemId"),
          value: item.target.workItemId,
        },
      ]}
    >
      {body ? (
        <div className="text-sm leading-6 text-text-1">
          <Markdown textContent={body} />
        </div>
      ) : excerpt ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-text-1">
          {excerpt}
        </p>
      ) : null}
    </TeamInboxDetailLayout>
  );
};

export default AssignedWorkItemDetail;
