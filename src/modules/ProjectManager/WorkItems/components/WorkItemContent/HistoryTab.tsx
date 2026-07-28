import {
  ArrowRightLeft,
  ArrowUp,
  Bell,
  BellOff,
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
import ComposerShell from "@src/components/ComposerShell";
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
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";

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
  presentation = "default",
}) => {
  const { t } = useTranslation("projects");
  const isThread = presentation === "thread";

  const subscriptionControl = (
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      icon={
        isSubscribed ? (
          <BellOff size={13} aria-hidden />
        ) : (
          <Bell size={13} aria-hidden />
        )
      }
      onClick={onToggleSubscribe}
      data-testid="work-item-subscription-toggle"
    >
      {isSubscribed
        ? t("workItems.activity.unsubscribe")
        : t("workItems.activity.subscribe")}
    </Button>
  );

  const timeline = timelineEntries.length > 0 && (
    <div className={isThread ? "" : DETAIL_PANEL_TOKENS.sectionGap}>
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
                          src={
                            entry.userAvatar ||
                            (entry.userName === currentUser.name
                              ? currentUser.avatar
                              : undefined)
                          }
                          style={
                            entry.userColor ||
                            entry.userName === currentUser.name
                              ? {
                                  backgroundColor:
                                    entry.userColor ||
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
  );

  const hasComment = commentText.trim().length > 0;
  const submitButton = (
    <Button
      variant={hasComment ? "primary" : isThread ? "tertiary" : "secondary"}
      appearance={!hasComment && isThread ? "ghost" : undefined}
      shape="circle"
      size="small"
      iconOnly
      icon={<ArrowUp size={16} aria-hidden />}
      title={t("workItems.activity.submitComment", "Submit comment")}
      aria-label={t("workItems.activity.submitComment", "Submit comment")}
      onClick={onCommentSubmit}
      disabled={!hasComment || isSubmittingComment}
      loading={isSubmittingComment}
    />
  );

  const composer = isThread ? (
    <div className="flex items-start gap-2.5">
      <Avatar
        size={28}
        src={currentUser.avatar}
        style={{
          backgroundColor: currentUser.color || "var(--color-fill-3)",
          color: "var(--color-text-white)",
        }}
      >
        {currentUser.name.charAt(0).toUpperCase()}
      </Avatar>
      <ComposerShell
        variant="comment"
        className="min-w-0 flex-1"
        data-testid="work-item-comment-composer"
      >
        <RichMarkdownEditor
          className="min-w-0 flex-1"
          placeholder={t("workItems.activity.commentPlaceholder")}
          value={commentText}
          onChange={(markdown) => onCommentTextChange(markdown)}
          onSubmit={onCommentSubmit}
          minHeight={28}
          maxHeight={120}
          appearance="plain"
          showTabs={false}
          matchMarkdownPreview={false}
          dataTestId="work-item-comment-editor"
        />
        {submitButton}
      </ComposerShell>
    </div>
  ) : (
    <div className="mt-auto flex flex-col gap-2">
      <div className="min-w-0 flex-1">
        <RichMarkdownEditor
          placeholder={t("workItems.activity.commentPlaceholder")}
          value={commentText}
          onChange={(markdown) => onCommentTextChange(markdown)}
          onSubmit={onCommentSubmit}
          minHeight={60}
          maxHeight={120}
          appearance="outlined"
          showTabs
          dataTestId="work-item-comment-editor"
        />
        <div className="mt-2 flex items-center justify-end">{submitButton}</div>
      </div>
    </div>
  );

  if (isThread) {
    return (
      <section data-testid="work-item-thread-activity">
        <CollapsibleSection
          title={`${t("workItems.activity.title")} · ${timelineEntries.length}`}
          defaultOpen={false}
          actions={subscriptionControl}
          compact
          headerRowClassName="!mb-0 min-h-8"
          titleButtonTestId="work-item-thread-activity-toggle"
        >
          <div className="flex flex-col gap-3 pt-3">
            {timeline}
            {composer}
          </div>
        </CollapsibleSection>
      </section>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div
        className={`${DETAIL_PANEL_TOKENS.sectionGap} flex items-center justify-between`}
      >
        <div className="flex items-center gap-3">
          {subscriptionControl}
          <Avatar
            size={24}
            src={currentUser.avatar}
            style={{
              backgroundColor: currentUser.color || "var(--color-fill-3)",
              color: "var(--color-text-white)",
            }}
          >
            {currentUser.name.charAt(0).toUpperCase()}
          </Avatar>
        </div>
      </div>

      {timeline}
      {composer}
    </div>
  );
};

export default HistoryTab;
