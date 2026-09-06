/**
 * SimulatorMessages Utilities
 *
 * Helper functions for processing message events.
 *
 * ALL event type detection delegates to Rust AppSubtool via getAppSubtool().
 * Same pattern as CODE_EDITOR's file_read/shell/search routing — no hardcoded
 * event category arrays, no suffix stripping.
 */
import { ASK_QUESTION_FUNCTIONS } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/askQuestionFunctionNames";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getAppSubtool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";

import type {
  CommunicationUnloadedTurnMeta,
  MessageEntry,
  MessageViewMode,
} from "./types";

// ============================================
// Event Type Checking (all delegate to Rust)
// ============================================

export function isAgentOrgInboxTranscriptEvent(event: SessionEvent): boolean {
  return Boolean(
    event.args?.agentOrgInboxTranscript === true ||
    event.result?.agentOrgInboxTranscript === true
  );
}

/** Rust AppSubtool: subtool === "message" means chat/conversation */
export function isChatEvent(eventFunction: string): boolean {
  return getAppSubtool(eventFunction) === "message";
}

/** Rust AppSubtool: subtool === "thinking" */
export function isThinkEvent(eventFunction: string): boolean {
  return getAppSubtool(eventFunction) === "thinking";
}

/** Rust AppSubtool: subtool === "todo" */
export function isTodoEvent(eventFunction: string): boolean {
  return getAppSubtool(eventFunction) === "todo";
}

// ============================================
// Message Extraction
// ============================================

/**
 * Extract message content from event.
 * Returns empty string if no content found (don't use function name as fallback).
 */
export function extractMessageContent(event: SessionEvent): string {
  // Try args.message or args.content first
  const args = event.args;
  if (args?.message && typeof args.message === "string") {
    return args.message;
  }
  if (args?.content && typeof args.content === "string") {
    return args.content;
  }
  if (args?.prompt && typeof args.prompt === "string") {
    return args.prompt;
  }
  if (args?.question && typeof args.question === "string") {
    return args.question;
  }

  // Try result.message or result.content
  const result = event.result as Record<string, unknown> | undefined;

  // Handle raw_event format: result.message.content (string or array)
  const resultMessage = result?.message as
    | {
        content?: string | Array<{ type?: string; text?: string }>;
        role?: string;
      }
    | undefined;
  if (resultMessage?.content) {
    // Rust backend: result.message.content is a plain string
    if (typeof resultMessage.content === "string") {
      return resultMessage.content;
    }
    // Python/hosted-service backend: result.message.content is [{type:"text", text:"..."}]
    if (Array.isArray(resultMessage.content)) {
      const textContent = resultMessage.content.find(
        (c: { type?: string; text?: string }) => c.type === "text"
      );
      if (textContent?.text) {
        return textContent.text;
      }
    }
  }

  if (result?.message && typeof result.message === "string") {
    return result.message;
  }
  if (result?.content && typeof result.content === "string") {
    return result.content;
  }
  if (result?.response && typeof result.response === "string") {
    return result.response;
  }
  // For assistant events, check observation (common field)
  if (result?.observation && typeof result.observation === "string") {
    return result.observation;
  }
  // For thinking events, check thought field
  if (result?.thought && typeof result.thought === "string") {
    return result.thought;
  }

  // Check for agent response in various formats
  if (result?.agent_response && typeof result.agent_response === "string") {
    return result.agent_response;
  }
  // Return empty string (let the UI show random messages for empty content)
  return "";
}

/**
 * Determine message sender (agent or user).
 */
export function getMessageSender(event: SessionEvent): "agent" | "user" {
  if (isAgentOrgInboxTranscriptEvent(event)) return "agent";

  const funcName = event.functionName?.toLowerCase() || "";

  // Rust `functionName` for user turns: "user_message" from
  // `builtin_tools.rs` / `eventBuilders.ts`, and "user" from
  // the ui_canonical registry.
  if (funcName === "user_message" || funcName === "user") {
    return "user";
  }

  // User response events
  if (funcName.includes("user_response") || funcName.includes("user_input")) {
    return "user";
  }

  // Raw events (user input in standard session)
  if (funcName === "raw_event" || funcName === "raw") {
    // Check if it's a user message by looking at result.type or result.message.role
    const result = event.result as Record<string, unknown> | undefined;
    const resultMessage = result?.message as { role?: string } | undefined;
    if (result?.type === "user" || resultMessage?.role === "user") {
      return "user";
    }
  }

  // Check event source
  if (event.source === "user") {
    return "user";
  }

  // Check result.role for assistant messages
  const result = event.result;
  if (result?.role === "user") {
    return "user";
  }

  // Agent events (ask_user, thinking, assistant, etc.)
  return "agent";
}

/**
 * Detect the `unloadedTurn` placeholder payload the Rust import projectors
 * (Codex app / imported-history / Cursor IDE) attach to a turn's stand-in
 * chunk when its body was windowed out of the initial load (PR #561).
 *
 * Mirrors `getUnloadedTurnMeta` in
 * `ChatHistory/hooks/useChatGroupsProjection.ts` (same wire shape, kept
 * independent here since this module reads `SessionEvent` directly rather
 * than `OptimizedChatItem`).
 */
export function getCommunicationUnloadedTurnMeta(
  event: SessionEvent
): CommunicationUnloadedTurnMeta | null {
  const result = event.result as Record<string, unknown> | undefined;
  const raw = result?.unloadedTurn;
  if (!raw || typeof raw !== "object") return null;

  const shared = raw as Record<string, unknown>;
  const turnId = shared.turnId;
  if (typeof turnId !== "string" || !turnId) return null;

  return {
    turnId,
    nextTurnId:
      typeof shared.nextTurnId === "string" ? shared.nextTurnId : null,
    bodyEventCount:
      typeof shared.bodyEventCount === "number"
        ? shared.bodyEventCount
        : undefined,
  };
}

/**
 * Convert event to MessageEntry.
 * Always returns a MessageEntry, even if content is empty.
 */
export function convertToMessageEntry(
  event: SessionEvent,
  type: MessageViewMode,
  isCurrent: boolean,
  order = 0
): MessageEntry {
  const content = extractMessageContent(event);

  return {
    eventId: event.id,
    event,
    type,
    content: content || "",
    sender: getMessageSender(event),
    timestamp: event.createdAt,
    order,
    isCurrent,
    unloadedTurn: getCommunicationUnloadedTurnMeta(event),
  };
}

// ============================================
// Ask-Question Detection & Extraction
// ============================================

export function isAskQuestionEvent(event: SessionEvent): boolean {
  const funcName = event.functionName?.toLowerCase() || "";
  return ASK_QUESTION_FUNCTIONS.has(funcName);
}

// ============================================
// Sidebar row preview
// ============================================

/** Truncate content for tree row display, stripping markdown/newlines. */
export function truncateContent(content: string, maxLength: number): string {
  if (!content) return "";
  const cleaned = content
    .replace(/\n+/g, " ")
    .replace(/#{1,6}\s/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength) + "…";
}
