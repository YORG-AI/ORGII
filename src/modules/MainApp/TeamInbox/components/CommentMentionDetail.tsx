import React from "react";
import { useTranslation } from "react-i18next";

import PersonAvatar from "@src/components/PersonAvatar";
import { AtIcon, HugeiconsIcon, LinkSquare02Icon } from "@src/icons";
import { WORK_ITEM_THREAD_TOKENS } from "@src/modules/ProjectManager/WorkItems/components/WorkItemThread";
import {
  ConnectedTimelineItem,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";

import type { CommentMentionItem, TeamInboxNavigationIntent } from "../domain";
import TeamInboxDetailLayout from "./TeamInboxDetailLayout";

export interface CommentMentionDetailProps {
  item: CommentMentionItem;
  onClose?: () => void;
  onNavigate?: (intent: TeamInboxNavigationIntent) => void;
  onMarkRead?: (item: CommentMentionItem) => void;
  onMarkUnread?: (item: CommentMentionItem) => void;
}

const CommentMentionDetail: React.FC<CommentMentionDetailProps> = ({
  item,
  onClose,
  onNavigate,
  onMarkRead,
  onMarkUnread,
}) => {
  const { t } = useTranslation();
  const targetTitle =
    item.target.kind === "work_item_comment"
      ? item.target.workItemTitle
      : item.target.sessionTitle;
  const commentCount =
    item.payload.threadCommentCount ?? item.payload.commentCount;

  return (
    <TeamInboxDetailLayout
      title={targetTitle}
      subtitle={t("teamInbox.detail.mentionSubtitle")}
      icon={AtIcon}
      unread={item.readAt === null}
      markReadLabel={t("teamInbox.actions.markRead")}
      markUnreadLabel={t("teamInbox.actions.markUnread")}
      openLabel={t("common:actions.openInNewTab")}
      openIcon={
        <HugeiconsIcon
          icon={LinkSquare02Icon}
          data-icon="link-square-02"
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
      onClose={onClose}
    >
      <div
        className="scrollbar-hide min-h-0 flex-1 overflow-y-auto"
        data-testid="team-inbox-mention-thread"
      >
        <div className={WORK_ITEM_THREAD_TOKENS.contentColumn}>
          <TimelineStack>
            <ConnectedTimelineItem isLast>
              <TimelineCard
                copyBody={item.payload.commentBody}
                header={
                  <TimelineCardHeader
                    avatar={
                      <PersonAvatar
                        size={18}
                        name={item.actor.displayName}
                        src={item.actor.avatarUrl}
                      />
                    }
                    indicator={
                      item.readAt === null ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-primary-6"
                          title={t("teamInbox.status.unread")}
                          aria-label={t("teamInbox.status.unread")}
                        />
                      ) : undefined
                    }
                    actor={item.actor.displayName}
                    action={
                      <>
                        {t("teamInbox.detail.mentionedYou")}
                        <span className="text-text-4">
                          {" · "}
                          {t("teamInbox.detail.threadComments", {
                            count: commentCount,
                          })}
                        </span>
                      </>
                    }
                    timestamp={item.occurredAt}
                  />
                }
              >
                {item.payload.context &&
                item.payload.threadCommentCount === undefined ? (
                  <p className="mb-3 border-l-2 border-border-2 pl-3 text-xs leading-5 text-text-3">
                    {item.payload.context}
                  </p>
                ) : null}
                <MarkdownContent
                  body={item.payload.commentBody}
                  fadeFrom="from-chat-pane"
                />
              </TimelineCard>
            </ConnectedTimelineItem>
          </TimelineStack>
        </div>
      </div>
    </TeamInboxDetailLayout>
  );
};

export default CommentMentionDetail;
