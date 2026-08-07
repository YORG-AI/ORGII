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

import type { MessageEntry, MessageViewMode } from "./types";

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

/**
 * Rust AppSubtool: subtool === "other_interactions".
 * Covers ask_user_questions, ask_user_permissions, suggest_mode_switch —
 * interactive widgets that don't belong in the plain
 * chat transcript.
 */
export function isInteractionEvent(eventFunction: string): boolean {
  return getAppSubtool(eventFunction) === "other_interactions";
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
  };
}

// ============================================
// Ask-Question Detection & Extraction
// ============================================

export function isAskQuestionEvent(event: SessionEvent): boolean {
  const funcName = event.functionName?.toLowerCase() || "";
  return ASK_QUESTION_FUNCTIONS.has(funcName);
}

interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

interface SingleQuestion {
  text: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AnsweredPair {
  question: string;
  answers: string[];
}

export interface ExtractedQuestionData {
  questionId: string;
  sessionId: string;
  questions: SingleQuestion[];
  isAnswered: boolean;
  pairs: AnsweredPair[];
}

export function extractQuestionData(
  event: SessionEvent
): ExtractedQuestionData | null {
  const args = event.args as Record<string, unknown> | undefined;
  const result = event.result as Record<string, unknown> | undefined;

  const isAnswered =
    result?.success === true ||
    result?.status === "answered" ||
    result?.status === "responsed" ||
    event.displayStatus === "completed" ||
    result?.observation !== undefined;

  const questionId =
    (result?.call_id as string) || event.chunk_id || event.id || "";
  const sessionId = event.sessionId || "";

  const rawQuestions = args?.questions as
    | Array<Record<string, unknown>>
    | undefined;

  const resultAnswers =
    (result?.answers as string[][] | undefined) ||
    (args?.userAnswers as string[][] | undefined);
  const resultAnswer = result?.answer as string | undefined;

  if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
    const topLevelText =
      (args?.title as string) || (args?.prompt as string) || "";

    const questions: SingleQuestion[] = rawQuestions.map((sq) => {
      const text =
        (sq.question as string) ||
        (sq.prompt as string) ||
        (sq.header as string) ||
        (sq.title as string) ||
        (sq.text as string) ||
        (sq.content as string) ||
        "";
      const multiSelect =
        (sq.multiSelect as boolean) || (sq.allow_multiple as boolean) || false;

      const rawOpts = sq.options as
        | Array<Record<string, unknown> | string>
        | undefined;
      const options: QuestionOption[] = [];
      if (Array.isArray(rawOpts)) {
        rawOpts.forEach((opt, optIdx) => {
          if (typeof opt === "string") {
            options.push({ id: `opt_${optIdx}`, label: opt });
          } else if (opt && typeof opt === "object") {
            options.push({
              id: (opt.id as string) || `opt_${optIdx}`,
              label: (opt.label as string) || "",
              description: (opt.description as string) || undefined,
            });
          }
        });
      }

      return { text, options, multiSelect };
    });

    if (
      questions.every((q) => !q.text) &&
      topLevelText &&
      questions.length === 1
    ) {
      questions[0] = { ...questions[0], text: topLevelText };
    }

    const pairs: AnsweredPair[] = questions.map((sq, idx) => {
      let answers: string[] = [];
      if (Array.isArray(resultAnswers) && resultAnswers[idx]) {
        answers = resultAnswers[idx];
      } else if (idx === 0 && resultAnswer) {
        answers = [resultAnswer];
      }
      return { question: sq.text, answers };
    });

    return { questionId, sessionId, questions, isAnswered, pairs };
  }

  // Legacy single question format
  const questionData = result?.question as Record<string, unknown> | undefined;
  const legacyQuestion =
    (questionData?.question as string) ||
    (typeof result?.question === "string" ? result.question : "") ||
    (result?.content as string) ||
    (args?.question as string) ||
    (args?.prompt as string) ||
    "";

  if (!legacyQuestion) return null;

  const legacyAnswer = resultAnswer || (questionData?.answer as string) || "";

  const legacyOptions = (questionData?.options as string[]) || [];

  return {
    questionId,
    sessionId,
    questions: [
      {
        text: legacyQuestion,
        options: legacyOptions.map((opt, idx) => ({
          id: `opt_${idx}`,
          label: opt,
        })),
        multiSelect: false,
      },
    ],
    isAnswered,
    pairs: [
      { question: legacyQuestion, answers: legacyAnswer ? [legacyAnswer] : [] },
    ],
  };
}

// ============================================
// Message Filtering
// ============================================

/**
 * Get recent N messages from a list.
 * Returns the last N messages (most recent).
 */
export function getRecentMessages(
  messages: MessageEntry[],
  count: number = 3
): MessageEntry[] {
  return messages.slice(-count);
}

/**
 * Returns up to `count` messages from the end of `messages`, unless `focusedEventId`
 * matches an entry — then returns a contiguous window of `count` messages that
 * includes that entry (aligned so the focused row is visible in the capped view).
 * If `focusedEventId` is null, empty, or not found, behaves like {@link getRecentMessages}.
 */
export function getRecentMessagesWindow(
  messages: MessageEntry[],
  count: number,
  focusedEventId: string | null
): MessageEntry[] {
  if (messages.length <= count) {
    return messages;
  }
  if (focusedEventId == null || focusedEventId === "") {
    return messages.slice(-count);
  }
  const index = messages.findIndex((m) => m.eventId === focusedEventId);
  if (index === -1) {
    return messages.slice(-count);
  }
  const start = Math.max(0, Math.min(index, messages.length - count));
  return messages.slice(start, start + count);
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
