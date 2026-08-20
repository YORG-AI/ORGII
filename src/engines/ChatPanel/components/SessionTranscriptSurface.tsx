import React from "react";

import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import { AgentMessageClampProvider } from "@src/engines/ChatPanel/blocks/AgentMessageBlock";
import type { SessionEvent } from "@src/engines/SessionCore";

import ChatHistory from "../ChatHistory";
import { ChatHistoryOverrideContext } from "../ChatHistoryOverrideContext";
import { ChatSessionContext } from "../ChatSessionContext";
import {
  type SessionTranscriptRuntime,
  SessionTranscriptRuntimeProvider,
} from "../SessionTranscriptRuntimeContext";

export interface SessionTranscriptSurfaceProps {
  sessionId: string;
  events: SessionEvent[];
  runtime: SessionTranscriptRuntime;
  className?: string;
  surfaceBgClass?: string;
  turnPaginationEnabled?: boolean;
}

/**
 * Shared, platform-neutral Session transcript shell.
 *
 * It deliberately accepts events and runtime actions as inputs. Desktop may
 * keep its current store-backed ChatView while Web supplies Cloud-backed
 * events; both render the canonical ChatHistory and event components.
 */
export function SessionTranscriptSurface({
  sessionId,
  events,
  runtime,
  className = "",
  surfaceBgClass = "bg-chat-pane",
  turnPaginationEnabled = true,
}: SessionTranscriptSurfaceProps) {
  return (
    <SessionTranscriptRuntimeProvider value={runtime}>
      <ChatProvider>
        <ChatSessionContext.Provider value={sessionId}>
          <ChatHistoryOverrideContext.Provider value={events}>
            <AgentMessageClampProvider value={false}>
              <div
                className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${surfaceBgClass} ${className}`}
              >
                <ChatHistory
                  surfaceBgClass={surfaceBgClass}
                  mutationActionsDisabled
                  turnPaginationEnabled={turnPaginationEnabled}
                  planningIndicatorScope={{ sessionId, isLive: false }}
                />
              </div>
            </AgentMessageClampProvider>
          </ChatHistoryOverrideContext.Provider>
        </ChatSessionContext.Provider>
      </ChatProvider>
    </SessionTranscriptRuntimeProvider>
  );
}
