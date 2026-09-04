/**
 * EmailMessageBubble
 *
 * Email-inbox style rendering for any "agent sent a message" event inside the
 * Communication > Messages tab. Currently used by three Rust tools (all
 * routed to AppChannels · Message · CbSentMessage):
 *
 *   - `org_send_message`  — inter-agent typed messages inside an Agent Team run
 *   - `send_message`      — outbound chat-channel sends (Telegram/Discord/etc.)
 *   - `send_to_inbox`     — agent → user inbox (notifications / messages)
 *
 * Each event has a different args/result shape, so a per-tool builder
 * (`buildEmailMessageView`) normalizes them into a uniform view model.
 *
 *   ┌── avatar ──┐  Agent · 10:42 AM
 *   │   🤖       │  ┌──────────────────────────────────────────────────┐
 *   └────────────┘  │ From       Sde planner                            │
 *                   │ To         Coordinator                            │
 *                   │ Subject    Updated branch policy for review       │
 *                   ├───────────────────────────────────────────────────┤
 *                   │ Full message body (expandable)                    │
 *                   │ [Show full message ▾]                             │
 *                   └───────────────────────────────────────────────────┘
 *
 * The bubble structure (avatar + header) is retained intentionally — the
 * email card is the *body* of the bubble, not a replacement for the bubble.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleAvatar,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import { parseTaskAssignedPrompt } from "@src/engines/ChatPanel/ChatHistory/GroupChatView/parseTaskAssignedPrompt";
import { parseAgentMessageCard } from "@src/engines/ChatPanel/blocks/ToolCallBlock/helpers/cardParsers";
import { BlockOutput } from "@src/engines/ChatPanel/blocks/primitives";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { truncate } from "@src/util/string/truncate";

import { useCommunicationAgentIdentity } from "./communicationAgentIdentity";
import type { MessageEntry } from "./types";
import { extractMessageContent, isAgentOrgInboxTranscriptEvent } from "./utils";

const SUBJECT_MAX_CHARS = 80;

export const EMAIL_BUBBLE_TOOLS = [
  "org_send_message",
  "send_message",
  "send_to_inbox",
] as const;

export type EmailBubbleTool = (typeof EMAIL_BUBBLE_TOOLS)[number];

export function isEmailBubbleEvent(event: SessionEvent): boolean {
  return (
    isAgentOrgInboxTranscriptEvent(event) ||
    (EMAIL_BUBBLE_TOOLS as readonly string[]).includes(event.functionName)
  );
}

/**
 * Normalized view model fed to the bubble UI. All fields except `body` are
 * optional — missing rows are simply omitted from the rendered header.
 */
interface EmailMessageView {
  /** Display string for the From row. May include a Rust member id as hover title. */
  sender?: { value: string; hoverId?: string };
  /** Display string for the To row. */
  recipient?: { value: string; hoverId?: string };
  /** Subject line. Empty string renders the localized "(no subject)" placeholder. */
  subject: string;
  /** Full message body. Empty string is rendered as the localized "(no body)" placeholder. */
  body: string;
}

