/**
 * ChatBubble Component
 *
 * Renders user and agent chat message events inside the Communication simulator.
 */
import { User } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleAvatar,
  ChatBubbleCopyButton,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import { containsMarkdownFence } from "@src/components/MarkDown/markdownUtils";
import MessageReferenceCards from "@src/engines/ChatPanel/blocks/MessageReferenceCards";
import { SESSION_UI_TOKENS } from "@src/engines/ChatPanel/blocks/primitives/config";
import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import {
  COMMUNICATION_AVATAR_ICON_SIZE,
  useCommunicationAgentIdentity,
} from "../communicationAgentIdentity";
import type { MessageEntry } from "../types";
import { ReplayMarkdown } from "./ReplayMarkdown";
import { UserBubbleContent } from "./UserBubbleContent";

export {
  InteractionBubble,
  PlanBubble,
  TodoBubble,
} from "./agentBubbleVariants";

const AVATAR_ICON_SIZE = COMMUNICATION_AVATAR_ICON_SIZE;

function isSyntheticLiveAssistantEvent(message: MessageEntry): boolean {
  return (
    message.sender === "agent" &&
    message.event.args?.syntheticLive === true &&
    message.event.displayStatus === "running"
  );
}

interface ChatBubbleProps {
  message: MessageEntry;
  index: number;
  isLatest?: boolean;
  onClick?: () => void;
  showChrome?: boolean;
  /**
   * Active org-run member roster. Used to resolve a subagent display
   * name (e.g. "Planner") from `event.sessionId` on multi-agent
   * surfaces. Falls back to the generic "Agent" label when omitted or
   * the session is not in the roster.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

/**
 * Presentational chat bubble. Never subscribes to streaming state — any live
 * token content is passed in via `liveContent` by the `ChatBubble` wrapper,
 * so only the single synthetic-live bubble re-renders on each ≤20Hz token
 * flush instead of every mounted bubble in the conversation.
 */
const ChatBubbleView: React.FC<
  ChatBubbleProps & { liveContent: string | null }
> = memo(
  ({
    message,
    index,
    isLatest = false,
    onClick,
    showChrome = true,
    orgMembers,
    liveContent,
  }) => {
    const { t, i18n } = useTranslation(["common", "projects", "sessions"]);
    const isUser = message.sender === "user";
    const { rawAgentName, agentIcon } = useCommunicationAgentIdentity(
      message.event,
      orgMembers
    );
    const agentSenderName = rawAgentName;
    const resolvedContent = liveContent ?? message.content;

    const rawContent =
      typeof resolvedContent === "string"
        ? resolvedContent
        : String(resolvedContent ?? "");
    const hasCodeBlockCopy = !isUser && containsMarkdownFence(rawContent);
    const userImages = useMemo<string[] | undefined>(() => {
      if (!isUser) return undefined;
      const result = message.event.result as { images?: unknown } | undefined;
      const raw = result?.images;
      if (Array.isArray(raw) && raw.length > 0) {
        return raw.filter((ref): ref is string => typeof ref === "string");
      }
      return undefined;
    }, [isUser, message.event.result]);
    const hasUserImages = !!userImages && userImages.length > 0;
    if (isUser && !rawContent.trim() && !hasUserImages) {
      return null;
    }

    return (
      <ChatBubbleLayout
        align="left"
        onClick={onClick}
        interactive={false}
        className={CHAT_BUBBLE_WIDTH_TOKENS.row}
        dataAttr={
          isUser
            ? { "data-replay-user-msg": index }
            : { "data-replay-agent-msg": index }
        }
        avatar={
          showChrome || isUser ? (
            <ChatBubbleAvatar
              className={`h-8 w-8 ${isUser ? "bg-primary-1" : "bg-fill-2"}`}
              icon={
                isUser ? (
                  <User size={AVATAR_ICON_SIZE} className="text-primary-6" />
                ) : (
                  agentIcon
                )
              }
            />
          ) : (
            <div className="h-8 w-8 shrink-0" aria-hidden="true" />
          )
        }
      >
        {showChrome && (
          <ChatBubbleHeader
            senderName={isUser ? t("terminology.you") : agentSenderName}
            timestamp={formatSmartDateTime(message.timestamp, {
              yesterdayLabel: t("relativeDate.yesterday"),
              locale: toIntlLocaleTag(i18n.resolvedLanguage),
            })}
            align="left"
          />
        )}
        {isUser ? (
          <UserBubbleContent content={rawContent} images={userImages} />
        ) : (
          <div
            className={`${CHAT_BUBBLE_WIDTH_TOKENS.body} group/replay-msg relative rounded-lg p-3 text-left text-text-1 ${
              isLatest ? "bg-fill-2" : "bg-fill-1"
            }`}
          >
            {!hasCodeBlockCopy && <ChatBubbleCopyButton content={rawContent} />}
            <div className={`min-w-0 ${SESSION_UI_TOKENS.TEXT.BODY_BASE}`}>
              <ReplayMarkdown content={rawContent} />
              <MessageReferenceCards
                content={rawContent}
                enabled={message.event.displayStatus !== "running"}
                sessionId={message.event.sessionId}
              />
            </div>
          </div>
        )}
      </ChatBubbleLayout>
    );
  }
);
ChatBubbleView.displayName = "ChatBubbleView";

/**
 * Subscribes to the streaming delta for its session and feeds the live token
 * text to the presentational bubble. Rendered only for the synthetic-live
 * assistant message (always the latest), so historical bubbles never open a
 * streaming subscription.
 */
const LiveChatBubble: React.FC<ChatBubbleProps> = (props) => {
  const delta = useStreamingDeltaForSession(props.message.event.sessionId);
  const liveContent = delta?.kind === "message" ? delta.content : null;
  return <ChatBubbleView {...props} liveContent={liveContent} />;
};

export const ChatBubble: React.FC<ChatBubbleProps> = memo((props) =>
  isSyntheticLiveAssistantEvent(props.message) ? (
    <LiveChatBubble {...props} />
  ) : (
    <ChatBubbleView {...props} liveContent={null} />
  )
);
ChatBubble.displayName = "ChatBubble";
