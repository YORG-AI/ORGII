import { type ReactNode, memo } from "react";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionCommentsProvider } from "@src/features/Org2Cloud/SessionComments/SessionCommentsContext";
import { Org2ConversationSenderMetadataProvider } from "@src/features/Org2Cloud/SessionConversation/Org2ConversationSenderMetadataProvider";
import type { SessionCommentTarget } from "@src/features/Org2Cloud/sessionCommentTarget";
import type { Session } from "@src/store/session";

import { ConversationStreamProvider } from "./ConversationStreamProvider";
import { usePipelineChatEvents } from "./hooks/usePipelineChatEvents";

interface ChatViewLiveRegionProps {
  commentsSession: Session | null;
  commentsTargetOverride: SessionCommentTarget | null;
  turnAnchorsVisible: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  dataSessionId: string;
  conversationSessionId: string;
  conversationOverrideEvents: SessionEvent[] | undefined;
  children: (activeRunnerSessionId: string | null) => ReactNode;
}

/**
 * Owns the cloud comment-anchor identity subscription so the ChatView
 * shell can stay on narrow composer/layout atoms. Token-only transcript
 * updates do not rebuild the identity list.
 */
export const ChatViewLiveRegion = memo(function ChatViewLiveRegion({
  commentsSession,
  commentsTargetOverride,
  turnAnchorsVisible,
  rootRef,
  dataSessionId,
  conversationSessionId,
  conversationOverrideEvents,
  children,
}: ChatViewLiveRegionProps) {
  const { commentAnchors, transcriptReady } = usePipelineChatEvents();

  return (
    <SessionCommentsProvider
      session={commentsSession}
      targetOverride={commentsTargetOverride}
      events={transcriptReady ? commentAnchors : null}
      turnAnchorsVisible={turnAnchorsVisible}
    >
      <Org2ConversationSenderMetadataProvider
        sessionId={dataSessionId}
        session={commentsSession}
      >
        <ConversationStreamProvider
          sessionId={conversationSessionId}
          overrideEvents={conversationOverrideEvents}
        >
          {(activeRunnerSessionId) => (
            <div
              ref={rootRef}
              data-chat-view-root
              data-session-id={dataSessionId}
              className="relative flex h-full max-w-full min-w-0 flex-col overflow-hidden"
            >
              {children(activeRunnerSessionId)}
            </div>
          )}
        </ConversationStreamProvider>
      </Org2ConversationSenderMetadataProvider>
    </SessionCommentsProvider>
  );
});

ChatViewLiveRegion.displayName = "ChatViewLiveRegion";
