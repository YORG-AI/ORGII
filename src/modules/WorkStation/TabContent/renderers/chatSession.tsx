/**
 * Renderer wrapper for `chat-session` tabs.
 *
 * `ChatView` is self-contained (reads from session atoms by id). The
 * editor host wraps it in a chat-gradient container and passes either
 * `readOnly` (editor) or `secondary` (project manager). For Phase 1b we
 * preserve the editor-flavoured `readOnly` shell since that is what the
 * shared chat-session factory produces; the project surface keeps its
 * own router until Phase 2 unifies the wrappers.
 */
import React, { memo } from "react";

import ChatView from "@src/engines/ChatPanel/ChatView";

import type { UnifiedTabContentProps } from "../types";

const ChatSessionTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const sessionId = String(tab.data.sessionId ?? "");
    if (!sessionId) return null;
    return (
      <div
        data-chat-panel
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden text-sm"
        style={{
          background:
            "linear-gradient(180deg, var(--color-bg-1) 0%, var(--color-fill-1) 100%)",
        }}
      >
        <ChatView
          sessionId={sessionId}
          readOnly
          initialMessageId={tab.data.initialMessageId as string | undefined}
        />
      </div>
    );
  }
);

ChatSessionTabRenderer.displayName = "ChatSessionTabRenderer";

export default ChatSessionTabRenderer;
