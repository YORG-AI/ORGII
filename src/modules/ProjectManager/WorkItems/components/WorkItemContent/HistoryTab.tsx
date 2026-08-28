import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import ComposerShell from "@src/components/ComposerShell";
import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  ArrowRight01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  CornerUpLeftIcon,
  HugeiconsIcon,
  Notification01Icon,
  NotificationOff01Icon,
  RotateLeft01Icon,
} from "@src/icons";
import { MarkdownContent } from "@src/modules/shared/components/ActivityTimeline";
import MarkdownTextareaEditor, {
  type MarkdownEditorMode,
} from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import { ScrollTrailTarget } from "@src/modules/shared/layouts/blocks";
import type { Person } from "@src/types/core/shared";
import type { WorkItemComment } from "@src/types/core/workItem";

import { WorkItemActivityTimeline } from "./WorkItemActivityTimeline";
import WorkItemMentionPicker from "./WorkItemMentionPicker";
import { partitionDiscussionTimeline } from "./discussionTimelineModel";
import type { HistoryTabProps } from "./types";

interface DiscussionThreadsProps {
  comments: WorkItemComment[];
  currentUser: Person;
  teamMembers: Person[];
  onReply?: (commentId: string | null) => void;
  onResolve?: (threadId: string, conclusionCommentId?: string) => void;
  onReopen?: (threadId: string) => void;
}

function commentAuthor(
  comment: WorkItemComment,
  currentUser: Person,
  teamMembers: Person[]
): Person {
  return (
    teamMembers.find((member) => member.id === comment.author) ??
    (currentUser.id === comment.author
      ? currentUser
      : { id: comment.author, name: comment.author })
  );
}

