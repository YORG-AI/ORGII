/**
 * SessionEvent Factories
 *
 * Pure functions that construct SessionEvent objects for every event type
 * emitted by agent adapters. New adapters compose these instead of
 * duplicating shape logic.
 */
import { isInteractiveTool } from "@src/engines/SessionCore/core/interactiveTools";
import type {
  EventDisplayStatus,
  SessionEvent,
} from "@src/engines/SessionCore/core/types";
import { ID_PREFIX } from "@src/engines/SessionCore/sync/utils/activityIds";
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";

import { stripThinkTags } from "./streamingParsers";

export function makeAssistantEvent(
  id: string,
  sessionId: string,
  content: string,
  streaming: boolean
): SessionEvent {
  const cleaned = stripThinkTags(content);
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "assistant_message",
    uiCanonical: "",
    actionType: "assistant",
    args: {},
    result: { observation: cleaned },
    source: "assistant",
    displayText: cleaned,
    displayStatus: streaming ? "running" : "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: streaming,
  };
}

export function makeThinkingEvent(
  id: string,
  sessionId: string,
  content: string,
  streaming: boolean
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "thinking",
    uiCanonical: "",
    actionType: streaming ? "llm_thinking_delta" : "llm_thinking",
    args: {},
    result: { observation: content },
    source: "assistant",
    displayText: content,
    displayStatus: streaming ? "running" : "completed",
    displayVariant: "thinking",
    activityStatus: "agent",
    isDelta: streaming,
  };
}

export function makeToolCallEvent(
  id: string,
  sessionId: string,
  toolName: string | undefined,
  toolCallId: string | undefined,
  args: Record<string, unknown>,
  streaming = false
): SessionEvent {
  const resolvedToolName = toolName || "tool_call";
  // Interactive tools (e.g. ask_user_questions) block the agent turn
  // awaiting user input and must use the `awaiting_user` phase. Otherwise
  // generic `completeLastRunning()` calls triggered by `agent:complete`
  // for the surrounding turn will flip them to `completed` and dismiss
  // the UI card before the user has had a chance to answer.
  const initialStatus: EventDisplayStatus = isInteractiveTool(resolvedToolName)
    ? "awaiting_user"
    : "running";
  const filePath =
    typeof args.file_path === "string"
      ? args.file_path
      : typeof args.path === "string"
        ? args.path
        : typeof args.target_file === "string"
          ? args.target_file
          : undefined;

  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: resolvedToolName,
    // Resolve alias (e.g. "task" → "subagent") so the component registry
    // can find the correct renderer immediately, even before Rust pushes
    // an updated snapshot with the canonical uiCanonical field.
    uiCanonical: normalizeFunctionName(resolvedToolName),
    actionType: "tool_call",
    args,
    result: {},
    source: "assistant",
    displayText: `Calling ${resolvedToolName}...`,
    displayStatus: initialStatus,
    displayVariant: "tool_call",
    activityStatus: "agent",
    callId: toolCallId,
    filePath,
    isDelta: streaming,
  };
}

/**
 * Build a tool_result SessionEvent keyed by `tool_call_id`.
 *
 * `toolCallId` is REQUIRED by contract: every `agent:tool_result` event
 * from Rust ships with a non-empty `call_id`. Callers MUST guard the
 * upstream event against a missing id and take a different fallback
 * path (e.g. `completeLastRunning()`) — do NOT synthesize ids here.
 *
 * Synthesizing an id at this boundary broke the `plan_ready_for_approval`
 * → Build-button pipeline, because `merge_events` pairs tool_result ↔
 * tool_call by `callId`; a synthetic wall-clock id matches nothing and
 * leaks a zombie event into the store.
 */
export function makeToolResultEvent(
  sessionId: string,
  toolName: string | undefined,
  toolCallId: string,
  resultContent: string
): SessionEvent {
  const id = `tool-result-${toolCallId}`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: toolName || "tool_call",
    uiCanonical: "",
    actionType: "tool_result",
    args: {},
    result: { content: resultContent, observation: resultContent },
    source: "assistant",
    displayText: resultContent,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    callId: toolCallId,
  };
}

