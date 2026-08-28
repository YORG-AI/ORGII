import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HugeiconsIcon, PlayIcon } from "@src/icons";

export const CHAT_RETRY_KIND = {
  RECONNECTING: "reconnecting",
  RATE_LIMITED: "rate_limited",
} as const;

export type ChatRetryKind =
  (typeof CHAT_RETRY_KIND)[keyof typeof CHAT_RETRY_KIND];

export const CHAT_STATUS_BAR_CONTAINER_CLASS =
  "-mb-8 flex min-h-10 w-full items-center rounded-t-[12px] bg-[var(--color-chat-container)] pb-9 pl-1 pt-2 text-[12px] font-medium text-text-1";

export function toChatRetryKind(kind: string): ChatRetryKind {
  return kind === CHAT_RETRY_KIND.RATE_LIMITED
    ? CHAT_RETRY_KIND.RATE_LIMITED
    : CHAT_RETRY_KIND.RECONNECTING;
}

interface ChatStatusBarSegment {
  key: string;
  content: React.ReactNode;
  className?: string;
}

interface ChatStatusSegmentedBarProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "className"
> {
  segments: ChatStatusBarSegment[];
  testId?: string;
}

interface ChatStatusTwoLineContentProps {
  title: React.ReactNode;
  description: React.ReactNode;
}

export function ChatStatusTwoLineContent({
  title,
  description,
}: ChatStatusTwoLineContentProps) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 leading-[1.25]">
      <span className="truncate font-medium text-text-1">{title}</span>
      <span className="truncate text-[11px] font-normal text-text-2">
        {description}
      </span>
    </span>
  );
}

function ChatStatusBarSeparator() {
  return (
    <span aria-hidden className="inline-flex h-3 w-px shrink-0 bg-border-2" />
  );
}

export function ChatStatusSegmentedBar({
  segments,
  testId,
  ...restProps
}: ChatStatusSegmentedBarProps) {
  return (
    <div
      {...restProps}
      data-testid={testId}
      className={CHAT_STATUS_BAR_CONTAINER_CLASS}
    >
      {segments.map((segment, index) => (
        <React.Fragment key={segment.key}>
          {index > 0 && <ChatStatusBarSeparator />}
          <span
            className={`inline-flex min-w-0 items-center gap-1 px-2 ${
              segment.className ?? ""
            }`}
          >
            {segment.content}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

interface ChatRetryStatusItem {
  kind: ChatRetryKind;
  attempt: number;
  maxAttempts: number;
}

interface ChatRetryStatusBarProps {
  items: ChatRetryStatusItem[];
}

export function ChatRetryStatusBar({ items }: ChatRetryStatusBarProps) {
  const { t } = useTranslation("sessions");
  if (items.length === 0) return null;

  return (
    <ChatStatusSegmentedBar
      segments={items.map((item) => {
        const isRateLimited = item.kind === CHAT_RETRY_KIND.RATE_LIMITED;
        return {
          key: item.kind,
          className: isRateLimited ? "text-warning-6" : "text-primary-6",
          content: (
            <span className="truncate">
              {isRateLimited
                ? t("chat.rateLimitedRetrying", {
                    attempt: item.attempt,
                    max: item.maxAttempts,
                  })
                : t("chat.reconnecting", {
                    attempt: item.attempt,
                    max: item.maxAttempts,
                  })}
            </span>
          ),
        };
      })}
    />
  );
}

interface ChatRetryBannerProps {
  kind: ChatRetryKind;
  attempt: number;
  maxAttempts: number;
}

export function ChatRetryBanner({
  kind,
  attempt,
  maxAttempts,
}: ChatRetryBannerProps) {
  return (
    <ChatRetryStatusBar
      items={[
        {
          kind,
          attempt,
          maxAttempts,
        },
      ]}
    />
  );
}

interface GroupChatPausedBannerProps {
  disabled?: boolean;
  onResume: () => void;
  testId?: string;
  resumeButtonTestId?: string;
}

export function GroupChatPausedBanner({
  disabled,
  onResume,
  testId = "agent-org-group-chat-paused-banner",
  resumeButtonTestId = "agent-org-group-chat-resume-button",
}: GroupChatPausedBannerProps) {
  const { t } = useTranslation("sessions");

  return (
    <ChatStatusSegmentedBar
      testId={testId}
      segments={[
        {
          key: "message",
          className: "flex-1",
          content: (
            <ChatStatusTwoLineContent
              title={t("groupChat.pausedBanner.title", {
                defaultValue: "New work is paused",
              })}
              description={t("groupChat.pausedBanner.body", {
                defaultValue:
                  "Pause stops active replies, send a message or press Resume to continue",
              })}
            />
          ),
        },
        {
          key: "resume",
          className: "shrink-0 px-0",
          content: (
            <Button
              variant="primary"
              shape="round"
              size="mini"
              htmlType="button"
              data-testid={resumeButtonTestId}
              disabled={disabled}
              onClick={onResume}
              icon={
                <HugeiconsIcon
                  icon={PlayIcon}
                  data-icon="play"
                  size={12}
                  strokeWidth={2}
                />
              }
            >
              {t("groupChat.pausedBanner.resume", {
                defaultValue: "Resume",
              })}
            </Button>
          ),
        },
      ]}
    />
  );
}
