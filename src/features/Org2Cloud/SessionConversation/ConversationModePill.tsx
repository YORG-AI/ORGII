import React from "react";
import { useTranslation } from "react-i18next";

import SelectorPill from "@src/components/SelectorPill";
import { BotIcon, HugeiconsIcon, MessageMultiple01Icon } from "@src/icons";

import {
  useConversationComposerMode,
  useConversationTeamChatAvailable,
} from "./useConversationComposer";

/**
 * Composer target toggle: Prompt (agent turn) vs Team chat (discussion
 * message). Hidden entirely on sessions without a cloud discussion plane.
 */
export function ConversationModePill({
  sessionId,
}: {
  sessionId: string | null;
}): React.ReactElement | null {
  const { t } = useTranslation("sessions");
  const available = useConversationTeamChatAvailable();
  const [mode, setMode] = useConversationComposerMode(sessionId);

  if (!available || !sessionId) return null;

  const teamChat = mode === "team_chat";
  return (
    <SelectorPill
      icon={
        teamChat ? (
          <HugeiconsIcon
            icon={MessageMultiple01Icon}
            data-icon="messages-square"
            size={14}
            strokeWidth={1.75}
          />
        ) : (
          <HugeiconsIcon
            icon={BotIcon}
            data-icon="bot"
            size={14}
            strokeWidth={1.75}
          />
        )
      }
      label={
        teamChat ? t("conversation.teamChatMode") : t("conversation.promptMode")
      }
      tooltip={
        teamChat
          ? t("conversation.teamChatTooltip")
          : t("conversation.promptTooltip")
      }
      tooltipFramed
      tooltipPosition="top"
      active={teamChat}
      dataTestId="conversation-mode-pill"
      onClick={() => setMode(teamChat ? "prompt" : "team_chat")}
      size="sm"
    />
  );
}
