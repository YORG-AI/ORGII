import { useAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  type SubmitOverrideInput,
  SubmitRetainedDeliveryError,
  SubmitValidationError,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { resolveMessageAudience } from "@src/features/TeamCollaboration/messageAudienceRouting";

import { useSessionCommentsContext } from "../SessionComments/SessionCommentsContext";
import { SessionCommentDeliveryError } from "../org2CloudSessionCommentsAtom";
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
  return Boolean(comments?.target && comments.viewerUserId);
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
      if (!comments.viewerUserId) {
        throw new SubmitValidationError(t("common:errors.api.messages.signIn"));
      }
      if (input.imageDataUrls?.length) {
        throw new SubmitValidationError(t("conversation.imagesUnsupported"));
      }
      const body = input.displayText.trim();
      if (!body) return true;
      const audience = resolveMessageAudience(
        "team_chat",
        resolveTeamChatMentions(body, comments.mentionableMembers).map(
          (id) => ({
            kind: "member" as const,
            id,
          })
        )
      );
      try {
        await comments.addComment({
          body,
          ...(audience.human.scope === "members"
            ? { mentionedUserIds: audience.human.memberIds }
            : {}),
        });
      } catch (error) {
        if (error instanceof SessionCommentDeliveryError) {
          throw new SubmitRetainedDeliveryError(error);
        }
        throw error;
      }
      return true;
    },
    [mode, comments, fallback, t]
  );
}
