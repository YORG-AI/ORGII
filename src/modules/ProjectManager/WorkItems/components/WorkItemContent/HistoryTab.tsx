import {
  ArrowRightLeft,
  ArrowUp,
  Bot,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  ActivityTimestamp,
  ConnectedTimelineItem,
  TimelineCard,
  TimelineCardHeader,
  TimelineEventCard,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";
import { MarkdownContent } from "@src/modules/shared/components/MarkdownContent";
import RichMarkdownEditor from "@src/modules/shared/components/RichMarkdownEditor";

import type { HistoryTabProps, TimelineEntry } from "./types";

const OS_AGENT_USERNAME = "os-agent";
const DELEGATION_PREFIX = "Delegation";

const TIMELINE_ICONS: Record<TimelineEntry["type"], React.ReactNode> = {
  [WORK_ITEM_HISTORY_ACTION.CREATED]: <Plus size={12} />,
  [WORK_ITEM_HISTORY_ACTION.UPDATED]: <Pencil size={12} />,
  [WORK_ITEM_HISTORY_ACTION.COMMENTED]: <MessageSquare size={12} />,
  [WORK_ITEM_HISTORY_ACTION.DELETED]: <Trash2 size={12} />,
  [WORK_ITEM_HISTORY_ACTION.RESTORED]: <RotateCcw size={12} />,
  [WORK_ITEM_HISTORY_ACTION.MOVED]: <ArrowRightLeft size={12} />,
};

const HistoryTab: React.FC<HistoryTabProps> = ({
  timelineEntries,
  currentUser,
  isSubscribed,
  onToggleSubscribe,
  commentText,
  onCommentTextChange,
  onCommentSubmit,
  isSubmittingComment,
}) => {
  const { t } = useTranslation("projects");

  return (
    <div className="flex flex-1 flex-col">
      <div
        className={`${DETAIL_PANEL_TOKENS.sectionGap} flex items-center justify-between`}
      >
        <div className="flex items-center gap-3">
          <Button variant="tertiary" size="small" onClick={onToggleSubscribe}>
            {isSubscribed
              ? t("workItems.activity.unsubscribe")
              : t("workItems.activity.subscribe")}
          </Button>
          <Avatar
            size={24}
            style={{
              backgroundColor: currentUser.color || "var(--color-fill-3)",
              color: "var(--color-text-white)",
            }}
          >
            {currentUser.name.charAt(0).toUpperCase()}
          </Avatar>
        </div>
      </div>

      {timelineEntries.length > 0 && (
        <div className={DETAIL_PANEL_TOKENS.sectionGap}>
          <TimelineStack>
            {timelineEntries.map((entry, entryIndex) => {
              const isDelegationComment =
                entry.type === WORK_ITEM_HISTORY_ACTION.COMMENTED &&
                entry.userName === OS_AGENT_USERNAME &&
                entry.descriptions[0]?.startsWith(DELEGATION_PREFIX);
              const isLast = entryIndex === timelineEntries.length - 1;

              if (
                entry.type === WORK_ITEM_HISTORY_ACTION.COMMENTED &&
                !isDelegationComment
              ) {
                const body = entry.descriptions[0] ?? "";
                return (
                  <ConnectedTimelineItem key={entry.id} isLast={isLast}>
                    <TimelineCard
                      copyBody={body}
                      header={
                        <TimelineCardHeader
                          avatar={
                            <Avatar
                              size={18}
                              style={
                                entry.userName === currentUser.name
                                  ? {
                                      backgroundColor:
                                        currentUser.color ||
                                        "var(--color-fill-3)",
                                      color: "var(--color-text-white)",
                                    }
                                  : undefined
                              }
                            >
                              {entry.userName.charAt(0).toUpperCase()}
                            </Avatar>
                          }
                          actor={entry.userName}
                          action="commented"
                          timestamp={entry.timestamp}
                        />
                      }
                    >
                      <MarkdownContent body={body} />
                    </TimelineCard>
                  </ConnectedTimelineItem>
                );
              }

              return (
                <ConnectedTimelineItem key={entry.id} isLast={isLast}>
                  <TimelineEventCard
                    icon={
                      isDelegationComment ? (
                        <Bot size={12} className="text-primary-6" />
                      ) : (
                        TIMELINE_ICONS[entry.type]
                      )
                    }
                  >
                    <span
                      className={
                        isDelegationComment
                          ? "font-medium text-primary-6"
                          : "font-medium text-text-1"
                      }
                    >
                      {isDelegationComment
                        ? t("workItems.activity.agent")
                        : entry.userName}
                    </span>{" "}
                    {entry.descriptions.length === 1 ? (
                      <span>{entry.descriptions[0]}</span>
                    ) : (
                      <details className="mt-0.5">
                        <summary className="inline cursor-pointer marker:text-text-4 hover:text-text-1">
                          {t("workItems.activity.editedFields", {
                            count: entry.descriptions.length,
                          })}
                        </summary>
                        <ul className="m-0 mt-1 list-disc pl-4">
                          {entry.descriptions.map(
                            (description, descriptionIndex) => (
                              <li key={`${entry.id}-${descriptionIndex}`}>
                                {description}
                              </li>
                            )
                          )}
                        </ul>
                      </details>
                    )}
                    <span className="mx-1">·</span>
                    <ActivityTimestamp timestamp={entry.timestamp} />
                  </TimelineEventCard>
                </ConnectedTimelineItem>
              );
            })}
          </TimelineStack>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        <RichMarkdownEditor
          placeholder={t("workItems.activity.commentPlaceholder")}
          value={commentText}
          onChange={(markdown) => onCommentTextChange(markdown)}
          onSubmit={onCommentSubmit}
          minHeight={60}
          maxHeight={120}
          appearance="outlined"
          dataTestId="work-item-comment-editor"
        />
        <div className="flex items-center justify-end">
          <Button
            variant={commentText.trim() ? "primary" : "secondary"}
            shape="circle"
            size="small"
            iconOnly
            icon={<ArrowUp size={16} />}
            title={t("workItems.activity.submitComment", "Submit comment")}
            aria-label={t("workItems.activity.submitComment", "Submit comment")}
            onClick={onCommentSubmit}
            disabled={!commentText.trim() || isSubmittingComment}
            loading={isSubmittingComment}
          />
        </div>
      </div>
    </div>
  );
};

export default HistoryTab;
