/**
 * PrReviewThreadsPanel
 *
 * A collapsible drawer of the PR's inline review-comment threads, grouped by
 * file → anchor line. Each thread shows the diff-hunk context, the comment
 * chain, and a reply composer. Lives at the bottom of the Changes tab so the
 * reused diff view stays untouched.
 *
 * (Composing a brand-new comment against a specific diff line via a gutter
 * affordance requires changes to the shared CodeMirror diff component and is a
 * separate follow-up; the create path is already wired in the data layer.)
 */
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubReviewComment } from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import Textarea from "@src/components/Textarea";
import { formatTimeAgo } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";

import { GithubMarkdown } from "../../shared/githubTimeline";

interface ThreadGroup {
  rootId: number;
  path: string;
  line: number | null;
  diffHunk: string;
  comments: GitHubReviewComment[];
}

function groupIntoThreads(comments: GitHubReviewComment[]): ThreadGroup[] {
  const byRoot = new Map<number, GitHubReviewComment[]>();
  for (const comment of comments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    const list = byRoot.get(rootId) ?? [];
    list.push(comment);
    byRoot.set(rootId, list);
  }
  const threads: ThreadGroup[] = [];
  for (const [rootId, list] of byRoot) {
    const sorted = [...list].sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
    const root = sorted[0];
    threads.push({
      rootId,
      path: root.path,
      line: root.line ?? root.original_line,
      diffHunk: root.diff_hunk,
      comments: sorted,
    });
  }
  return threads;
}

function DiffHunkContext({ hunk }: { hunk: string }): React.ReactNode {
  if (!hunk.trim()) return null;
  // Show only the tail of the hunk (the lines the comment anchors to).
  const lines = hunk.split("\n").slice(-4);
  return (
    <pre className="mb-2 overflow-x-auto rounded-md bg-fill-1 px-2 py-1.5 text-[11px] leading-relaxed text-text-3">
      {lines.map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+")
              ? "text-success-7"
              : line.startsWith("-")
                ? "text-danger-7"
                : undefined
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function ReviewThread({
  thread,
  onReply,
}: {
  thread: ThreadGroup;
  onReply?: (commentId: number, body: string) => Promise<void>;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const [reply, setReply] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleReply = useCallback(async () => {
    const body = reply.trim();
    if (!body || submitting || !onReply) return;
    setSubmitting(true);
    try {
      await onReply(thread.rootId, body);
      setReply("");
    } finally {
      setSubmitting(false);
    }
  }, [reply, submitting, onReply, thread.rootId]);

  return (
    <div className="rounded-xl border border-border-1">
      <div className="border-b border-border-1 px-3 py-2">
        <div className="mb-1 truncate text-[11px] font-medium text-text-2">
          {thread.path}
          {thread.line != null ? `:${thread.line}` : ""}
        </div>
        <DiffHunkContext hunk={thread.diffHunk} />
      </div>
      <div className="flex flex-col gap-3 px-3 py-3">
        {thread.comments.map((comment) => (
          <div key={comment.id} className="flex min-w-0 gap-2">
            <Avatar size={18} src={comment.user.avatar_url} />
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 truncate text-[11px] text-text-3">
                <span className="font-medium text-text-1">
                  {comment.user.login}
                </span>{" "}
                {formatTimeAgo(comment.created_at)}
              </div>
              <GithubMarkdown body={comment.body} />
            </div>
          </div>
        ))}
      </div>
      {onReply ? (
        <div className="border-t border-border-1 px-3 py-2">
          <Textarea
            value={reply}
            onChange={setReply}
            placeholder={t("git.pr.replyPlaceholder", "Reply…")}
            rows={2}
            size="mini"
            resize="none"
          />
          <div className="mt-1.5 flex justify-end">
            <Button
              htmlType="button"
              variant="secondary"
              size="mini"
              loading={submitting}
              disabled={!reply.trim() || submitting}
              onClick={() => void handleReply()}
            >
              {t("git.pr.reply", "Reply")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface PrReviewThreadsPanelProps {
  reviewComments: GitHubReviewComment[];
  onReply?: (commentId: number, body: string) => Promise<void>;
}

export const PrReviewThreadsPanel: React.FC<PrReviewThreadsPanelProps> = ({
  reviewComments,
  onReply,
}) => {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);

  const threads = useMemo(
    () => groupIntoThreads(reviewComments),
    [reviewComments]
  );

  if (threads.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border-1">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-4 py-2 text-[12px] text-text-2 hover:bg-fill-1"
      >
        {expanded ? (
          <ChevronDown size={14} strokeWidth={2} />
        ) : (
          <ChevronRight size={14} strokeWidth={2} />
        )}
        <MessageSquare size={13} strokeWidth={1.9} className="text-text-3" />
        <span className="font-medium">
          {t("git.pr.reviewThreads", "Review comments")}
        </span>
        <span className="rounded-full bg-fill-2 px-1.5 text-[10px] tabular-nums text-text-3">
          {threads.length}
        </span>
      </button>
      {expanded ? (
        <div className="max-h-[40vh] overflow-y-auto px-4 pb-3 scrollbar-hide">
          <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3">
            {threads.map((thread) => (
              <ReviewThread
                key={thread.rootId}
                thread={thread}
                onReply={onReply}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

PrReviewThreadsPanel.displayName = "PrReviewThreadsPanel";
