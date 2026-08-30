/**
 * PrConversationTab
 *
 * GitHub-style PR conversation: a flow-title header (title · #number · status
 * pill · merge-flow sentence) over the PR description and the interleaved
 * comment/review timeline. A bottom composer posts a conversation comment or
 * submits a review. The operations sidebar stays at the panel level beside
 * the tabs.
 *
 * Reuses the shared timeline primitives so it renders identically to the Issue
 * detail view.
 */
import type { TFunction } from "i18next";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubIssueComment,
  GitHubPrReview,
  GitHubReviewComment,
  PrReviewEvent,
} from "@src/api/tauri/github";
import Button from "@src/components/Button";
import ComposerSurface from "@src/components/ComposerSurface";
import { projectMarkdownSessionReferences } from "@src/components/MarkDown/sessionReferenceProjection";
import PersonAvatar from "@src/components/PersonAvatar";
import Radio from "@src/components/Radio";
import type { RadioValue } from "@src/components/Radio";
import Textarea from "@src/components/Textarea";
import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useSessionReferenceDropTarget } from "@src/features/Org2Cloud/useSessionReferenceDropTarget";
import { useElementDimensions } from "@src/hooks/ui/layout/useElementDimensions";
import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  FileDiffIcon,
  HugeiconsIcon,
} from "@src/icons";
import {
  ConnectedTimelineItem,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineLoadingSkeleton,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";
import MarkdownTextareaEditor, {
  type MarkdownEditorMode,
  type MarkdownTextareaEditorRef,
} from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import Modal from "@src/scaffold/ModalSystem";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

interface PrAuthor {
  login: string;
  avatarUrl: string;
}

function readAuthor(detail: Record<string, unknown> | null): PrAuthor {
  const user = (detail?.user as Record<string, unknown> | undefined) ?? {};
  return {
    login: typeof user.login === "string" ? user.login : "",
    avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : "",
  };
}

function readString(
  detail: Record<string, unknown> | null,
  key: string
): string {
  const value = detail?.[key];
  return typeof value === "string" ? value : "";
}

// ── Review presentation ──────────────────────────────────────────────────────

function reviewVerb(
  state: string,
  t: TFunction
): { label: string; icon: React.ReactNode } {
  switch (state) {
    case "APPROVED":
      return {
        label: t("git.pr.activity.approved", "approved these changes"),
        icon: (
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            data-icon="check-circle-2"
            size={14}
            strokeWidth={1.9}
            className="text-success-6"
          />
        ),
      };
    case "CHANGES_REQUESTED":
      return {
        label: t("git.pr.activity.changesRequested", "requested changes"),
        icon: (
          <HugeiconsIcon
            icon={CancelCircleIcon}
            data-icon="xcircle"
            size={14}
            strokeWidth={1.9}
            className="text-danger-6"
          />
        ),
      };
    case "DISMISSED":
      return {
        label: t("git.pr.activity.reviewDismissed", "dismissed a review"),
        icon: (
          <HugeiconsIcon
            icon={FileDiffIcon}
            data-icon="file-diff"
            size={14}
            strokeWidth={1.9}
            className="text-text-3"
          />
        ),
      };
    default:
      return {
        label: t("git.pr.activity.reviewed", "reviewed"),
        icon: (
          <HugeiconsIcon
            icon={FileDiffIcon}
            data-icon="file-diff"
            size={14}
            strokeWidth={1.9}
            className="text-text-3"
          />
        ),
      };
  }
}

function ReviewCommentSummary({
  comments,
}: {
  comments: GitHubReviewComment[];
}): React.ReactNode {
  if (comments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="rounded-lg border border-border-1 bg-fill-1 px-2.5 py-1.5"
        >
          <div className="truncate text-[11px] font-medium text-text-2">
            {comment.path}
            {comment.line != null ? `:${comment.line}` : ""}
          </div>
          <div className="mt-0.5 line-clamp-3 text-[12px] text-text-2">
            {comment.body}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Merged timeline ──────────────────────────────────────────────────────────

type TimelineEntry =
  | { kind: "comment"; at: string; comment: GitHubIssueComment }
  | { kind: "review"; at: string; review: GitHubPrReview };

interface PrConversationTabProps {
  /** GitHub-style flow-title block rendered above the timeline. */
  flowHeader?: React.ReactNode;
  detail: Record<string, unknown> | null;
  identity: PrIdentity;
  conversation: GitHubIssueComment[];
  reviews: GitHubPrReview[];
  reviewComments: GitHubReviewComment[];
  loading: boolean;
  submittingComment: boolean;
  submittingReview: boolean;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onAddComment: (body: string) => Promise<void>;
  onSubmitReview: (event: PrReviewEvent, body: string) => Promise<void>;
  trailScrollContainerRef?: (node: HTMLDivElement | null) => void;
  trailContentRef?: (node: HTMLDivElement | null) => void;
}

export const PrConversationTab: React.FC<PrConversationTabProps> = ({
  flowHeader,
  detail,
  identity,
  conversation,
  reviews,
  reviewComments,
  loading,
  submittingComment,
  submittingReview,
  draft: controlledDraft,
  onDraftChange,
  onAddComment,
  onSubmitReview,
  trailScrollContainerRef,
  trailContentRef,
}) => {
  const { t } = useTranslation("common");
  const [internalDraft, setInternalDraft] = useState("");
  const [reviewModalVisible, setReviewModalVisible] = useState(false);
  const [reviewDecision, setReviewDecision] =
    useState<PrReviewEvent>("COMMENT");
  const [reviewBody, setReviewBody] = useState("");
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>("write");
  const draft = controlledDraft ?? internalDraft;
  const updateDraft = useCallback(
    (nextDraft: string) => {
      if (controlledDraft !== undefined) {
        onDraftChange?.(nextDraft);
        return;
      }
      setInternalDraft(nextDraft);
    },
    [controlledDraft, onDraftChange]
  );
  const editorRef = useRef<MarkdownTextareaEditorRef>(null);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const measuredComposerHeight = useElementDimensions(composerDockRef, {
    dimension: "height",
  });
  const composerBottomInset = Math.max(240, measuredComposerHeight);
  const insertDroppedReference = useCallback(
    (text: string, dropPoint?: { clientX: number; clientY: number }) => {
      editorRef.current?.insertText(text, {
        separateFromAdjacentText: true,
        clientX: dropPoint?.clientX,
        clientY: dropPoint?.clientY,
      });
    },
    []
  );
  const { isDragOver } = useSessionReferenceDropTarget({
    elementRef: dropTargetRef,
    onInsertText: insertDroppedReference,
  });

  const author = readAuthor(detail);
  const body = readString(detail, "body");
  const createdAt = readString(detail, "created_at");

  const commentsByReview = useMemo(() => {
    const map = new Map<number, GitHubReviewComment[]>();
    for (const comment of reviewComments) {
      const key = comment.pull_request_review_id;
      if (key == null) continue;
      const list = map.get(key) ?? [];
      list.push(comment);
      map.set(key, list);
    }
    return map;
  }, [reviewComments]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    for (const comment of conversation) {
      entries.push({ kind: "comment", at: comment.created_at, comment });
    }
    for (const review of reviews) {
      // Skip empty pending / commented reviews that carry neither body nor
      // inline comments — they add noise, not signal.
      const hasInline = (commentsByReview.get(review.id)?.length ?? 0) > 0;
      if (review.state === "COMMENTED" && !review.body.trim() && !hasInline) {
        continue;
      }
      entries.push({
        kind: "review",
        at: review.submitted_at ?? "",
        review,
      });
    }
    entries.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    return entries;
  }, [conversation, reviews, commentsByReview]);

  const handleComment = useCallback(async () => {
    const value = draft.trim();
    if (!value || submittingComment) return;
    await onAddComment(value);
    updateDraft("");
    setEditorMode("write");
  }, [draft, submittingComment, onAddComment, updateDraft]);

  const resetReviewModal = useCallback(() => {
    setReviewDecision("COMMENT");
    setReviewBody("");
  }, []);

  const closeReviewModal = useCallback(() => {
    if (submittingReview) return;
    setReviewModalVisible(false);
    resetReviewModal();
  }, [resetReviewModal, submittingReview]);

  const handleReviewDecisionChange = useCallback((value: RadioValue) => {
    setReviewDecision(value as PrReviewEvent);
  }, []);

  const handleReview = useCallback(async () => {
    const body = reviewBody.trim();
    if (
      submittingReview ||
      (reviewDecision !== "APPROVE" && body.length === 0)
    ) {
      return;
    }
    await onSubmitReview(reviewDecision, body);
    setReviewModalVisible(false);
    resetReviewModal();
  }, [
    onSubmitReview,
    resetReviewModal,
    reviewBody,
    reviewDecision,
    submittingReview,
  ]);

  const reviewBodyRequired = reviewDecision !== "APPROVE";
  const submitReviewDisabled =
    submittingReview || (reviewBodyRequired && !reviewBody.trim());

  const lastIndex = timeline.length; // description card is index -1 conceptually

  return (
    <div className="allow-select-deep relative flex h-full min-h-0 select-text flex-col overflow-hidden">
      <div
        ref={trailScrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-hide"
        data-testid="pr-conversation-scroll"
      >
        <div
          ref={trailContentRef}
          style={{ paddingBottom: composerBottomInset }}
        >
          {flowHeader ? (
            <div className={`${DETAIL_PANEL_TOKENS.headerWidth} px-4 pt-5`}>
              {flowHeader}
            </div>
          ) : null}
          <div
            className={`${DETAIL_PANEL_TOKENS.headerWidth} flex flex-col px-4 py-4`}
          >
            <div className="min-w-0 flex-1">
              <TimelineStack>
                {/* PR description */}
                <ConnectedTimelineItem
                  isLast={timeline.length === 0 && !loading}
                  trailLabel={identity.title}
                >
                  <TimelineCard
                    copyBody={body}
                    header={
                      <TimelineCardHeader
                        avatar={
                          <PersonAvatar
                            size={18}
                            name={author.login || identity.title}
                            src={author.avatarUrl}
                          />
                        }
                        actor={author.login || identity.title}
                        action={t(
                          "git.pr.activity.opened",
                          "opened this pull request"
                        )}
                        timestamp={createdAt}
                      />
                    }
                  >
                    <MarkdownContent
                      body={body}
                      emptyText={t(
                        "git.pr.noDescription",
                        "No description provided."
                      )}
                      fadeFrom="from-chat-pane"
                    />
                  </TimelineCard>
                </ConnectedTimelineItem>

                {loading && timeline.length === 0 ? (
                  <ConnectedTimelineItem isLast>
                    <TimelineLoadingSkeleton
                      label={t("git.pr.loadingConversation", "Loading…")}
                    />
                  </ConnectedTimelineItem>
                ) : (
                  timeline.map((entry, index) => {
                    const isLast = index === lastIndex - 1;
                    if (entry.kind === "comment") {
                      const { comment } = entry;
                      const isSessionAttachment =
                        projectMarkdownSessionReferences(
                          comment.body
                        ).referenceOnly;
                      return (
                        <ConnectedTimelineItem
                          key={`c-${comment.id}`}
                          isLast={isLast}
                          trailLabel={`${comment.user.login}: ${comment.body}`}
                        >
                          <TimelineCard
                            copyBody={comment.body}
                            header={
                              <TimelineCardHeader
                                avatar={
                                  <PersonAvatar
                                    size={18}
                                    name={comment.user.login}
                                    src={comment.user.avatar_url}
                                  />
                                }
                                actor={comment.user.login}
                                action={
                                  isSessionAttachment
                                    ? t(
                                        "git.pr.activity.appendedSession",
                                        "appended a session"
                                      )
                                    : t(
                                        "git.pr.activity.commented",
                                        "commented"
                                      )
                                }
                                timestamp={comment.created_at}
                              />
                            }
                          >
                            <MarkdownContent
                              body={comment.body}
                              fadeFrom="from-chat-pane"
                            />
                          </TimelineCard>
                        </ConnectedTimelineItem>
                      );
                    }
                    const { review } = entry;
                    const verb = reviewVerb(review.state, t);
                    const inline = commentsByReview.get(review.id) ?? [];
                    return (
                      <ConnectedTimelineItem
                        key={`r-${review.id}`}
                        isLast={isLast}
                        trailLabel={`${review.user.login}: ${verb.label}`}
                      >
                        <TimelineCard
                          copyBody={review.body}
                          header={
                            <TimelineCardHeader
                              avatar={
                                <PersonAvatar
                                  size={18}
                                  name={review.user.login}
                                  src={review.user.avatar_url}
                                />
                              }
                              indicator={
                                <span className="shrink-0">{verb.icon}</span>
                              }
                              actor={review.user.login}
                              action={verb.label}
                              timestamp={review.submitted_at}
                            />
                          }
                        >
                          {review.body.trim() ? (
                            <MarkdownContent
                              body={review.body}
                              fadeFrom="from-chat-pane"
                            />
                          ) : (
                            <div className="text-[12px] italic text-text-3">
                              {t(
                                "git.pr.reviewNoBody",
                                "Left review comments."
                              )}
                            </div>
                          )}
                          <ReviewCommentSummary comments={inline} />
                        </TimelineCard>
                      </ConnectedTimelineItem>
                    );
                  })
                )}
              </TimelineStack>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={composerDockRef}
        className={`absolute bottom-0 left-0 right-0 z-50 flex w-full flex-shrink-0 flex-col items-center pt-1 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
        data-testid="pr-floating-composer"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent"
        />
        <div
          className={`${DETAIL_PANEL_TOKENS.headerWidth} relative z-10 w-full px-4`}
        >
          <section
            data-testid="pr-comment-composer"
            aria-label={t("git.pr.commentPlaceholder", "Leave a comment…")}
            className="flex flex-col gap-1.5"
          >
            <ComposerSurface
              ref={dropTargetRef}
              variant="default"
              className={`overflow-visible !pt-1.5 ${
                isDragOver ? "!ring-2 !ring-primary-6" : ""
              }`.trim()}
              data-testid="pr-comment-drop-target"
              leadingActions={
                <MarkdownEditorModeSwitch
                  mode={editorMode}
                  onModeChange={setEditorMode}
                  disabled={submittingComment || submittingReview}
                  dataTestId="pr-comment-mode-switch"
                />
              }
              trailingActions={
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    htmlType="button"
                    variant="secondary"
                    size="small"
                    shape="round"
                    disabled={submittingReview}
                    onClick={() => setReviewModalVisible(true)}
                    data-testid="pr-submit-review"
                  >
                    {t("git.pr.submitReview", "Submit review")}
                  </Button>
                  <Button
                    htmlType="button"
                    variant="primary"
                    size="small"
                    shape="round"
                    loading={submittingComment}
                    disabled={!draft.trim() || submittingComment}
                    onClick={() => void handleComment()}
                  >
                    {t("git.pr.comment", "Comment")}
                  </Button>
                </div>
              }
            >
              <MarkdownTextareaEditor
                ref={editorRef}
                value={draft}
                onChange={updateDraft}
                placeholder={t("git.pr.commentPlaceholder", "Leave a comment…")}
                minHeight={100}
                maxHeight={500}
                appearance="plain"
                editable={!submittingComment && !submittingReview}
                onSubmit={() => void handleComment()}
                mode={editorMode}
                onModeChange={setEditorMode}
                dataTestId="pr-comment-editor"
              />
            </ComposerSurface>
          </section>
        </div>
      </div>

      <Modal
        visible={reviewModalVisible}
        title={t("git.pr.submitReview", "Submit review")}
        width={640}
        bodyClassName="px-5 py-4"
        footerTopBorder={false}
        primaryButtonSize="default"
        secondaryButtonSize="default"
        okText={t("git.pr.submitReview", "Submit review")}
        cancelText={t("actions.cancel", "Cancel")}
        onCancel={closeReviewModal}
        onOk={handleReview}
        closable={!submittingReview}
        maskClosable={!submittingReview}
        escToExit={!submittingReview}
        okButtonProps={{
          loading: submittingReview,
          disabled: submitReviewDisabled,
        }}
        cancelButtonProps={{ disabled: submittingReview }}
      >
        <div className="flex flex-col gap-5">
          <p className="text-[13px] leading-5 text-text-3">
            {t(
              "git.pr.reviewHeadNotice",
              "The review applies only if the displayed head commit still matches."
            )}
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-medium text-text-1">
              {t("git.pr.reviewDecision", "Review decision")}
            </legend>
            <Radio.Group
              value={reviewDecision}
              onChange={handleReviewDecisionChange}
              disabled={submittingReview}
              direction="horizontal"
              className="flex-wrap gap-x-5 gap-y-2"
            >
              <Radio value="COMMENT">{t("git.pr.comment", "Comment")}</Radio>
              <Radio value="APPROVE">{t("git.pr.approve", "Approve")}</Radio>
              <Radio value="REQUEST_CHANGES">
                {t("git.pr.requestChanges", "Request changes")}
              </Radio>
            </Radio.Group>
          </fieldset>

          <label
            htmlFor="pr-review-comment"
            className="flex flex-col gap-2 text-[13px] font-medium text-text-1"
          >
            {t("git.pr.reviewComment", "Review comment")}
            <Textarea
              id="pr-review-comment"
              data-testid="pr-review-comment"
              value={reviewBody}
              onChange={setReviewBody}
              placeholder={t(
                "git.pr.reviewCommentPlaceholder",
                "Add a comment…"
              )}
              rows={7}
              resize="vertical"
              disabled={submittingReview}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
};

PrConversationTab.displayName = "PrConversationTab";
