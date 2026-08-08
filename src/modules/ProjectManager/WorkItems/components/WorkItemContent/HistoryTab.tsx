import { ArrowUp, Bell, BellOff, ChevronRight } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import ComposerShell from "@src/components/ComposerShell";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import RichMarkdownEditor from "@src/modules/shared/components/RichMarkdownEditor";
import { ScrollTrailTarget } from "@src/modules/shared/layouts/blocks";

import { WorkItemActivityTimeline } from "./WorkItemActivityTimeline";
import WorkItemMentionPicker from "./WorkItemMentionPicker";
import { partitionDiscussionTimeline } from "./discussionTimelineModel";
import type { HistoryTabProps } from "./types";

const HistoryTab: React.FC<HistoryTabProps> = ({
  timelineEntries,
  currentUser,
  isSubscribed,
  onToggleSubscribe,
  commentText,
  onCommentTextChange,
  mentionedUserIds = [],
  onMentionedUserIdsChange = () => undefined,
  teamMembers = [],
  onCommentSubmit,
  isSubmittingComment,
  presentation = "default",
  canComment = true,
  threadNavigation,
}) => {
  const { t } = useTranslation("projects");
  const isThread = presentation === "thread";
  const { discussionEntries, activityEntries } = useMemo(
    () => partitionDiscussionTimeline(timelineEntries),
    [timelineEntries]
  );

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

  const timeline = (
    <WorkItemActivityTimeline
      entries={timelineEntries}
      currentUser={currentUser}
      compact={isThread}
      navigationEnabled={isThread}
    />
  );
  const discussionTimeline = (
    <WorkItemActivityTimeline
      entries={discussionEntries}
      currentUser={currentUser}
      compact
      navigationEnabled={isThread}
    />
  );
  const activityTimeline = (
    <WorkItemActivityTimeline
      entries={activityEntries}
      currentUser={currentUser}
      compact
    />
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
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <ComposerShell
          variant="comment"
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
            matchMarkdownPreview={false}
            toolbarSize="mini"
            toolbarDropdownPosition="top-start"
            dataTestId="work-item-comment-editor"
          />
          {submitButton}
        </ComposerShell>
        <WorkItemMentionPicker
          members={teamMembers}
          currentUserId={currentUser.id}
          value={mentionedUserIds}
          disabled={isSubmittingComment}
          onChange={onMentionedUserIdsChange}
        />
      </div>
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
          toolbarSize="mini"
          toolbarDropdownPosition="top-start"
          dataTestId="work-item-comment-editor"
        />
        <div className="mt-2 flex items-center justify-end">{submitButton}</div>
        <div className="mt-2">
          <WorkItemMentionPicker
            members={teamMembers}
            currentUserId={currentUser.id}
            value={mentionedUserIds}
            disabled={isSubmittingComment}
            onChange={onMentionedUserIdsChange}
          />
        </div>
      </div>
    </div>
  );

  if (isThread) {
    return (
      <section
        className="flex min-w-0 flex-col gap-3"
        data-testid="work-item-thread-discussion"
        aria-label={t("workItems.activity.discussionTitle")}
      >
        <div className="flex min-h-8 items-center justify-between gap-3 border-b border-border-1 pb-2">
          {threadNavigation}
          {subscriptionControl}
        </div>
        {discussionEntries.length > 0 ? (
          discussionTimeline
        ) : (
          <div
            className="rounded-xl border border-dashed border-border-1 px-4 py-8 text-center text-[13px] text-text-3"
            data-testid="work-item-thread-discussion-empty"
          >
            {t("workItems.activity.noComments")}
          </div>
        )}
        {activityEntries.length > 0 ? (
          <ScrollTrailTarget label={t("workItems.activity.activityHistory")}>
            <details
              className="group overflow-hidden rounded-xl border border-border-1 bg-bg-2"
              data-testid="work-item-thread-activity-history"
            >
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-[12px] font-medium text-text-2 marker:hidden [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">
                  {t("workItems.activity.activityHistory")}
                </span>
                <span className="shrink-0 font-normal tabular-nums text-text-4">
                  {t("workItems.activity.activityHistoryCount", {
                    count: activityEntries.length,
                  })}
                </span>
                <ChevronRight
                  size={14}
                  aria-hidden
                  className="shrink-0 text-text-4 transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="border-t border-border-1 p-2">
                {activityTimeline}
              </div>
            </details>
          </ScrollTrailTarget>
        ) : null}
        {canComment ? (
          <ScrollTrailTarget label={t("workItems.activity.commentPlaceholder")}>
            <div
              className="sticky bottom-0 z-10 bg-transparent pt-2"
              data-testid="work-item-thread-comment-dock"
            >
              {composer}
            </div>
          </ScrollTrailTarget>
        ) : null}
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
      {canComment ? composer : null}
    </div>
  );
};

export default HistoryTab;
