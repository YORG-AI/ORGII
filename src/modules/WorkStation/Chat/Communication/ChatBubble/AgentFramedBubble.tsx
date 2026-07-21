import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleAvatar,
  ChatBubbleBody,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import { useCommunicationAgentIdentity } from "../communicationAgentIdentity";
import type { MessageEntry } from "../types";

export type AgentFramedTitleKind = "generic" | "todo" | "plan" | "interaction";

export interface AgentFramedBubbleProps {
  message: MessageEntry;
  onClick?: () => void;
  /** Skip bordered/padded body — for cards that bring their own container chrome. */
  unframed?: boolean;
  titleKind?: AgentFramedTitleKind;
  /**
   * Active org-run member roster. Used to resolve the bubble header
   * label from `event.sessionId` so multi-agent surfaces show the
   * subagent's real name (e.g. "Planner") instead of the generic
   * "Agent" fallback.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  children: React.ReactNode;
}

export const AgentFramedBubble: React.FC<AgentFramedBubbleProps> = ({
  message,
  onClick,
  unframed = false,
  titleKind = "generic",
  orgMembers,
  children,
}) => {
  const { t, i18n } = useTranslation(["common", "projects", "sessions"]);
  const { rawAgentName, agentIcon, isAgentOrgBubble } =
    useCommunicationAgentIdentity(message.event, orgMembers);
  const senderName = useMemo(() => {
    if (isAgentOrgBubble || titleKind === "generic") return rawAgentName;
    if (titleKind === "todo") {
      return t(
        "sessions:simulator.replay.messages.bubble.senderTitle.updatedTodos",
        {
          subject: rawAgentName,
        }
      );
    }
    if (titleKind === "plan") {
      return t(
        "sessions:simulator.replay.messages.bubble.senderTitle.updatedPlan",
        {
          subject: rawAgentName,
        }
      );
    }
    return t(
      "sessions:simulator.replay.messages.bubble.senderTitle.requestedInput",
      {
        subject: rawAgentName,
      }
    );
  }, [isAgentOrgBubble, rawAgentName, t, titleKind]);

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
        senderName={senderName}
        timestamp={formatSmartDateTime(message.timestamp, {
          yesterdayLabel: t("relativeDate.yesterday"),
          locale: toIntlLocaleTag(i18n.resolvedLanguage),
        })}
        align="left"
      />
      {unframed ? (
        children
      ) : (
        <ChatBubbleBody
          variant="agent"
          className="border border-border-2 bg-transparent px-3 py-2.5"
        >
          {children}
        </ChatBubbleBody>
      )}
    </ChatBubbleLayout>
  );
};