export function makeSummaryEvent(
  sessionId: string,
  summary: string,
  toolCalls: number | undefined,
  wallTimeSecs: number | undefined,
  options: { turnId: string; createdAt: string }
): SessionEvent {
  const id = `summary-${options.turnId}`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: options.createdAt,
    functionName: "turn_summary",
    uiCanonical: "turn_summary",
    actionType: "assistant",
    args: {
      ...(options.turnId !== undefined && { turnId: options.turnId }),
      ...(toolCalls !== undefined && { toolCalls }),
      ...(wallTimeSecs !== undefined && { wallTimeSecs }),
    },
    result: { observation: summary },
    source: "assistant",
    displayText: summary,
    displayStatus: "completed",
    displayVariant: "summary",
    activityStatus: "processed",
  };
}

/**
 * Options for creating an error event.
 * Matches the structured error payload from Rust StreamingError.
 */
export interface ErrorEventOptions {
  /** Human-readable error message. */
  error: string;
  /** Error code for programmatic handling. */
  errorCode?: string;
  /** Whether this error is retryable. */
  isRetryable?: boolean;
  /** Additional error details. */
  details?: { retryAfterSecs?: number; toolName?: string; filePath?: string };
}

export function makeErrorEvent(
  sessionId: string,
  errorOrOptions: string | ErrorEventOptions,
  fixedId?: string
): SessionEvent {
  const id = fixedId ?? `error-${Date.now()}`;
  const isStructured = typeof errorOrOptions === "object";
  const errorMessage = isStructured ? errorOrOptions.error : errorOrOptions;
  const errorCode = isStructured ? errorOrOptions.errorCode : undefined;
  const isRetryable = isStructured ? errorOrOptions.isRetryable : false;
  const details = isStructured ? errorOrOptions.details : undefined;

  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "system",
    uiCanonical: "",
    actionType: "assistant",
    args: {
      ...(errorCode && { errorCode }),
      ...(isRetryable && { isRetryable }),
      ...(details && { details }),
    },
    result: { observation: `Error: ${errorMessage}` },
    source: "assistant",
    displayText: `Error: ${errorMessage}`,
    displayStatus: "failed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

export function makeRateLimitHintEvent(sessionId: string): SessionEvent {
  const id = `rate-limit-hint-${Date.now()}`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: new Date().toISOString(),
    functionName: "system",
    uiCanonical: "rate_limit_hint",
    // NOT "assistant": this is a system info card, not assistant prose.
    // Marking it assistant made both the chat filter (willEventRenderContent)
    // and ActivityRouter treat it as an agent message — the filter then
    // required a text body and the router rendered the raw observation string
    // ("rate_limit_hint") as a chat bubble. A neutral actionType routes it
    // through the dedicated RateLimitHintEvent renderer via its uiCanonical.
    actionType: "system",
    args: {},
    // Empty on purpose: the dedicated renderer supplies its own i18n copy.
    result: {},
    source: "system",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

/**
 * Mint a canonical user-intent id at a submit boundary. One id per
 * "user wants the agent to take a turn now" — reuse the SAME id for the
 * optimistic synthetic event, the queue row, and the wire dispatch so
 * the turn indexer can collapse them under one logical round.
 */
export function mintTurnIntentId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tii-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

export function createSyntheticUserEvent(
  sessionId: string,
  content: string,
  options?: {
    createdAt?: string;
    imageDataUrls?: string[];
    /**
     * Canonical user-intent id. Threaded all the way through the queue,
     * the wire layer, and the persisted user_message event so the turn
     * indexer can collapse the synthetic row with the backend row that
     * shares the same id (instead of relying on content-equality and
     * timestamp ordering, which fails after Stop + model switch +
     * Send Now).
     */
    turnIntentId?: string;
  }
): SessionEvent {
  // Synthetic user placeholders are distinguished by their frontend-only
  // event shape, not by ID prefix. CLI backend user events can also use
  // user-input-* IDs, so consumers must use isSyntheticUserInputEvent().
  const id = `${ID_PREFIX.USER_INPUT}${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const images = options?.imageDataUrls;
  const turnIntentId = options?.turnIntentId;
  return {
    id,
    chunk_id: null,
    sessionId,
    createdAt: options?.createdAt || new Date().toISOString(),
    functionName: "user_message",
    uiCanonical: "",
    actionType: "raw",
    source: "user",
    args: {},
    result: {
      type: "user",
      message: { content, role: "user" },
      syntheticUserInput: true,
      ...(images && images.length > 0 ? { images } : {}),
      ...(turnIntentId ? { turnIntentId } : {}),
    },
    displayText: content,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}
