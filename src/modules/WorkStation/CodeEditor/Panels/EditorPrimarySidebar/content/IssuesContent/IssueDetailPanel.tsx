import { CheckCircle2, ChevronLeft, CircleDot, Globe } from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import IntegrationIcon from "@src/components/IntegrationIcon";
import Tag from "@src/components/Tag";
import Textarea from "@src/components/Textarea";
import { ISSUE_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
  TYPOGRAPHY,
} from "@src/config/workstation/tokens";
import { getLabelColorStyle } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/workstationIssueHelpers";
import {
  ActivityTimestamp,
  ConnectedTimelineItem,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { IssueTimelineEventRow } from "./IssueTimelineEvent";

interface IssueDetailPanelProps {
  issue: GitHubIssue;
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  submittingComment: boolean;
  showHeader?: boolean;
  showBackTitleHeader?: boolean;
  backLabel?: string;
  contentPadding?: "default" | "none";
  onClose: () => void;
  onCloseIssue: () => void;
  onReopenIssue: () => void;
  onAddComment: (body: string) => Promise<void>;
}

export function IssueStateIcon({
  isOpen,
}: {
  isOpen: boolean;
}): React.ReactNode {
  if (isOpen) return <CircleDot size={14} strokeWidth={1.8} />;
  return <CheckCircle2 size={14} strokeWidth={1.8} />;
}

export function getIssueStateClassName(issue: GitHubIssue): string {
  return issue.state === "open" ? "text-success-6" : "text-purple-6";
}

export function getIssueDetailTitle(issue: GitHubIssue): string {
  return `#${issue.number} ${issue.title}`;
}

export function IssueDetailHeaderContent({
  issue,
  fallbackTitle,
}: {
  issue: GitHubIssue | null;
  fallbackTitle?: string;
}): React.ReactNode {
  if (!issue) {
    return fallbackTitle ? (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <IntegrationIcon
          type="github"
          size={HEADER_ICON_SIZE.sm}
          className="shrink-0"
        />
        <span className="min-w-0 select-text truncate text-[13px] font-medium text-text-1">
          {fallbackTitle}
        </span>
      </span>
    ) : null;
  }

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <IntegrationIcon
        type="github"
        size={HEADER_ICON_SIZE.sm}
        className="shrink-0"
      />
      <span className={`shrink-0 ${getIssueStateClassName(issue)}`}>
        <IssueStateIcon isOpen={issue.state === "open"} />
      </span>
      <span className="shrink-0 select-text text-[11px] text-text-3">
        #{issue.number}
      </span>
      <span
        className="min-w-0 flex-1 select-text truncate text-[13px] font-medium text-text-1"
        title={issue.title}
      >
        {issue.title}
      </span>
    </span>
  );
}

