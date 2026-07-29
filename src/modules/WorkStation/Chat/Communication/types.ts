/**
 * Communication Types
 *
 * Types for the Communication simulator app.
 * Shows chat, thinking, interaction, and todo events.
 *
 * Event categorization is driven by Rust AppSubtool (single source of truth):
 * - "message"            → Messages timeline
 * - "thinking"           → Messages timeline
 * - "todo"               → Todo tab and Messages timeline
 * - "other_interactions" → interactions tab (ask_user, approval,
 *                          mode-switch)
 *
 * No hardcoded event category arrays — Rust alias_map owns the mapping.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { SimulatorAppBaseState } from "@src/engines/Simulator/apps/core/types";

// ============================================
// Message Types
// ============================================

export type MessageViewMode =
  | "chat"
  | "think"
  | "todo"
  | "interaction"
  | "preview";

/**
 * Mirrors the `unloadedTurn` payload the Rust import projectors (Codex app,
 * imported-history, Cursor IDE) stamp onto a placeholder chunk when a turn's
 * body was windowed out of the initial load (see PR #561). Presence of this
 * field means `content` is the raw "turn is not loaded yet" placeholder text
 * and must never be rendered verbatim — see `UnloadedTurnBubble`.
 */
export interface CommunicationUnloadedTurnMeta {
  turnId: string;
  nextTurnId?: string | null;
  bodyEventCount?: number;
}

export interface MessageEntry {
  /** Event ID (for selection and jumping) */
  eventId: string;
  /** Original event */
  event: SessionEvent;
  /** Message type (chat or think or todo or interaction) */
  type: MessageViewMode;
  /** Message content */
  content: string;
  /** Who sent it (agent or user) */
  sender: "agent" | "user";
  /** Timestamp */
  timestamp: string;
  /** Monotonic order in the original event stream, used when timestamps tie. */
  order: number;
  /** Whether this is the current event in replay */
  isCurrent: boolean;
  /**
   * Set when this entry is a lazy-load placeholder for a turn whose body
   * hasn't been fetched yet. `content` holds the backend's raw placeholder
   * observation text in this case, not real turn content. Optional (rather
   * than nullable-required) so existing test fixtures that build a
   * `MessageEntry` literal by hand don't all need updating — every real
   * construction path goes through `convertToMessageEntry`, which always
   * sets it.
   */
  unloadedTurn?: CommunicationUnloadedTurnMeta | null;
}

// ============================================
// App State
// ============================================

export interface SimulatorMessagesState extends SimulatorAppBaseState {
  /** All chat messages up to current replay point */
  chatMessages: MessageEntry[];
  /** All thinking messages up to current replay point */
  thinkMessages: MessageEntry[];
  /** All todo lists up to current replay point */
  todoMessages: MessageEntry[];
  /**
   * Interactive agent ↔ user widgets (AppSubtool::OtherInteractions):
   * ask_user_questions, ask_user_permissions, suggest_mode_switch.
   * Rendered in their own tab and also included in
   * the aggregate Messages timeline.
   */
  interactionMessages: MessageEntry[];
  /** Currently selected message (for detail view) */
  selectedMessage: MessageEntry | null;
  /** Current view mode */
  viewMode: MessageViewMode;
}
