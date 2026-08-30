import React from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { AtIcon, HugeiconsIcon, Message01Icon } from "@src/icons";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";

import type { CommentMentionItem, TeamInboxNavigationIntent } from "../domain";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

export interface CommentMentionDetailProps {
  item: CommentMentionItem;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead?: (item: CommentMentionItem) => void;
  onMarkUnread?: (item: CommentMentionItem) => void;
}

const CommentMentionDetail: React.FC<CommentMentionDetailProps> = ({
  item,
  onNavigate,
  onMarkRead,
  onMarkUnread,
}) => {
  const { t } = useTranslation();
  const targetTitle =
    item.target.kind === "work_item_comment"
      ? item.target.workItemTitle
      : item.target.sessionTitle;

  return (
    <TeamInboxDetailLayout
      title={targetTitle}
      subtitle={t("teamInbox.detail.mentionSubtitle")}
      icon={AtIcon}
      unread={item.readAt === null}
      markReadLabel={t("teamInbox.actions.markRead")}
      markUnreadLabel={t("teamInbox.actions.markUnread")}
      openLabel={t(
        item.target.kind === "work_item_comment"
          ? "teamInbox.actions.openWorkItem"
          : "teamInbox.actions.openSession"
      )}
      openIcon={
        <HugeiconsIcon
          icon={Message01Icon}
          data-icon="message-square"
          size={14}
          aria-hidden
        />
      }
      onMarkRead={onMarkRead ? () => onMarkRead(item) : undefined}
      onMarkUnread={onMarkUnread ? () => onMarkUnread(item) : undefined}
      onOpen={
        onNavigate
          ? () =>
              item.target.kind === "work_item_comment"
                ? onNavigate({
                    kind: "open_work_item",
                    orgId: item.target.orgId,
                    projectId: item.target.projectId,
                    workItemId: item.target.workItemId,
                  })
                : onNavigate({
                    kind: "open_session_comment",
                    sessionId: item.target.sessionId,
                    commentId: item.target.commentId,
                    threadId: item.target.threadId,
                    ...(item.target.anchor
                      ? { anchor: item.target.anchor }
                      : {}),
                  })
          : undefined
      }
      metadata={[
        {
          label: t("teamInbox.fields.session"),
          value: targetTitle,
        },
        {
          label: t("teamInbox.fields.comments"),
          value: item.payload.commentCount,
        },
      ]}
    >
      <div className={CARD_ROW_TOKENS.container}>
        <div className="flex items-center gap-2 text-xs text-text-3">
          <span className="font-semibold text-text-1">
            {item.actor.displayName}
          </span>
          <span>{t("teamInbox.detail.mentionedYou")}</span>
          {item.readAt === null ? (
            <span className="font-semibold text-primary-6">
              {t("teamInbox.status.unread")}
            </span>
          ) : null}
        </div>
        {item.payload.threadCommentCount !== undefined ||
        item.payload.context ? (
          <p className="mt-3 border-l-2 border-border-2 pl-3 text-sm text-text-3">
            {item.payload.threadCommentCount !== undefined
              ? t("teamInbox.detail.threadComments", {
                  count: item.payload.threadCommentCount,
                })
              : item.payload.context}
          </p>
        ) : null}
        <div className="mt-3 text-sm leading-6 text-text-1">
          <Markdown textContent={item.payload.commentBody} />
        </div>
      </div>
    </TeamInboxDetailLayout>
  );
};

export default CommentMentionDetail;
