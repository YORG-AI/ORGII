import {
  Check,
  CheckCircle2,
  CircleDot,
  Clipboard,
  ExternalLink,
  Loader,
} from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssue, GitHubIssueComment } from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import Markdown from "@src/components/MarkDown";
import Tag from "@src/components/Tag";
import Textarea from "@src/components/Textarea";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
  TYPOGRAPHY,
} from "@src/config/workstation/tokens";
import { useCopyCheck } from "@src/hooks/ui";
import {
  formatTimeAgo,
  getLabelColorStyle,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
import { copyText } from "@src/util/data/clipboard";

interface IssueDetailPanelProps {
  issue: GitHubIssue;
  comments: GitHubIssueComment[];
  commentsLoading: boolean;
  submittingComment: boolean;
  showHeader?: boolean;
  onClose: () => void;
  onCloseIssue: () => void;
  onReopenIssue: () => void;
  onAddComment: (body: string) => Promise<void>;
}

const GITHUB_IMAGE_TAG_RE = /<img\b([^>]*)\/?>/gi;
const IMAGE_ATTR_RE = /([\w:-]+)\s*=\s*(["'])(.*?)\2/g;

function sanitizeMarkdownImageAlt(value: string): string {
  return value.split("[").join("").split("]").join("");
}

function normalizeGitHubMarkdownBody(body: string): string {
  return body.replace(GITHUB_IMAGE_TAG_RE, (match, rawAttrs: string) => {
    const attrs = new Map<string, string>();
    for (const attrMatch of rawAttrs.matchAll(IMAGE_ATTR_RE)) {
      attrs.set(attrMatch[1].toLowerCase(), attrMatch[3]);
    }

    const src = attrs.get("src");
    if (!src) return match;

    const alt = attrs.get("alt") ?? "image";
    const safeAlt = sanitizeMarkdownImageAlt(alt);
    return `![${safeAlt}](${src})`;
  });
}

function IssueStateIcon({ isOpen }: { isOpen: boolean }): React.ReactNode {
  if (isOpen) return <CircleDot size={14} strokeWidth={1.8} />;
  return <CheckCircle2 size={14} strokeWidth={1.8} />;
}

function IssueLabelTag({
  label,
}: {
  label: GitHubIssue["labels"][number];
}): React.ReactNode {
  return (
    <Tag
      key={label.id}
      size="mini"
      pill
      className={`${TYPOGRAPHY.badge} !px-2 !py-[2px] !leading-tight`}
      style={getLabelColorStyle(label.color)}
    >
      {label.name}
    </Tag>
  );
}

function ConnectedTimelineItem({
  children,
  isLast,
}: {
  children: React.ReactNode;
  isLast?: boolean;
}): React.ReactNode {
  return (
    <span className="flex min-w-0 flex-col">
      {children}
      {!isLast ? (
        <span
          className="-mt-px ml-5 h-3 border-l border-border-1"
          aria-hidden
        />
      ) : null}
    </span>
  );
}

function TimelineCopyButton({ body }: { body: string }): React.ReactNode {
  const { t } = useTranslation("common");
  const onCopyContent = useCallback(async () => {
    await copyText(body);
  }, [body]);
  const { copied, handleCopy } = useCopyCheck(onCopyContent);

  if (!body.trim()) return null;

  return (
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      iconOnly
      icon={
        copied ? (
          <Check size={12} strokeWidth={1.75} />
        ) : (
          <Clipboard size={12} strokeWidth={1.75} />
        )
      }
      title={copied ? t("status.copied") : t("actions.copy")}
      aria-label={copied ? t("status.copied") : t("actions.copy")}
      className="shrink-0 text-text-3 hover:bg-fill-2 hover:text-text-1"
      onClick={(event) => {
        event.stopPropagation();
        handleCopy();
      }}
    />
  );
}

function TimelineCard({
  header,
  copyBody,
  children,
}: {
  header: React.ReactNode;
  copyBody?: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <span className="bg-surface-1 flex min-w-0 flex-1 flex-col rounded-xl border border-border-1 shadow-sm">
      <span className="flex min-w-0 items-center justify-between gap-3 border-b border-border-1 px-3 py-2">
        {header}
        {copyBody ? <TimelineCopyButton body={copyBody} /> : null}
      </span>
      <span className="min-w-0 select-text px-3 py-3">{children}</span>
    </span>
  );
}

const IssueMarkdown = memo(function IssueMarkdown({
  body,
  emptyText,
}: {
  body: string;
  emptyText?: string;
}) {
  if (!body.trim()) {
    return (
      <div className="text-[12px] italic leading-5 text-text-3">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="chat-block-content max-w-[860px] select-text text-[12px] leading-5 text-text-2 [&_.chat-markdown-body]:select-text [&_.chat-markdown-body]:text-[12px] [&_.chat-markdown-body]:leading-5">
      <Markdown
        textContent={normalizeGitHubMarkdownBody(body)}
        skipPreprocess
      />
    </div>
  );
});

export const IssueDetailPanel: React.FC<IssueDetailPanelProps> = memo(
  ({
    issue,
    comments,
    commentsLoading,
    submittingComment,
    showHeader = true,
    onClose: _onClose,
    onCloseIssue,
    onReopenIssue,
    onAddComment,
  }) => {
    const { t } = useTranslation("common");
    const [commentBody, setCommentBody] = useState("");
    const isOpen = issue.state === "open";
    const stateClassName = isOpen ? "text-success-6" : "text-purple-6";
    const stateLabel = isOpen ? "Open" : "Closed";
    const timelineItemCount = 1 + comments.length;

    const handleCommentSubmit = useCallback(async () => {
      const body = commentBody.trim();
      if (!body || submittingComment) return;
      await onAddComment(body);
      setCommentBody("");
    }, [commentBody, submittingComment, onAddComment]);

    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {showHeader && (
          <div className={HEADER_CLASSES.pageHeader}>
            <span className={`shrink-0 ${stateClassName}`}>
              <IssueStateIcon isOpen={isOpen} />
            </span>

            <span className="shrink-0 text-[11px] text-text-3">
              #{issue.number}
            </span>

            <span
              className={`min-w-0 flex-1 truncate ${TYPOGRAPHY.sectionTitle} text-text-1`}
              title={issue.title}
            >
              {issue.title}
            </span>

            <Button
              href={issue.html_url}
              target="_blank"
              rel="noopener noreferrer"
              variant="tertiary"
              size="small"
              iconOnly
              icon={<ExternalLink size={HEADER_ICON_SIZE.sm} strokeWidth={2} />}
              title="Open on GitHub"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          <div className="mx-auto flex w-full max-w-[920px] flex-col px-4 py-4">
            <div className="mb-4 flex min-w-0 flex-col gap-2 border-b border-border-1 pb-4">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-text-3">
                <span
                  className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${
                    isOpen
                      ? "text-success-7 bg-success-2"
                      : "bg-purple-2 text-purple-7"
                  }`}
                >
                  {stateLabel}
                </span>
                <span>
                  <span className="font-medium text-text-2">
                    {issue.user.login}
                  </span>{" "}
                  opened this issue {formatTimeAgo(issue.created_at)}
                </span>
                <span>·</span>
                <span>{timelineItemCount} timeline item(s)</span>
              </div>

              {issue.labels.length > 0 || issue.assignees.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {issue.labels.map((label) => (
                    <IssueLabelTag key={label.id} label={label} />
                  ))}
                  {issue.assignees.map((user) => (
                    <span
                      key={user.login}
                      className="inline-flex h-5 items-center gap-1 rounded-full bg-fill-2 px-2 text-[11px] font-medium text-text-2"
                    >
                      <Avatar size={12} src={user.avatar_url} />
                      {user.login}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col">
              <ConnectedTimelineItem
                isLast={comments.length === 0 && !commentsLoading}
              >
                <TimelineCard
                  copyBody={issue.body ?? ""}
                  header={
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar size={18} src={issue.user.avatar_url} />
                      <span className="min-w-0 truncate text-[12px] text-text-3">
                        <span className="font-medium text-text-1">
                          {issue.user.login}
                        </span>{" "}
                        opened this issue {formatTimeAgo(issue.created_at)}
                      </span>
                    </span>
                  }
                >
                  <IssueMarkdown
                    body={issue.body ?? ""}
                    emptyText="No description provided."
                  />
                </TimelineCard>
              </ConnectedTimelineItem>

              {commentsLoading ? (
                <ConnectedTimelineItem isLast>
                  <div className="rounded-xl border border-dashed border-border-1 px-4 py-3 text-[12px] text-text-3">
                    <span className="flex items-center gap-2">
                      <Loader size={14} className="animate-spin" />
                      <span>Loading comments…</span>
                    </span>
                  </div>
                </ConnectedTimelineItem>
              ) : (
                comments.map((comment, index) => (
                  <ConnectedTimelineItem
                    key={comment.id}
                    isLast={index === comments.length - 1}
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
                      <IssueMarkdown body={comment.body} />
                    </TimelineCard>
                  </ConnectedTimelineItem>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="bg-surface-1 flex-shrink-0 border-t border-border-1 px-4 py-3">
          <div className="mx-auto flex w-full max-w-[920px] flex-col gap-2">
            <Textarea
              value={commentBody}
              onChange={setCommentBody}
              placeholder={t(
                "git.issues.commentPlaceholder",
                "Leave a comment…"
              )}
              rows={3}
              size="mini"
              resize="none"
              className="min-h-[64px]"
            />
            <div className="flex items-center justify-between gap-2">
              {isOpen ? (
                <Button
                  htmlType="button"
                  variant="secondary"
                  size="mini"
                  onClick={onCloseIssue}
                >
                  Close issue
                </Button>
              ) : (
                <Button
                  htmlType="button"
                  variant="secondary"
                  size="mini"
                  onClick={onReopenIssue}
                >
                  Reopen issue
                </Button>
              )}
              <Button
                htmlType="button"
                variant="primary"
                size="mini"
                loading={submittingComment}
                disabled={!commentBody.trim() || submittingComment}
                onClick={() => void handleCommentSubmit()}
              >
                {t("git.issues.submitComment", "Comment")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

IssueDetailPanel.displayName = "IssueDetailPanel";
