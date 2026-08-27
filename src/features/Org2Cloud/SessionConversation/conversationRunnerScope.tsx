/**
 * The live runner scope for a mounted conversation surface.
 *
 * A member's turn runs in an invisible one-shot local runner, so the mounted
 * imported session stays idle — its planning indicator and streaming-delta
 * footer never light up, and a long turn looks frozen (no "Thinking…", no
 * activity) until the tail lands. The conversation stream publishes the
 * in-flight runner's sessionId here; the chat footer reads it and scopes its
 * running/typing indicator to the runner instead of the idle mounted session.
 *
 * `null` when no member turn from this device is in flight (owner sessions,
 * ordinary sessions, or between turns) — the footer falls back to the mounted
 * session exactly as before.
 */
import { createContext, useContext } from "react";

const ConversationRunnerScopeContext = createContext<string | null>(null);

export const ConversationRunnerScopeProvider =
  ConversationRunnerScopeContext.Provider;

export function useConversationRunnerScope(): string | null {
  return useContext(ConversationRunnerScopeContext);
}
