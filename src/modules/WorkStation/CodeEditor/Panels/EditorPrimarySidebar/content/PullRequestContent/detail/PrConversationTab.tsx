/**
 * PrConversationTab
 *
 * GitHub-style PR conversation: the PR description followed by an interleaved
 * timeline of conversation comments and submitted reviews (Approved / Requested
 * changes / Commented), with each review's inline comments summarized beneath
 * it. A bottom composer posts a conversation comment or submits a review.
 *
 * Reuses the shared timeline primitives so it renders identically to the Issue
 * detail view.
 */
import { CheckCircle2, FileDiff, Loader, XCircle } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubIssueComment,
  GitHubPrReview,
  GitHubReviewComment,
  PrReviewEvent,
} from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import Textarea from "@src/components/Textarea";
import {
  ConnectedTimelineItem,
  GithubMarkdown,
  TimelineCard,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/shared/githubTimeline";
import { formatTimeAgo } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
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

function reviewVerb(state: string): { label: string; icon: React.ReactNode } {
  switch (state) {
    case "APPROVED":
      return {
        label: "approved these changes",
        icon: (
          <CheckCircle2
            size={14}
            strokeWidth={1.9}
            className="text-success-6"
          />
        ),
      };
    case "CHANGES_REQUESTED":
      return {
        label: "requested changes",
        icon: <XCircle size={14} strokeWidth={1.9} className="text-danger-6" />,
      };
    case "DISMISSED":
      return {
        label: "dismissed a review",
        icon: <FileDiff size={14} strokeWidth={1.9} className="text-text-3" />,
      };
    default:
      return {
        label: "reviewed",
        icon: <FileDiff size={14} strokeWidth={1.9} className="text-text-3" />,
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
  detail: Record<string, unknown> | null;
  identity: PrIdentity;
  conversation: GitHubIssueComment[];
  reviews: GitHubPrReview[];
  reviewComments: GitHubReviewComment[];
  loading: boolean;
  submittingComment: boolean;
  submittingReview: boolean;
  onAddComment: (body: string) => Promise<void>;
  onSubmitReview: (event: PrReviewEvent, body: string) => Promise<void>;
}

export const PrConversationTab: React.FC<PrConversationTabProps> = ({
  detail,
  identity,
  conversation,
  reviews,
  reviewComments,
  loading,
  submittingComment,
  submittingReview,
  onAddComment,
  onSubmitReview,
}) => {
  const { t } = useTranslation("common");
  const [draft, setDraft] = useState("");

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
    setDraft("");
  }, [draft, submittingComment, onAddComment]);

  const handleReview = useCallback(
    async (event: PrReviewEvent) => {
      if (submittingReview) return;
      await onSubmitReview(event, draft.trim());
      setDraft("");
    },
    [draft, submittingReview, onSubmitReview]
  );

  const lastIndex = timeline.length; // description card is index -1 conceptually

  return (
    <div className="flex h-full min-h-0 select-text flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
        <div className="mx-auto flex w-full max-w-[920px] flex-col px-4 py-4">
          <div className="flex flex-col">
            {/* PR description */}
            <ConnectedTimelineItem isLast={timeline.length === 0 && !loading}>
              <TimelineCard
                copyBody={body}
                header={
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar size={18} src={author.avatarUrl} />
                    <span className="min-w-0 truncate text-[12px] text-text-3">
                      <span className="font-medium text-text-1">
                        {author.login || identity.title}
                      </span>{" "}
                      opened this pull request{" "}
                      {createdAt ? formatTimeAgo(createdAt) : ""}
                    </span>
                  </span>
                }
              >
                <GithubMarkdown
                  body={body}
                  emptyText={t(
                    "git.pr.noDescription",
                    "No description provided."
                  )}
                />
              </TimelineCard>
            </ConnectedTimelineItem>

            {loading && timeline.length === 0 ? (
              <ConnectedTimelineItem isLast>
                <div className="rounded-xl border border-dashed border-border-1 px-4 py-3 text-[12px] text-text-3">
                  <span className="flex items-center gap-2">
                    <Loader size={14} className="animate-spin" />
                    <span>{t("git.pr.loadingConversation", "Loading…")}</span>
                  </span>
                </div>
              </ConnectedTimelineItem>
            ) : (
              timeline.map((entry, index) => {
                const isLast = index === lastIndex - 1;
                if (entry.kind === "comment") {
                  const { comment } = entry;
                  return (
                    <ConnectedTimelineItem
                      key={`c-${comment.id}`}
                      isLast={isLast}
                    >
                      <TimelineCard
                        copyBody={comment.body}
                        header={
                          <span className="flex min-w-0 items-center gap-2">
                            <Avatar size={18} src={comment.user.avatar_url} />
                            <span className="min-w-0 truncate text-[12px] text-text-3">
                              <span className="font-medium text-text-1">
                                {comment.user.login}
                              </span>{" "}
                              commented {formatTimeAgo(comment.created_at)}
                            </span>
                          </span>
                        }
                      >
                        <GithubMarkdown body={comment.body} />
                      </TimelineCard>
                    </ConnectedTimelineItem>
                  );
                }
                const { review } = entry;
                const verb = reviewVerb(review.state);
                const inline = commentsByReview.get(review.id) ?? [];
                return (
                  <ConnectedTimelineItem key={`r-${review.id}`} isLast={isLast}>
                    <TimelineCard
                      copyBody={review.body}
                      header={
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar size={18} src={review.user.avatar_url} />
                          <span className="shrink-0">{verb.icon}</span>
                          <span className="min-w-0 truncate text-[12px] text-text-3">
                            <span className="font-medium text-text-1">
                              {review.user.login}
                            </span>{" "}
                            {verb.label}{" "}
                            {review.submitted_at
                              ? formatTimeAgo(review.submitted_at)
                              : ""}
                          </span>
                        </span>
                      }
                    >
                      {review.body.trim() ? (
                        <GithubMarkdown body={review.body} />
                      ) : (
                        <div className="text-[12px] italic text-text-3">
                          {t("git.pr.reviewNoBody", "Left review comments.")}
                        </div>
                      )}
                      <ReviewCommentSummary comments={inline} />
                    </TimelineCard>
                  </ConnectedTimelineItem>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Composer */}
      <div className="bg-surface-1 flex-shrink-0 border-t border-border-1 px-4 py-3">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-2">
          <Textarea
            value={draft}
            onChange={setDraft}
            placeholder={t("git.pr.commentPlaceholder", "Leave a comment…")}
            rows={3}
            size="mini"
            resize="none"
            className="min-h-[64px]"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                htmlType="button"
                variant="secondary"
                size="mini"
                loading={submittingReview}
                disabled={submittingReview}
                onClick={() => void handleReview("APPROVE")}
              >
                {t("git.pr.approve", "Approve")}
              </Button>
              <Button
                htmlType="button"
                variant="secondary"
                size="mini"
                loading={submittingReview}
                disabled={submittingReview || !draft.trim()}
                onClick={() => void handleReview("REQUEST_CHANGES")}
              >
                {t("git.pr.requestChanges", "Request changes")}
              </Button>
            </div>
            <Button
              htmlType="button"
              variant="primary"
              size="mini"
              loading={submittingComment}
              disabled={!draft.trim() || submittingComment}
              onClick={() => void handleComment()}
            >
              {t("git.pr.comment", "Comment")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

PrConversationTab.displayName = "PrConversationTab";
