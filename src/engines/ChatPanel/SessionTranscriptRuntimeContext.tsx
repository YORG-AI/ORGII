import { createContext, useContext } from "react";

import type { SessionLoadStatus } from "@src/engines/SessionCore";

/**
 * Platform capabilities and state consumed by the shared transcript surface.
 *
 * Desktop does not provide this context and keeps using the existing Jotai /
 * EventStore path. Browser and other remote surfaces provide it so the same
 * ChatHistory tree can render without pretending that local Tauri services
 * exist.
 */
export interface SessionTranscriptRuntime {
  loadStatus: SessionLoadStatus;
  loadError: string | null;
  isAgentWorking: boolean;
  isExploring?: boolean;
  onReload: () => void;
  /** Remote surfaces wire chat block locate to their replay controller. */
  onNavigateToEvent?: (eventId: string) => void;
  onReplyQuestion?: (input: { reply: string; chunk_id: string }) => void;
  onIgnoreQuestion?: (eventId: string) => void;
  capabilities?: {
    canvasInline?: boolean;
    turnMetadata?: boolean;
  };
}

const SessionTranscriptRuntimeContext =
  createContext<SessionTranscriptRuntime | null>(null);

export const SessionTranscriptRuntimeProvider =
  SessionTranscriptRuntimeContext.Provider;

export function useSessionTranscriptRuntime(): SessionTranscriptRuntime | null {
  return useContext(SessionTranscriptRuntimeContext);
}
