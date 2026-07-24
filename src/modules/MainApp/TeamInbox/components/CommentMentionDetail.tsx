import { AtSign, MessageSquare } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";

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

  return (
    <TeamInboxDetailLayout
      title={item.target.sessionTitle}
      subtitle={t("teamInbox.detail.mentionSubtitle")}
      icon={AtSign}
      unread={item.readAt === null}
      markReadLabel={t("teamInbox.actions.markRead")}
      markUnreadLabel={t("teamInbox.actions.markUnread")}
      openLabel={t("teamInbox.actions.openSession")}
      openIcon={<MessageSquare size={14} aria-hidden />}
      onMarkRead={onMarkRead ? () => onMarkRead(item) : undefined}
      onMarkUnread={onMarkUnread ? () => onMarkUnread(item) : undefined}
      onOpen={
        onNavigate
          ? () =>
              onNavigate({
                kind: "open_session_comment",
                sessionId: item.target.sessionId,
                commentId: item.target.commentId,
                threadId: item.target.threadId,
                ...(item.target.anchor ? { anchor: item.target.anchor } : {}),
              })
          : undefined
      }
      metadata={[
        {
          label: t("teamInbox.fields.session"),
          value: item.target.sessionTitle,
        },
        {
          label: t("teamInbox.fields.comments"),
          value: item.payload.commentCount,
        },
        {
          label: t("teamInbox.fields.threadId"),
          value: item.target.threadId,
        },
        {
          label: t("teamInbox.fields.commentId"),
          value: item.target.commentId,
        },
      ]}
    >
      <div>
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
        {item.payload.context ? (
          <p className="mt-3 border-l-2 border-border-2 pl-3 text-sm text-text-3">
            {item.payload.context}
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
