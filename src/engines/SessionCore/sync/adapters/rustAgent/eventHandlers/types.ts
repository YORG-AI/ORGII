/**
 * Event Handler Types
 *
 * Shared types for Rust agent event handling.
 */
import type { createStore } from "jotai";
import type { MutableRefObject } from "react";

import type {
  AgentContextUsageSnapshot,
  AgentTokenUsage,
  PermissionRequestEvent,
  QuestionRequestEvent,
  StreamRefs,
  StreamingInfo,
  ToolCallDeltaBuffer,
} from "../../shared/types";

// ============================================================================
// Feature flags
// ============================================================================

/**
 * Feature flags for Rust agent event handlers.
 */
export interface RustAgentFeatures {
  hasCodingSessionBridge?: boolean;
  hasToolCallDelta?: boolean;
  hasPermissionRequest?: boolean;
  hasFileChangeEvents?: boolean;
  hasStreamingDelta?: boolean;
}

// ============================================================================
// Context
// ============================================================================

/** Unified mutable refs shared across all event handlers. */
export interface EventHandlerContext {
  filterSessionIdRef: MutableRefObject<string | undefined>;

  assistantStreamRef?: MutableRefObject<StreamRefs>;
  thinkingStreamRef?: MutableRefObject<StreamRefs>;

  toolCallDeltaBuffersRef?: MutableRefObject<Map<number, ToolCallDeltaBuffer>>;

  execOutputBufferRef: MutableRefObject<string>;

  // Coding session bridge
  trackedCodingSessionsRef?: MutableRefObject<Map<string, string>>;

  // Streaming info
  streamingInfoRef?: MutableRefObject<StreamingInfo>;

  streamingCompleteHandledRef?: MutableRefObject<boolean>;

  // Callbacks
  onAgentCompleteRef: MutableRefObject<
    ((tokenUsage?: AgentTokenUsage) => void) | undefined
  >;
  onContextUsageRef: MutableRefObject<
    ((contextUsage: AgentContextUsageSnapshot) => void) | undefined
  >;
  onTokenUpdateRef: MutableRefObject<((tokens: number) => void) | undefined>;
  onStatusChangeRef: MutableRefObject<
    | ((
        status: string,
        errorMessage?: string,
        meta?: { turnId?: string; turnStatus?: string; intermediate?: boolean }
      ) => void)
    | undefined
  >;
  onPermissionRequestRef?: MutableRefObject<
    ((event: PermissionRequestEvent) => void) | undefined
  >;
  onQuestionRequestRef: MutableRefObject<
    ((event: QuestionRequestEvent) => void) | undefined
  >;
  onStreamingDeltaRef?: MutableRefObject<
    ((info: StreamingInfo) => void) | undefined
  >;
  setStreaming: (value: boolean) => void;

  features: RustAgentFeatures;

  getDefaultStore: () => ReturnType<typeof createStore> | null;
}

// ============================================================================
// Callback interfaces for factory
// ============================================================================

export interface EventHandlerCallbacksInternal {
  onAgentComplete?: (tokenUsage?: AgentTokenUsage) => void;
  onContextUsage?: (contextUsage: AgentContextUsageSnapshot) => void;
  onTokenUpdate?: (tokens: number) => void;
  onStatusChange?: (status: string, errorMessage?: string) => void;
  onPermissionRequest?: (event: PermissionRequestEvent) => void;
  onQuestionRequest?: (event: QuestionRequestEvent) => void;
  onStreamingDelta?: (info: StreamingInfo) => void;
  setStreaming: (value: boolean) => void;
}

// ============================================================================
// Constants
// ============================================================================

export const MAX_EXEC_BUFFER = 500_000;
export const MAX_REASONING_LENGTH = 50_000;
