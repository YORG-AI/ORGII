/**
 * FeedMessage
 *
 * Individual message card in the channel feed.
 * Renders differently based on message category:
 * - Git commits: show changed files
 * - Promotions: show action button
 * - Work items: show project/work-item metadata
 */
import React, { useState } from "react";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import {
  ChatBubbleAvatar,
  ChatBubbleBody,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  Loading03Icon,
  SquareArrowUpRightIcon,
} from "@src/icons";

import {
  type InboxCategory,
  formatInboxDateCompact,
  getCategoryChannelConfig,
} from "../config";
import { useCommitFiles } from "../hooks/useCommitFiles";
import type { InboxMessage } from "../types";

interface FeedMessageProps {
  message: InboxMessage;
  /** Placed outside the bubble (absolute, right of card), does not affect bubble width */
  bubbleOutsideActions?: React.ReactNode;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
  none: "",
};

const GIT_FILE_STATUS: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "text-success-6" },
  deleted: { letter: "D", color: "text-danger-6" },
  modified: { letter: "M", color: "text-warning-6" },
  renamed: { letter: "R", color: "text-success-6" },
};

const FeedMessage: React.FC<FeedMessageProps> = ({
  message,
  bubbleOutsideActions,
}) => {
  const channelConfig = getCategoryChannelConfig(message.category);
  const Icon = channelConfig?.icon;
  const accentColor = channelConfig?.color ?? "#6b7280";
  const timeLabel = formatInboxDateCompact(message.createdAt);
  const isUnread = message.status === "unread";

  const headerExtra = (
    <>
      {message.metadata?.branch && (
        <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[10px] text-text-3">
          {message.metadata.branch}
        </span>
      )}
      {isUnread && <span className="h-1.5 w-1.5 rounded-full bg-primary-6" />}
      {message.priority !== "none" &&
        message.priority !== "low" &&
        PRIORITY_COLORS[message.priority] && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: PRIORITY_COLORS[message.priority] }}
          />
        )}
    </>
  );

  return (
    <div className="w-fit max-w-full px-3 py-2.5">
      <ChatBubbleLayout
        className="flex w-max max-w-full gap-3"
        avatar={
          <ChatBubbleAvatar
            className="mt-0.5 h-7 w-7"
            bgColor={`${accentColor}15`}
            icon={
              Icon ? (
                <AnyIcon icon={Icon} size={14} style={{ color: accentColor }} />
              ) : null
            }
          />
        }
      >
        <ChatBubbleHeader
          senderName={message.sender?.name ?? message.category}
          timestamp={timeLabel}
          extra={headerExtra}
        />
        <div className="relative w-fit max-w-full">
          <ChatBubbleBody variant="agent">
            <p className={isUnread ? "font-medium" : ""}>{message.title}</p>

            {message.preview !== message.title && (
              <p className="mt-0.5 text-xs text-text-3">{message.preview}</p>
            )}

            {message.labels && message.labels.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {message.labels.map((label) => (
                  <span
                    key={label.id}
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${label.color}18`,
                      color: label.color,
                    }}
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            )}

            {message.id.startsWith("git-commit-") && (
              <CommitFilesBlock messageId={message.id} />
            )}

            {message.category === "promotion" &&
              message.metadata?.actionUrl && (
                <div className="mt-2">
                  <Button
                    size="mini"
                    variant="secondary"
                    onClick={() =>
                      window.open(message.metadata?.actionUrl, "_blank")
                    }
                    icon={
                      <HugeiconsIcon
                        icon={SquareArrowUpRightIcon}
                        data-icon="square-arrow-out-up-right"
                        size={12}
                      />
                    }
                  >
                    View Offer
                  </Button>
                </div>
              )}

            {message.category === "git" && message.metadata?.commitHash && (
              <span className="mt-1 inline-block rounded bg-fill-2 px-1.5 py-0.5 text-[10px] text-text-3">
                {message.metadata.commitHash}
              </span>
            )}
          </ChatBubbleBody>
          {bubbleOutsideActions}
        </div>
      </ChatBubbleLayout>
    </div>
  );
};

// ============================================
// Git commit changed files (inline)
// ============================================

const CommitFilesBlock: React.FC<{ messageId: string }> = ({ messageId }) => {
  const {
    files: commitFiles,
    loading: filesLoading,
    totalStats,
  } = useCommitFiles(messageId);
  const [expanded, setExpanded] = useState(false);

  if (filesLoading && commitFiles.length === 0) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[13px] text-text-3">
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader-2"
          size={SPINNER_TOKENS.default + 2}
          className="animate-spin text-text-3"
        />
        <span>Loading files...</span>
      </div>
    );
  }

  if (commitFiles.length === 0) return null;

  const Chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex cursor-pointer items-center gap-2 text-[13px] text-text-3 transition-colors hover:text-text-2"
      >
        <HugeiconsIcon
          icon={Chevron}
          size={14}
          className="shrink-0"
          strokeWidth={2}
        />
        <span>
          {commitFiles.length} file{commitFiles.length !== 1 ? "s" : ""}
        </span>
        {totalStats && (
          <DiffStatsBadge
            additions={totalStats.additions}
            deletions={totalStats.deletions}
            variant="plain"
          />
        )}
      </button>

      {expanded && (
        <div className="mt-1 space-y-0">
          {commitFiles.map((file) => {
            const status =
              GIT_FILE_STATUS[file.status] ?? GIT_FILE_STATUS.modified;
            const fileName = file.path.split("/").pop() ?? file.path;
            const dirPath = file.path.includes("/")
              ? file.path.slice(0, file.path.lastIndexOf("/"))
              : "";
            return (
              <div
                key={file.path}
                className="flex min-w-0 items-center gap-2 rounded px-1 py-1"
              >
                <FileTypeIcon
                  fileName={fileName}
                  size="medium"
                  className="shrink-0"
                />
                <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                  <span className="shrink-0 text-[13px] font-medium text-text-1">
                    {fileName}
                  </span>
                  {dirPath ? (
                    <span
                      className="min-w-0 flex-1 truncate text-[12px] font-normal text-text-2"
                      title={dirPath}
                    >
                      {dirPath}
                    </span>
                  ) : null}
                </div>
                <DiffStatsBadge
                  additions={file.additions}
                  deletions={file.deletions}
                  variant="plain"
                  size="sm"
                />
                <span
                  className={`shrink-0 text-[12px] font-semibold ${status.color}`}
                >
                  {status.letter}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================
// Category icon helper (for "all" channel where messages mix)
// ============================================

export function getCategoryIcon(category: InboxCategory) {
  return getCategoryChannelConfig(category)?.icon;
}

export default FeedMessage;
