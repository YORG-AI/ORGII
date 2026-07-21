/**
 * Stream Finalization Helpers
 *
 * Helper functions for finalizing streaming content and common event accessors.
 */
import type { StreamRefs } from "../../shared/types";
import type { AgentWSEvent } from "../../shared/types";
import type { EventHandlerContext } from "./types";

const STOPPED_TURNS_PER_SESSION_LIMIT = 20;

const stoppedStreamingSessions = new Set<string>();
const activeStreamingTurnBySession = new Map<string, string>();
const stoppedStreamingTurnsBySession = new Map<string, Set<string>>();

function resetStreamRefs(refs: StreamRefs): void {
  refs.contentRef.current = "";
  refs.idRef.current = "";
}

function stoppedTurnSetForSession(sessionId: string): Set<string> {
  let stoppedTurns = stoppedStreamingTurnsBySession.get(sessionId);
  if (!stoppedTurns) {
    stoppedTurns = new Set<string>();
    stoppedStreamingTurnsBySession.set(sessionId, stoppedTurns);
  }
  return stoppedTurns;
}

export function noteSessionStreamingTurn(
  sessionId: string,
  turnId: string | undefined
): void {
  if (!turnId) return;
  if (stoppedStreamingSessions.has(sessionId)) {
    stoppedTurnSetForSession(sessionId).add(turnId);
    return;
  }
  if (isSessionStreamingStopped(sessionId, turnId)) return;
  activeStreamingTurnBySession.set(sessionId, turnId);
}

export function getActiveSessionStreamingTurn(
  sessionId: string
): string | undefined {
  return activeStreamingTurnBySession.get(sessionId);
}

export function markSessionStreamingStopped(sessionId: string): void {
  const activeTurnId = activeStreamingTurnBySession.get(sessionId);
  if (!activeTurnId) {
    stoppedStreamingSessions.add(sessionId);
    return;
  }

  const stoppedTurns = stoppedTurnSetForSession(sessionId);
  stoppedTurns.add(activeTurnId);
  while (stoppedTurns.size > STOPPED_TURNS_PER_SESSION_LIMIT) {
    const oldestTurnId = stoppedTurns.values().next().value;
    if (!oldestTurnId) break;
    stoppedTurns.delete(oldestTurnId);
  }
}

export function clearSessionStreamingStopped(sessionId: string): void {
  stoppedStreamingSessions.delete(sessionId);
  activeStreamingTurnBySession.delete(sessionId);
}

export function isSessionStreamingStopped(
  sessionId: string,
  turnId?: string
): boolean {
  if (turnId && stoppedStreamingTurnsBySession.get(sessionId)?.has(turnId)) {
    return true;
  }
  return stoppedStreamingSessions.has(sessionId);
}

/**
 * Reset all streaming state in context.
 * Used by handleComplete and handleError to avoid code duplication.
 */
export function resetAllStreamingState(ctx: EventHandlerContext): void {
  if (ctx.assistantStreamRef) resetStreamRefs(ctx.assistantStreamRef.current);
  if (ctx.thinkingStreamRef) resetStreamRefs(ctx.thinkingStreamRef.current);
  if (ctx.toolCallDeltaBuffersRef) ctx.toolCallDeltaBuffersRef.current.clear();
  clearStreamingInfo(ctx);
  if (ctx.streamingCompleteHandledRef) {
    ctx.streamingCompleteHandledRef.current = false;
  }
}

export function getToolCallId(event: AgentWSEvent): string | undefined {
  return event.toolCallId;
}

export function getToolName(event: AgentWSEvent): string {
  return event.tool || event.toolName || "unknown";
}

export function getEventSessionId(event: AgentWSEvent): string | undefined {
  return event.sessionId;
}

/**
 * Clear streamingInfoRef to idle state.
 */
export function clearStreamingInfo(ctx: EventHandlerContext): void {
  if (ctx.streamingInfoRef) {
    ctx.streamingInfoRef.current = {
      isStreaming: false,
      isThinking: false,
      content: "",
    };
    ctx.onStreamingDeltaRef?.current?.(ctx.streamingInfoRef.current);
  }
}

/**
 * Clear message streaming refs.
 */
export function clearMessageStreamRefs(ctx: EventHandlerContext): void {
  if (ctx.assistantStreamRef) {
    ctx.assistantStreamRef.current.contentRef.current = "";
    ctx.assistantStreamRef.current.idRef.current = "";
  }
  clearStreamingInfo(ctx);
}

/**
 * Clear thinking streaming refs.
 */
export function clearThinkingStreamRefs(ctx: EventHandlerContext): void {
  if (ctx.thinkingStreamRef) {
    ctx.thinkingStreamRef.current.contentRef.current = "";
    ctx.thinkingStreamRef.current.idRef.current = "";
  }
  clearStreamingInfo(ctx);
}

/**
 * Update streamingInfoRef with current streaming state.
 */
export function updateStreamingInfo(
  ctx: EventHandlerContext,
  isStreaming: boolean,
  isThinking: boolean,
  content: string
): void {
  if (ctx.streamingInfoRef) {
    ctx.streamingInfoRef.current = { isStreaming, isThinking, content };
    ctx.onStreamingDeltaRef?.current?.(ctx.streamingInfoRef.current);
  }
}
