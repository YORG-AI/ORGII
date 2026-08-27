import { useAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { SubmitOverrideInput } from "@src/engines/ChatPanel/hooks/useInputArea/types";

import { useSessionCommentsContext } from "../SessionComments/SessionCommentsContext";
import {
  type ConversationComposerMode,
  conversationComposerModeAtomFamily,
} from "./conversationComposerMode";
import { resolveTeamChatMentions } from "./teamChatMentions";

export function useConversationComposerMode(
  sessionId: string | null
): [ConversationComposerMode, (mode: ConversationComposerMode) => void] {
  const [mode, setMode] = useAtom(
    conversationComposerModeAtomFamily(sessionId ?? "")
  );
  return [sessionId ? mode : "prompt", setMode];
}

/** True when this composer can address a cloud discussion at all. */
export function useConversationTeamChatAvailable(): boolean {
  const comments = useSessionCommentsContext();
  return Boolean(comments?.target);
}

/**
 * Composer submit router. Team chat mode posts the text as a session
 * discussion message (comment wire); only explicit `@name` mentions in the
 * body notify anyone (team inbox). Prompt mode falls through to the
 * surface's own override (imported-session fork, group-chat routing) or the
 * default agent submit.
 */
export function useConversationSubmitOverride(
  sessionId: string | null,
  fallback?: (input: SubmitOverrideInput) => Promise<boolean>
): (input: SubmitOverrideInput) => Promise<boolean> {
  const { t } = useTranslation("sessions");
  const comments = useSessionCommentsContext();
  const [mode] = useConversationComposerMode(sessionId);

  return useCallback(
    async (input: SubmitOverrideInput) => {
      if (mode !== "team_chat" || !comments?.target) {
        return fallback ? fallback(input) : false;
      }
      if (input.imageDataUrls?.length) {
        throw new Error(t("conversation.imagesUnsupported"));
      }
      const body = input.displayText.trim();
      if (!body) return true;
      const mentionedUserIds = resolveTeamChatMentions(
        body,
        comments.mentionableMembers
      );
      await comments.addComment({
        body,
        ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
      });
      return true;
    },
    [mode, comments, fallback, t]
  );
}
