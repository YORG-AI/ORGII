/**
 * Event Visibility Filters
 *
 * Chat-panel visibility only. Simulator/Messages visibility is computed
 * exclusively in Rust (`event_pipeline/derived.rs`) — the frontend consumes
 * the pre-filtered `sortedSimulatorEvents` / `messagesEvents` arrays from
 * Rust snapshots instead of re-filtering.
 *
 * `isVisibleInChat` keeps a TS twin for synchronous Jotai paths; parity with
 * the Rust implementation is enforced by the shared fixture in
 * `src-tauri/src/agent_sessions/event_pipeline/fixtures/visibility_parity.json`
 * (see `__tests__/visibilityParity.test.ts`).
 */
import type { SessionEvent } from "../core/types";

// ============================================
// Visibility Filters
// ============================================

/**
 * Check if an event should be shown in chat panel.
 * Filters out empty thinking events and other non-chat events.
 */
export function isVisibleInChat(event: SessionEvent): boolean {
  // NOTE: thinking deltas (isDelta=true, variant="thinking") are now allowed
  // through so the chat panel can show a live streaming cursor while the
  // model reasons. Empty thinking deltas are still caught by the
  // has_thinking_content guard below.

  // Hide session start/end from chat
  if (event.displayVariant === "session") {
    return false;
  }

  // Hide task lifecycle and stage errors from chat (no UI components).
  // Mirrors Rust is_visible_in_chat() in derived.rs.
  if (
    event.actionType === "task_start" ||
    event.actionType === "task_completed" ||
    event.actionType === "task_failed" ||
    event.actionType === "stage_error"
  ) {
    return false;
  }

  // Hide standalone tool_result events — they should be merged into their
  // parent tool_call. If one slips through (e.g. missing callId), hide it
  // to avoid duplicate display.
  if (event.actionType === "tool_result") {
    return false;
  }

  // Hide empty thinking events (end markers with no content)
  if (event.displayVariant === "thinking") {
    const result = event.result || {};
    const hasContent = Boolean(
      (result.thought as string)?.trim() ||
      (result.content as string)?.trim() ||
      (result.observation as string)?.trim()
    );
    if (!hasContent) {
      return false;
    }
  }

  // Hide whitespace-only assistant/message events (e.g. "\n\n" content)
  if (event.displayVariant === "message" && event.actionType === "assistant") {
    const result = event.result || {};
    const content =
      (result.content as string) ||
      (result.observation as string) ||
      event.displayText ||
      "";
    if (!content.trim()) {
      return false;
    }
  }

  return true;
}
