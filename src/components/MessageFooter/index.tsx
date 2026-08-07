/**
 * Shared message-footer primitives.
 *
 * Keeps settled-message metadata and actions in a consistent row below the
 * message body. The primitive is deliberately conversation-agnostic so chat,
 * replay, and inbox surfaces can share it without importing turn state.
 */
import { Copy } from "lucide-react";
import React, { memo, useCallback } from "react";

import Message from "@src/components/Message";

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
  content: string;
  copyLabel: string;
  copiedLabel: string;
}

export const MessageFooterCopyButton: React.FC<MessageFooterCopyButtonProps> =
  memo(({ content, copyLabel, copiedLabel }) => {
    const handleCopy = useCallback(
      async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        await navigator.clipboard.writeText(content);
        Message.success(copiedLabel);
      },
      [content, copiedLabel]
    );

    if (!content.trim()) return null;

    return (
      <button
        type="button"
        data-testid="message-footer-copy"
        title={copyLabel}
        aria-label={copyLabel}
        className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text-3 opacity-0 transition-[opacity,background-color,color] hover:bg-fill-2 hover:text-text-1 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30 group-focus-within/agent-message:opacity-100 group-hover/agent-message:opacity-100"
        onClick={handleCopy}
      >
        <Copy size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
    );
  });

MessageFooterCopyButton.displayName = "MessageFooterCopyButton";

export interface MessageFooterProps {
  content: string;
  timestamp: string;
  timestampLabel: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
}

const MessageFooter: React.FC<MessageFooterProps> = memo(
  ({
    content,
    timestamp,
    timestampLabel,
    copyLabel,
    copiedLabel,
    className = "",
  }) => {
    if (!content.trim() && !timestampLabel) return null;

    return (
      <div
        data-testid="message-footer"
        className={`flex min-h-6 items-center justify-between gap-2 ${className}`}
      >
        <MessageFooterTimestamp dateTime={timestamp} label={timestampLabel} />
        <MessageFooterCopyButton
          content={content}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
        />
      </div>
    );
  }
);

MessageFooter.displayName = "MessageFooter";

export default MessageFooter;
