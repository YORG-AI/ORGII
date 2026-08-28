import { type ReactNode, memo } from "react";

import { SessionCommentsProvider } from "@src/features/Org2Cloud/SessionComments/SessionCommentsContext";
import type { Session } from "@src/store/session";

import { usePipelineChatEvents } from "./hooks/usePipelineChatEvents";

interface ChatViewLiveRegionProps {
  commentsSession: Session | null;
  turnAnchorsVisible: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  dataSessionId: string;
  transcript: ReactNode;
  composer: ReactNode;
}

/**
 * Owns the hot pipeline transcript subscription and cloud comment anchor
 * stream so the ChatView shell can stay on narrow composer/layout atoms.
 */
export const ChatViewLiveRegion = memo(function ChatViewLiveRegion({
  commentsSession,
  turnAnchorsVisible,
  rootRef,
  dataSessionId,
  transcript,
  composer,
}: ChatViewLiveRegionProps) {
  const { chatEvents, transcriptReady } = usePipelineChatEvents();

  return (
    <SessionCommentsProvider
      session={commentsSession}
      events={transcriptReady ? chatEvents : null}
      turnAnchorsVisible={turnAnchorsVisible}
    >
      <div
        ref={rootRef}
        data-chat-view-root
        data-session-id={dataSessionId}
        className="relative flex h-full min-w-0 max-w-full flex-col overflow-hidden"
      >
        {transcript}
        {composer}
      </div>
    </SessionCommentsProvider>
  );
});

ChatViewLiveRegion.displayName = "ChatViewLiveRegion";