export function IssueDetailExternalLinkButton({
  issue,
  title = "Open on GitHub",
}: {
  issue: GitHubIssue;
  title?: string;
}): React.ReactNode {
  return (
    <Button
      href={issue.html_url}
      target="_blank"
      rel="noopener noreferrer"
      variant="tertiary"
      size="small"
      iconOnly
      icon={<Globe size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />}
      title={title}
      aria-label={title}
    />
  );
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

export function IssueTimelineItems({
  timeline,
  timelineLoading,
}: {
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
}): React.ReactNode {
  const { t } = useTranslation("common");

  if (timelineLoading) {
    return (
      <ConnectedTimelineItem isLast>
        <Placeholder
          variant="loading"
          placement="sidebar"
          title={t("git.issues.loadingTimeline", "Loading activity…")}
        />
      </ConnectedTimelineItem>
    );
  }

  return timeline.map((item, index) => {
    const isLast = index === timeline.length - 1;
    const key = `${item.event}-${item.id ?? item.created_at ?? index}-${index}`;

    if (item.event !== "commented") {
      return (
        <ConnectedTimelineItem key={key} isLast={isLast}>
          <IssueTimelineEventRow item={item} />
        </ConnectedTimelineItem>
      );
    }

    const body = item.body ?? "";
    const actorName = item.actor?.login ?? "GitHub";
    return (
      <ConnectedTimelineItem key={key} isLast={isLast}>
        <TimelineCard
          copyBody={body}
          header={
            <TimelineCardHeader
              avatar={
                item.actor ? (
                  <Avatar size={18} src={item.actor.avatar_url} />
                ) : null
              }
              actor={actorName}
              action={t("git.issues.activity.commented", "commented")}
              timestamp={item.created_at}
            />
          }
        >
          <MarkdownContent body={body} />
        </TimelineCard>
      </ConnectedTimelineItem>
    );
  });
}

export const IssueDetailPanel: React.FC<IssueDetailPanelProps> = memo(
  ({
    issue,
    timeline,
    timelineLoading,
    submittingComment,
    showHeader = true,
    showBackTitleHeader = false,
    backLabel,
    contentPadding = "default",
    onClose,
    onCloseIssue,
    onReopenIssue,
    onAddComment,
  }) => {
    const { t } = useTranslation("common");
    const [commentBody, setCommentBody] = useState("");
    const isOpen = issue.state === "open";
    const stateLabel = isOpen
      ? t("git.issues.status.open")
      : t("git.issues.status.closed");
    const timelineItemCount = 1 + timeline.length;
    const horizontalPaddingClass =
      contentPadding === "default" ? "px-4" : "px-0";

    const handleCommentSubmit = useCallback(async () => {
      const body = commentBody.trim();
      if (!body || submittingComment) return;
      await onAddComment(body);
      setCommentBody("");
    }, [commentBody, submittingComment, onAddComment]);

    return (
      <div className="allow-select-deep flex h-full min-h-0 select-text flex-col overflow-hidden">
        {showHeader && (
          <div className={HEADER_CLASSES.pageHeader}>
            <IssueDetailHeaderContent issue={issue} />
            <IssueDetailExternalLinkButton issue={issue} />
          </div>
        )}

        {showBackTitleHeader ? (
          <div className={`shrink-0 ${horizontalPaddingClass}`}>
            <div
              className={`${ISSUE_PANEL_WIDTH_TOKENS.headerWidth} flex items-center gap-2 border-b border-border-1 py-2`}
            >
              <Button
                htmlType="button"
                variant="tertiary"
                appearance="ghost"
                size="mini"
                icon={<ChevronLeft size={14} strokeWidth={2} />}
                onClick={onClose}
              >
                {backLabel ?? t("actions.back")}
              </Button>
              <IssueDetailHeaderContent issue={issue} />
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          <div
            className={`${ISSUE_PANEL_WIDTH_TOKENS.headerWidth} flex flex-col ${horizontalPaddingClass} py-4`}
          >
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
                  {t("git.issues.activity.opened", "opened this issue")}{" "}
                  <ActivityTimestamp timestamp={issue.created_at} />
                </span>
                <span>·</span>
                <span>
                  {t("git.issues.activity.timelineItemCount", {
                    count: timelineItemCount,
                    defaultValue: "{{count}} timeline item",
                    defaultValue_other: "{{count}} timeline items",
                  })}
                </span>
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

            <TimelineStack>
              <ConnectedTimelineItem
                isLast={timeline.length === 0 && !timelineLoading}
              >
                <TimelineCard
                  copyBody={issue.body ?? ""}
                  header={
                    <TimelineCardHeader
                      avatar={<Avatar size={18} src={issue.user.avatar_url} />}
                      actor={issue.user.login}
                      action={t(
                        "git.issues.activity.opened",
                        "opened this issue"
                      )}
                      timestamp={issue.created_at}
                    />
                  }
                >
                  <MarkdownContent
                    body={issue.body ?? ""}
                    emptyText={t(
                      "git.issues.activity.noDescription",
                      "No description provided."
                    )}
                  />
                </TimelineCard>
              </ConnectedTimelineItem>

              <IssueTimelineItems
                timeline={timeline}
                timelineLoading={timelineLoading}
              />
            </TimelineStack>
          </div>
        </div>

        <div
          className={`bg-surface-1 flex-shrink-0 border-t border-border-1 ${horizontalPaddingClass} py-3`}
        >
          <div
            className={`${ISSUE_PANEL_WIDTH_TOKENS.headerWidth} flex flex-col gap-2`}
          >
            <Textarea
              value={commentBody}
              onChange={setCommentBody}
              placeholder={t(
                "git.issues.commentPlaceholder",
                "Leave a comment…"
              )}
              rows={3}
              size="default"
              resize="none"
              className="min-h-[64px]"
              data-testid="issue-comment-editor"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleCommentSubmit();
                }
              }}
            />
            <div className="flex min-h-9 items-center justify-between gap-1 px-1">
              {isOpen ? (
                <Button
                  htmlType="button"
                  variant="secondary"
                  appearance="outline"
                  size="small"
                  shape="round"
                  onClick={onCloseIssue}
                >
                  Close issue
                </Button>
              ) : (
                <Button
                  htmlType="button"
                  variant="secondary"
                  appearance="outline"
                  size="small"
                  shape="round"
                  onClick={onReopenIssue}
                >
                  Reopen issue
                </Button>
              )}
              <Button
                htmlType="button"
                variant="primary"
                size="small"
                shape="round"
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
