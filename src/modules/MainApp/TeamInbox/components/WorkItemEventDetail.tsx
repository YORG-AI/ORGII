import React from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import {
  AlertCircleIcon,
  ArchiveArrowUpIcon,
  ArchiveIcon,
  CircleCheckBigIcon,
  HugeiconsIcon,
  Notification01Icon,
  SquareArrowUpRight02Icon,
} from "@src/icons";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";

import {
  type TeamInboxNavigationIntent,
  type WorkItemUpdateItem,
  humanizeToken,
  workItemEventLabelKey,
} from "../domain";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

export interface WorkItemEventDetailProps {
  item: WorkItemUpdateItem;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead?: (item: WorkItemUpdateItem) => void;
  onMarkUnread?: (item: WorkItemUpdateItem) => void;
  archived?: boolean;
  dispositionPending?: boolean;
  onArchive?: (item: WorkItemUpdateItem) => void;
  onUnarchive?: (item: WorkItemUpdateItem) => void;
}

const WorkItemEventDetail: React.FC<WorkItemEventDetailProps> = ({
  item,
  onNavigate,
  onMarkRead,
  onMarkUnread,
  archived = false,
  dispositionPending = false,
  onArchive,
  onUnarchive,
}) => {
  const { t } = useTranslation();
  const eventLabel = t(workItemEventLabelKey(item.payload.eventKind), {
    defaultValue: humanizeToken(item.payload.eventKind),
  });
  const icon =
    item.kind === "work_item_run_failed"
      ? AlertCircleIcon
      : item.kind === "child_completed"
        ? CircleCheckBigIcon
        : Notification01Icon;

  return (
    <TeamInboxDetailLayout
      title={item.payload.title}
      subtitle={eventLabel}
      icon={icon}
      unread={item.readAt === null}
      markReadLabel={t("teamInbox.actions.markRead")}
      markUnreadLabel={t("teamInbox.actions.markUnread")}
      openLabel={t("teamInbox.actions.openWorkItem")}
      openIcon={
        <HugeiconsIcon
          icon={SquareArrowUpRight02Icon}
          data-icon="square-arrow-out-up-right"
          size={14}
          strokeWidth={1.75}
          aria-hidden
        />
      }
      onMarkRead={onMarkRead ? () => onMarkRead(item) : undefined}
      onMarkUnread={onMarkUnread ? () => onMarkUnread(item) : undefined}
      headerDispositionAction={
        archived && onUnarchive
          ? {
              label: t("teamInbox.actions.unarchive"),
              icon: (
                <HugeiconsIcon
                  icon={ArchiveArrowUpIcon}
                  data-icon="archive-restore"
                  size={14}
                  strokeWidth={1.8}
                  aria-hidden
                />
              ),
              onClick: () => onUnarchive(item),
              testId: "team-inbox-unarchive",
              disabled: dispositionPending,
            }
          : !archived && onArchive
            ? {
                label: t("teamInbox.actions.archive"),
                icon: (
                  <HugeiconsIcon
                    icon={ArchiveIcon}
                    data-icon="archive"
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden
                  />
                ),
                onClick: () => onArchive(item),
                testId: "team-inbox-archive",
                disabled: dispositionPending,
              }
            : undefined
      }
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
      <div className={CARD_ROW_TOKENS.container}>
        <div className="flex items-center gap-2 text-xs text-text-3">
          <span className="font-semibold text-text-1">{eventLabel}</span>
          <span>{humanizeToken(item.payload.status)}</span>
          <span>{humanizeToken(item.payload.priority)}</span>
          {item.actor.displayName ? (
            <span>{item.actor.displayName}</span>
          ) : null}
          {item.readAt === null ? (
            <span className="font-semibold text-primary-6">
              {t("teamInbox.status.unread")}
            </span>
          ) : null}
        </div>
        {item.payload.summary ? (
          <div className="mt-3 text-sm leading-6 text-text-1">
            <Markdown textContent={item.payload.summary} />
          </div>
        ) : null}
      </div>
    </TeamInboxDetailLayout>
  );
};

export default WorkItemEventDetail;