const DiscussionThreads: React.FC<DiscussionThreadsProps> = ({
  comments,
  currentUser,
  teamMembers,
  onReply,
  onResolve,
  onReopen,
}) => {
  const { t } = useTranslation("projects");
  const roots = comments.filter((comment) => !comment.parent_id);

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="work-item-discussion-threads"
    >
      {roots.map((root) => {
        const threadId = root.thread_id || root.id;
        const replies = comments.filter(
          (comment) => comment.id !== root.id && comment.thread_id === threadId
        );
        const conclusionId = replies.at(-1)?.id ?? root.id;
        const threadComments = [root, ...replies];
        return (
          <article
            key={root.id}
            className="overflow-hidden rounded-xl border border-border-1 bg-bg-2"
            data-testid={`work-item-discussion-thread-${threadId}`}
          >
            <div className="flex items-center justify-between gap-3 border-b border-border-1 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2 text-xs text-text-3">
                <span>
                  {t("workItems.activity.messageCount", {
                    defaultValue: `${replies.length + 1} messages`,
                    count: replies.length + 1,
                  })}
                </span>
                {root.resolved_at ? (
                  <span className="inline-flex items-center gap-1 text-success-6">
                    <HugeiconsIcon
                      icon={CheckmarkCircle01Icon}
                      data-icon="check-circle-2"
                      size={12}
                      aria-hidden
                    />
                    {t("workItems.activity.resolved", {
                      defaultValue: "Resolved",
                    })}
                  </span>
                ) : null}
              </div>
              {(root.resolved_at && onReopen) ||
              (!root.resolved_at && onResolve) ? (
                <Button
                  variant="tertiary"
                  appearance="ghost"
                  size="mini"
                  icon={
                    root.resolved_at ? (
                      <HugeiconsIcon
                        icon={RotateLeft01Icon}
                        data-icon="rotate-ccw"
                        size={13}
                        aria-hidden
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={CheckmarkCircle01Icon}
                        data-icon="check-circle-2"
                        size={13}
                        aria-hidden
                      />
                    )
                  }
                  onClick={() =>
                    root.resolved_at
                      ? onReopen?.(threadId)
                      : onResolve?.(threadId, conclusionId)
                  }
                  data-testid={`work-item-discussion-${root.resolved_at ? "reopen" : "resolve"}-${threadId}`}
                >
                  {root.resolved_at
                    ? t("workItems.activity.reopen", {
                        defaultValue: "Reopen",
                      })
                    : t("workItems.activity.resolve", {
                        defaultValue: "Resolve",
                      })}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col divide-y divide-border-1">
              {threadComments.map((comment, index) => {
                const author = commentAuthor(comment, currentUser, teamMembers);
                return (
                  <div
                    key={comment.id}
                    className={index === 0 ? "p-3" : "bg-fill-1 p-3 pl-8"}
                    data-testid={`work-item-discussion-comment-${comment.id}`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Avatar
                        size={22}
                        src={author.avatar}
                        style={{
                          backgroundColor:
                            author.color || "var(--color-fill-3)",
                          color: "var(--color-text-white)",
                        }}
                      >
                        {author.name.charAt(0).toUpperCase()}
                      </Avatar>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">
                        {author.name}
                      </span>
                      {comment.conclusion ? (
                        <span className="text-success-7 rounded-full bg-success-1 px-2 py-0.5 text-xs">
                          {t("workItems.activity.conclusion", {
                            defaultValue: "Conclusion",
                          })}
                        </span>
                      ) : null}
                      <time className="text-xs text-text-4">
                        {new Date(comment.created_at).toLocaleString()}
                      </time>
                    </div>
                    <MarkdownContent body={comment.content} clamped={false} />
                    {onReply ? (
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="tertiary"
                          appearance="ghost"
                          size="mini"
                          icon={
                            <HugeiconsIcon
                              icon={CornerUpLeftIcon}
                              data-icon="corner-up-left"
                              size={13}
                              aria-hidden
                            />
                          }
                          onClick={() => onReply(comment.id)}
                          data-testid={`work-item-discussion-reply-${comment.id}`}
                        >
                          {t("workItems.activity.reply", {
                            defaultValue: "Reply",
                          })}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
};

const HistoryTab: React.FC<HistoryTabProps> = ({
  timelineEntries,
  currentUser,
  isSubscribed,
  onToggleSubscribe,
  commentText,
  onCommentTextChange,
  mentionRefs = [],
  onMentionRefsChange = () => undefined,
  teamMembers = [],
  agents = [],
  agentOrgs = [],
  onCommentSubmit,
  isSubmittingComment,
  comments = [],
  replyToCommentId,
  onReplyToComment,
  onResolveThread,
  onReopenThread,
  presentation = "default",
  canComment = true,
  threadNavigation,
  triggerPreview,
}) => {
  const { t } = useTranslation("projects");
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>("write");
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
          <HugeiconsIcon
            icon={NotificationOff01Icon}
            data-icon="bell-off"
            size={13}
            aria-hidden
          />
        ) : (
          <HugeiconsIcon
            icon={Notification01Icon}
            data-icon="bell"
            size={13}
            aria-hidden
          />
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
  const discussionThreads =
    comments.length > 0 ? (
      <DiscussionThreads
        comments={comments}
        currentUser={currentUser}
        teamMembers={teamMembers}
        onReply={onReplyToComment}
        onResolve={onResolveThread}
        onReopen={onReopenThread}
      />
    ) : null;
  const activityTimeline = (
    <WorkItemActivityTimeline
      entries={activityEntries}
      currentUser={currentUser}
      compact
    />
  );

  const hasComment = commentText.trim().length > 0;
  const PREVIEW_REASON_KEYS: Record<string, string> = {
    mention: "previewMentionResume",
    mention_start: "previewMentionStart",
    mention_unroutable: "previewMentionUnroutable",
    thread_owner: "previewThread",
    thread_continuation: "previewThread",
    assignee: "previewAssignee",
    assignee_start: "previewAssigneeStart",
    note_only: "previewNoteOnly",
    no_linked_session: "previewNoSession",
  };
  const triggerPreviewChip =
    hasComment && triggerPreview ? (
      <div
        className="flex items-center gap-1.5 self-start rounded-full bg-fill-2 px-2 py-0.5 text-[11px] text-text-3"
        title={triggerPreview.targetSessionId ?? undefined}
        data-testid="work-item-discussion-trigger-preview"
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            triggerPreview.willWake ? "bg-primary-6" : "bg-fill-4"
          }`}
          aria-hidden
        />
        {t(
          `workItems.discussion.${
            PREVIEW_REASON_KEYS[triggerPreview.reason] ??
            (triggerPreview.willWake ? "previewWillWake" : "previewNoSession")
          }`
        )}
        {triggerPreview.willCoalesce ? (
          <span className="text-text-4">
            · {t("workItems.discussion.previewCoalesce")}
          </span>
        ) : null}
      </div>
    ) : null;
  const submitButton = (
    <Button
      variant={hasComment ? "primary" : isThread ? "tertiary" : "secondary"}
      appearance={!hasComment && isThread ? "ghost" : undefined}
      shape="circle"
      size="small"
      iconOnly
      icon={
        <HugeiconsIcon
          icon={ArrowUp02Icon}
          data-icon="arrow-up"
          size={16}
          aria-hidden
        />
      }
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
        {replyToCommentId ? (
          <div
            className="flex items-center justify-between gap-2 rounded-lg bg-fill-2 px-2 py-1 text-xs text-text-3"
            data-testid="work-item-discussion-reply-context"
          >
            <span className="truncate">
              {t("workItems.activity.replyingInThread", {
                defaultValue: "Replying in thread",
              })}
            </span>
            <Button
              variant="tertiary"
              appearance="ghost"
              size="mini"
              shape="circle"
              iconOnly
              icon={
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  data-icon="x"
                  size={12}
                  aria-hidden
                />
              }
              aria-label={t("workItems.activity.cancelReply", {
                defaultValue: "Cancel reply",
              })}
              title={t("workItems.activity.cancelReply", {
                defaultValue: "Cancel reply",
              })}
              onClick={() => onReplyToComment?.(null)}
            />
          </div>
        ) : null}
        {triggerPreviewChip}
        <ComposerShell
          variant="comment"
          className="!flex-col !items-stretch"
          data-testid="work-item-comment-composer"
        >
          <MarkdownTextareaEditor
            className="min-w-0 flex-1"
            placeholder={t("workItems.activity.commentPlaceholder")}
            value={commentText}
            onChange={(markdown) => onCommentTextChange(markdown)}
            onSubmit={onCommentSubmit}
            minHeight={28}
            maxHeight={120}
            appearance="plain"
            mode={editorMode}
            onModeChange={setEditorMode}
            dataTestId="work-item-comment-editor"
          />
          <div className="flex items-center justify-between gap-2">
            <MarkdownEditorModeSwitch
              mode={editorMode}
              onModeChange={setEditorMode}
              disabled={isSubmittingComment}
              dataTestId="work-item-comment-mode-switch"
            />
            <div className="flex min-w-0 items-center justify-end gap-1.5">
              <WorkItemMentionPicker
                members={teamMembers}
                agents={agents}
                agentOrgs={agentOrgs}
                currentUserId={currentUser.id}
                value={mentionRefs}
                disabled={isSubmittingComment}
                onChange={onMentionRefsChange}
              />
              {submitButton}
            </div>
          </div>
        </ComposerShell>
      </div>
    </div>
  ) : (
    <div
      className={`mt-auto flex flex-col gap-2 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
      data-testid="work-item-default-comment-dock"
    >
      <div className="min-w-0 flex-1">
        {triggerPreviewChip ? (
          <div className="mb-2">{triggerPreviewChip}</div>
        ) : null}
        <MarkdownTextareaEditor
          placeholder={t("workItems.activity.commentPlaceholder")}
          value={commentText}
          onChange={(markdown) => onCommentTextChange(markdown)}
          onSubmit={onCommentSubmit}
          minHeight={60}
          maxHeight={120}
          appearance="outlined"
          mode={editorMode}
          onModeChange={setEditorMode}
          dataTestId="work-item-comment-editor"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <MarkdownEditorModeSwitch
            mode={editorMode}
            onModeChange={setEditorMode}
            disabled={isSubmittingComment}
            dataTestId="work-item-comment-mode-switch"
          />
          <div className="flex min-w-0 items-center justify-end gap-1.5">
            <WorkItemMentionPicker
              members={teamMembers}
              agents={agents}
              agentOrgs={agentOrgs}
              currentUserId={currentUser.id}
              value={mentionRefs}
              disabled={isSubmittingComment}
              onChange={onMentionRefsChange}
            />
            {submitButton}
          </div>
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
        {comments.length > 0 ? (
          discussionThreads
        ) : discussionEntries.length > 0 ? (
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
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
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
              className={`sticky bottom-0 z-10 bg-transparent pt-2 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
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