interface EmailMessageBubbleProps {
  message: MessageEntry;
  onClick?: () => void;
  /**
   * Active org-run member roster. Used to resolve a subagent display
   * name (e.g. "Planner") from `event.sessionId` for the `send_message`
   * and `send_to_inbox` branches that don't carry a sender name in
   * their args (only `org_send_message` does). Falls back to the
   * generic "Agent" label when omitted.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function deriveSubjectFromBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return truncate(firstLine(trimmed), SUBJECT_MAX_CHARS);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Build the email view model for any of the three supported tools.
 * Each branch keeps the raw event types-narrow at the call site.
 */
function buildEmailMessageView(
  event: SessionEvent,
  t: ReturnType<typeof useTranslation>["t"],
  agentSenderLabel: string
): EmailMessageView {
  const args = (event.args as Record<string, unknown>) ?? {};
  const result = (event.result as Record<string, unknown>) ?? {};

  if (isAgentOrgInboxTranscriptEvent(event)) {
    const body = extractMessageContent(event).trim();
    const parsedTask = parseTaskAssignedPrompt(body);
    if (parsedTask) {
      return {
        sender: { value: parsedTask.assignedBy },
        recipient: { value: agentSenderLabel },
        subject: truncate(parsedTask.subject, SUBJECT_MAX_CHARS),
        body: parsedTask.description,
      };
    }
    return {
      sender: { value: t("cards.agentMessage.emailBubble.subagentMessages") },
      recipient: { value: "Coordinator" },
      subject: t("groupChat.inboxTranscript.readMessages", {
        defaultValue: "Coordinator read messages sent by other agents",
      }),
      body,
    };
  }

  switch (event.functionName) {
    case "org_send_message": {
      // Reuse the existing parser — it handles all message kinds and
      // already prettifies sender/recipient member ids.
      const card = parseAgentMessageCard(args, result);
      const body = (card.fullText || card.summary || "").trim();
      const subjectSource = card.summary?.trim() || firstLine(body);
      return {
        sender: card.sender
          ? { value: card.sender, hoverId: card.senderMemberId }
          : undefined,
        recipient: card.recipient
          ? { value: card.recipient, hoverId: card.recipientMemberId }
          : undefined,
        subject: truncate(subjectSource, SUBJECT_MAX_CHARS),
        body,
      };
    }

    case "send_to_inbox": {
      // args: { title, content, category?, priority? }
      const title = getString(args.title) ?? "";
      const content = getString(args.content) ?? "";
      const category = getString(args.category);
      const recipientLabel = category
        ? `${t("cards.agentMessage.emailBubble.userInbox")} · ${category}`
        : t("cards.agentMessage.emailBubble.userInbox");
      return {
        sender: { value: agentSenderLabel },
        recipient: { value: recipientLabel },
        subject: truncate(title, SUBJECT_MAX_CHARS),
        body: content,
      };
    }

    case "send_message": {
      // args: { content, channel?, chat_id? }
      const content = getString(args.content) ?? "";
      const channel = getString(args.channel);
      const chatId = getString(args.chat_id);
      const recipientValue =
        channel && chatId
          ? `${channel} · ${chatId}`
          : (channel ??
            chatId ??
            t("cards.agentMessage.emailBubble.currentChannel"));
      return {
        sender: { value: agentSenderLabel },
        recipient: { value: recipientValue, hoverId: chatId ?? channel },
        subject: deriveSubjectFromBody(content),
        body: content,
      };
    }

    default:
      return { subject: "", body: "" };
  }
}

/**
 * One labelled row inside the email card header.
 * Label sits in a fixed-width column so values line up vertically across locales.
 */
const HeaderRow: React.FC<{
  label: string;
  value: React.ReactNode;
  title?: string;
}> = ({ label, value, title }) => (
  <div className="flex min-w-0 items-baseline gap-2">
    <span className="w-16 shrink-0 text-text-3">{label}</span>
    <span
      className="min-w-0 flex-1 truncate text-text-1"
      title={title ?? (typeof value === "string" ? value : undefined)}
    >
      {value}
    </span>
  </div>
);
HeaderRow.displayName = "EmailMessageBubble.HeaderRow";

export const EmailMessageBubble: React.FC<EmailMessageBubbleProps> = memo(
  ({ message, onClick, orgMembers }) => {
    const { t, i18n } = useTranslation(["sessions", "common"]);
    const { rawAgentName, agentIcon, isAgentOrgBubble } =
      useCommunicationAgentIdentity(message.event, orgMembers);
    const agentSenderLabel = rawAgentName;
    const bubbleSenderName = isAgentOrgBubble
      ? rawAgentName
      : t("simulator.replay.messages.bubble.senderTitle.sentMessage", {
          subject: rawAgentName,
        });

    const view = useMemo(
      () => buildEmailMessageView(message.event, t, agentSenderLabel),
      // `t` is stable across renders for a given language; depending on it
      // here also re-runs the builder on locale switch (for the "Inbox" /
      // "Current channel" fallback strings).
      [agentSenderLabel, message.event, t]
    );

    const subjectLabel =
      view.subject || t("cards.agentMessage.emailBubble.noSubject");
    const hasBody = view.body.length > 0;

    return (
      <ChatBubbleLayout
        align="left"
        onClick={onClick}
        interactive={false}
        className={CHAT_BUBBLE_WIDTH_TOKENS.row}
        avatar={
          <ChatBubbleAvatar className="h-8 w-8 bg-fill-2" icon={agentIcon} />
        }
      >
        <ChatBubbleHeader
          senderName={bubbleSenderName}
          timestamp={formatSmartDateTime(message.timestamp, {
            yesterdayLabel: t("common:relativeDate.yesterday"),
            locale: toIntlLocaleTag(i18n.resolvedLanguage),
          })}
          align="left"
        />
        <div
          className={`${CHAT_BUBBLE_WIDTH_TOKENS.body} rounded-lg border border-border-2 text-left`}
          data-testid="email-message-bubble"
          data-tool-name={message.event.functionName}
        >
          {/* Email-style headers: From / To / Subject */}
          <div className="space-y-1 px-3 py-2 text-[13px] leading-normal">
            {view.sender && (
              <HeaderRow
                label={t("cards.agentMessage.meta.sender")}
                value={view.sender.value}
                title={view.sender.hoverId ?? view.sender.value}
              />
            )}
            {view.recipient && (
              <HeaderRow
                label={t("cards.agentMessage.meta.recipient")}
                value={view.recipient.value}
                title={view.recipient.hoverId ?? view.recipient.value}
              />
            )}
            <HeaderRow
              label={t("cards.agentMessage.meta.subject")}
              value={
                <span
                  className={
                    view.subject ? "text-text-1" : "text-text-3 italic"
                  }
                >
                  {subjectLabel}
                </span>
              }
              title={subjectLabel}
            />
          </div>

          {hasBody ? (
            <div className="border-t border-border-1">
              <BlockOutput
                output={view.body}
                withBorder={false}
                sessionId={message.event.sessionId}
                eventId={message.event.id}
              />
            </div>
          ) : (
            <div className="border-t border-border-1 px-3 py-2 text-[13px] text-text-3 italic">
              {t("cards.agentMessage.empty")}
            </div>
          )}
        </div>
      </ChatBubbleLayout>
    );
  }
);
EmailMessageBubble.displayName = "EmailMessageBubble";

export default EmailMessageBubble;
