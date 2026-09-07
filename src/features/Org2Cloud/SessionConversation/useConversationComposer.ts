import { useAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  type SubmitOverrideInput,
  SubmitRetainedDeliveryError,
  SubmitValidationError,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";

import { useSessionCommentsContext } from "../SessionComments/SessionCommentsContext";
import { CLOUD_COMMENT_MAX_MENTIONED_USER_IDS } from "../org2CloudCommentsClient";
import { SessionCommentDeliveryError } from "../org2CloudSessionCommentsAtom";
import {
  type ConversationComposerMode,
  conversationComposerModeAtomFamily,
} from "./conversationComposerMode";
import {
  hasUnsupportedTeamChatAudiencePill,
  isTeamChatBodyWithinLimit,
  isTeamChatMentionAudienceWithinLimit,
  resolveTeamChatMentionedUserIds,
} from "./teamChatMentions";

export function useConversationComposerMode(
  sessionId: string | null
): [ConversationComposerMode, (mode: ConversationComposerMode) => void] {
  const [mode, setMode] = useAtom(
    conversationComposerModeAtomFamily(sessionId ?? "")
  );
  const comments = useSessionCommentsContext();
  const teamChatAvailable = Boolean(
    sessionId && comments?.target && comments.viewerUserId
  );
  const effectiveMode = teamChatAvailable ? mode : "prompt";
  const setEffectiveMode = useCallback(
    (nextMode: ConversationComposerMode) => {
      setMode(
        nextMode === "team_chat" && !teamChatAvailable ? "prompt" : nextMode
      );
    },
    [setMode, teamChatAvailable]
  );
  return [effectiveMode, setEffectiveMode];
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
 * surface's own Team Chat override or the default canonical Agent submit.
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
      if (hasUnsupportedTeamChatAudiencePill(input.composerSnapshot)) {
        throw new SubmitValidationError(t("conversation.teamChatTooltip"));
      }
      const body = input.displayText.trim();
      if (!body) return true;
      if (!isTeamChatBodyWithinLimit(body)) {
        throw new SubmitValidationError(
          t("navigation:cloud.channels.feed.errorTooLong")
        );
      }
      const mentionedUserIds = resolveTeamChatMentionedUserIds(
        body,
        comments.mentionableMembers,
        input.composerSnapshot,
        comments.viewerUserId
      );
      if (!isTeamChatMentionAudienceWithinLimit(mentionedUserIds)) {
        throw new SubmitValidationError(
          `@all is unavailable when it would notify more than ${CLOUD_COMMENT_MAX_MENTIONED_USER_IDS} people`
        );
      }
      try {
        await comments.addComment({
          body,
          ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
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
