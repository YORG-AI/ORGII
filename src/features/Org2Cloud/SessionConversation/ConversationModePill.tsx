import React from "react";
import { useTranslation } from "react-i18next";

import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import SegmentedTextPill from "@src/components/SegmentedTextPill";
import { Infinity01Icon, HugeiconsIcon, MessagesSquareIcon } from "@src/icons";

import {
  useConversationComposerMode,
  useConversationTeamChatAvailable,
} from "./useConversationComposer";

/**
 * Composer target switch: Agent (agent turn) vs Team chat (discussion
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

  return (
    <SegmentedTextPill
      ariaLabel={`${t("conversation.promptMode")} / ${t("conversation.teamChatMode")}`}
      className="whitespace-nowrap"
      dataTestId="conversation-mode-pill"
      value={mode}
      options={[
        {
          value: "prompt",
          ariaLabel: t("conversation.promptMode"),
          label: (
            <HugeiconsIcon
              icon={Infinity01Icon}
              data-icon="infinity"
              size={PILL_SM_ICON_SIZE}
              strokeWidth={1.75}
              className="block"
              aria-hidden
            />
          ),
          tooltip: (
            <KeyboardShortcutTooltipContent
              label={t("conversation.promptTooltip")}
              noShortcut
            />
          ),
        },
        {
          value: "team_chat",
          ariaLabel: t("conversation.teamChatMode"),
          label: (
            <HugeiconsIcon
              icon={MessagesSquareIcon}
              data-icon="messages-square"
              size={PILL_SM_ICON_SIZE}
              strokeWidth={1.75}
              className="block"
              aria-hidden
            />
          ),
          tooltip: (
            <KeyboardShortcutTooltipContent
              label={t("conversation.teamChatTooltip")}
              noShortcut
            />
          ),
        },
      ]}
      onChange={setMode}
    />
  );
}
