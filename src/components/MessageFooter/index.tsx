/**
 * Shared message-footer primitives.
 *
 * Keeps settled-message metadata and actions in a consistent row below the
 * message body. The primitive is deliberately conversation-agnostic so chat,
 * replay, and inbox surfaces can share it without importing turn state.
 */
import React, { memo, useCallback } from "react";

import Message from "@src/components/Message";
import { Copy01Icon, HugeiconsIcon } from "@src/icons";
import { copyText } from "@src/util/data/clipboard";

export interface MessageFooterTimestampProps {
  dateTime: string;
  label: string;
}

export const MessageFooterTimestamp: React.FC<MessageFooterTimestampProps> =
  memo(({ dateTime, label }) => {
    if (!label) return null;

    return (
      <time
        dateTime={dateTime}
        className="min-w-0 truncate text-[11px] leading-none text-text-3"
      >
        {label}
      </time>
    );
  });

MessageFooterTimestamp.displayName = "MessageFooterTimestamp";

export interface MessageFooterCopyButtonProps {
  getCopyContent?: () => string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}

export const MessageFooterCopyButton: React.FC<MessageFooterCopyButtonProps> =
  memo(({ getCopyContent, copyLabel, copiedLabel, copyFailedLabel }) => {
    const handleCopy = useCallback(
      async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        try {
          const content = getCopyContent?.() ?? "";
          if (!content.trim()) throw new Error("Copy content is unavailable");
          await copyText(content);
          Message.success(copiedLabel);
        } catch {
          Message.error(copyFailedLabel);
        }
      },
      [copiedLabel, copyFailedLabel, getCopyContent]
    );

    if (!getCopyContent) return null;

    return (
      <button
        type="button"
        data-testid="message-footer-copy"
        title={copyLabel}
        aria-label={copyLabel}
        className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text-3 opacity-0 transition-[opacity,background-color,color] hover:bg-fill-2 hover:text-text-1 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30 group-focus-within/agent-message:opacity-100 group-hover/agent-message:opacity-100"
        onClick={handleCopy}
      >
        <HugeiconsIcon
          icon={Copy01Icon}
          data-icon="copy"
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>
    );
  });

MessageFooterCopyButton.displayName = "MessageFooterCopyButton";

export interface MessageFooterProps {
  getCopyContent?: () => string;
  timestamp: string;
  timestampLabel: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  className?: string;
}

const MessageFooter: React.FC<MessageFooterProps> = memo(
  ({
    getCopyContent,
    timestamp,
    timestampLabel,
    copyLabel,
    copiedLabel,
    copyFailedLabel,
    className = "",
  }) => {
    if (!getCopyContent && !timestampLabel) return null;

    return (
      <div
        data-testid="message-footer"
        className={`flex min-h-6 items-center justify-between gap-2 ${className}`}
      >
        <MessageFooterTimestamp dateTime={timestamp} label={timestampLabel} />
        <MessageFooterCopyButton
          getCopyContent={getCopyContent}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
          copyFailedLabel={copyFailedLabel}
        />
      </div>
    );
  }
);

MessageFooter.displayName = "MessageFooter";

export default MessageFooter;
