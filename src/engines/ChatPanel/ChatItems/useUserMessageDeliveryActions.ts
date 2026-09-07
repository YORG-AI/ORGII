import { useCallback } from "react";

import type { ComposerSnapshot } from "@src/components/ComposerInput";
import { Message } from "@src/components/Message";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { useSessionCommentsContext } from "@src/features/Org2Cloud/SessionComments/SessionCommentsContext";
import { discussionPayloadOf } from "@src/features/Org2Cloud/SessionConversation/discussionEvents";

import { useGroupChatContext } from "../ChatHistory/GroupChatView/GroupChatContext";

interface UserMessageDeliveryActions {
  /** The current viewer may edit this failed transport row. */
  canEditFailed: boolean;
  retry: (() => void) | null;
  /** Returns true when a transport accepted responsibility for the edit. */
  editAndRetry:
    | ((text: string, composerSnapshot?: ComposerSnapshot) => Promise<boolean>)
    | null;
}

/**
 * Transport adapter for failed user rows.
 *
 * `UserChatItem` renders only these neutral actions. Cloud comments and
 * Agent-team chat retain ownership of retry validation, idempotency and wire
 * delivery in their existing contexts.
 */
export function useUserMessageDeliveryActions(params: {
  event: SessionEvent | undefined;
  deliveryStatus: "pending" | "sent" | "failed" | null;
}): UserMessageDeliveryActions {
  const comments = useSessionCommentsContext();
  const groupChat = useGroupChatContext();
  const discussion = params.event ? discussionPayloadOf(params.event) : null;
  const groupChatInboxId =
    typeof params.event?.args?.groupChatInboxId === "number"
      ? params.event.args.groupChatInboxId
      : null;
  const canEditFailed = Boolean(
    params.deliveryStatus === "failed" &&
    comments?.viewerUserId &&
    discussion?.authorUserId === comments.viewerUserId
  );

  const reportFailure = useCallback((error: unknown) => {
    Message.error(error instanceof Error ? error.message : String(error));
  }, []);

  if (
    params.deliveryStatus === "failed" &&
    canEditFailed &&
    comments &&
    discussion?.commentId
  ) {
    return {
      canEditFailed: true,
      retry: () => {
        void comments.retryComment(discussion.commentId).catch(reportFailure);
      },
      editAndRetry: async (
        text: string,
        composerSnapshot?: ComposerSnapshot
      ) => {
        try {
          await comments.retryComment(
            discussion.commentId,
            text,
            composerSnapshot
          );
          return true;
        } catch (error) {
          reportFailure(error);
          return false;
        }
      },
    };
  }
  if (
    params.deliveryStatus === "failed" &&
    groupChat &&
    groupChatInboxId !== null
  ) {
    return {
      canEditFailed: true,
      retry: () => groupChat.retryFailedMessage(groupChatInboxId),
      editAndRetry: async (text: string) => {
        try {
          groupChat.retryFailedMessage(groupChatInboxId, text);
          return true;
        } catch (error) {
          reportFailure(error);
          return false;
        }
      },
    };
  }
  return {
    canEditFailed: false,
    retry: null,
    editAndRetry: null,
  };
}
