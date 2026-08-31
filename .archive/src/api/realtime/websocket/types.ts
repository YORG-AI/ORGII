// Re-export ActivityChunk from canonical source
// Note: session.ts has session_id?: optional, but WebSocket always provides it
import type { ActivityChunk } from "@src/types/session/session";

/**
 * WebSocket Types
 *
 * Protocol:
 *   1. Connect: ws://server/api/ws?session_id=xxx (auto-subscribed)
 *   2. Receive events for that session
 */

export type WSEventType =
  | "connected"
  | "disconnected"
  | "error"
  | "pong"
  | "session.status_changed"
  | "session.completed"
  | "session.failed"
  | "session.cancelled"
  | "agent.event"
  | "session.activity"
  | "session.question_asked"
  | "session.question_answered"
  | "session_paused_user" // Session paused for user input (from SDK)
  | "llm_usage" // Token usage event
  | "billing_pause" // Billing pause event
  | "files.changed";

export type WSClientMessageType = "ping";

export type { ActivityChunk };

export interface QuestionPayload {
  question_id: string;
  question_text: string;
  answer_kind?: string;
  options?: string[];
  rationale?: string;
  context?: Record<string, unknown>;
  created_at: string;
}

export interface WSBaseMessage {
  type: WSEventType;
  timestamp?: string;
}

export interface WSConnectedMessage extends WSBaseMessage {
  type: "connected";
  session_id: string;
}

export interface WSErrorMessage extends WSBaseMessage {
  type: "error";
  error_code: string;
  message: string;
}

export interface WSPongMessage {
  type: "pong";
}

export interface WSSessionStatusChangedMessage extends WSBaseMessage {
  type: "session.status_changed";
  session_id: string;
  status: string;
  previous_status: string;
}

export interface WSSessionCompletedMessage extends WSBaseMessage {
  type: "session.completed";
  session_id: string;
  completed_at: string;
}

export interface WSSessionFailedMessage extends WSBaseMessage {
  type: "session.failed";
  session_id: string;
  error_message?: string;
}

export interface WSSessionCancelledMessage extends WSBaseMessage {
  type: "session.cancelled";
  session_id: string;
}

export interface WSSessionActivityMessage extends WSBaseMessage {
  type: "session.activity";
  session_id: string;
  chunk: ActivityChunk;
}

// All unified event types from backend
export type AgentEventType =
  | "session_start"
  | "session_end"
  | "error"
  | "message"
  | "message_delta"
  | "thinking"
  | "thinking_delta"
  | "tool_call_start"
  | "tool_call_update"
  | "tool_call_end"
  | "plan_update"
  | "ask_user_permissions"
  | "approval_response";

/**
 * Streaming agent types (short names for real-time events).
 * Different from credential ModelType (cursor_cli, claude_code, etc.)
 */
export type StreamingAgentType =
  | "claude"
  | "amp"
  | "cursor"
  | "codex"
  | "acp"
  | "droid"
  | "copilot"
  | "unknown";

export type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "execute"
  | "search"
  | "web_search"
  | "web_fetch"
  | "mcp"
  | "subagent"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface MessagePayload {
  role: "user" | "assistant";
  content: string;
  is_delta: boolean;
}

export interface ThinkingPayload {
  content: string;
  is_delta: boolean;
}

export interface FileDiff {
  path: string;
  old_text: string | null;
  new_text: string;
}

export interface ToolCallPayload {
  call_id: string;
  tool_kind: ToolKind;
  tool_name: string;
  status: ToolCallStatus;
  title?: string | null;
  input: Record<string, unknown> | null;
  output: unknown | null;
  is_error: boolean;
  file_path: string | null;
  diff?: FileDiff | null;
  command: string | null;
  exit_code?: number | null;
}

// Plan related payloads
export interface PlanEntry {
  id?: string | null;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string | null;
}

export interface PlanUpdatePayload {
  entries: PlanEntry[];
}

// Approval related payloads
export interface ApprovalRequestPayload {
  call_id: string;
  tool_kind: ToolKind;
  tool_name: string;
  reason?: string | null;
  risk_level?: string | null;
}

export interface ApprovalResponsePayload {
  call_id: string;
  approved: boolean;
}

// Session lifecycle payloads
export interface SessionStartPayload {
  model?: string | null;
  cwd?: string | null;
  tools?: string[] | null;
}

export interface SessionEndPayload {
  success: boolean;
  duration_ms?: number | null;
  num_turns?: number | null;
  error_message?: string | null;
}

export interface ErrorPayload {
  message: string;
  code?: string | null;
  details?: Record<string, unknown> | null;
}

// Union type for all payloads
export type AgentEventPayload =
  | MessagePayload
  | ThinkingPayload
  | ToolCallPayload
  | PlanUpdatePayload
  | ApprovalRequestPayload
  | ApprovalResponsePayload
  | SessionStartPayload
  | SessionEndPayload
  | ErrorPayload;

export interface WSAgentEventMessage extends WSBaseMessage {
  type: "agent.event";
  session_id: string;
  chunk_id: string;
  event_type: AgentEventType;
  agent_type: StreamingAgentType;
  payload: AgentEventPayload;
}

export interface WSSessionQuestionAskedMessage extends WSBaseMessage {
  type: "session.question_asked";
  session_id: string;
  question: QuestionPayload;
}

export interface WSSessionQuestionAnsweredMessage extends WSBaseMessage {
  type: "session.question_answered";
  session_id: string;
  question_id: string;
  answered_at: string;
}

/**
 * File change notification from cloud workspace
 */
export interface FileChangePayload {
  path: string;
  action: "created" | "modified" | "deleted";
  size?: number;
  /** Last modification time (ISO 8601 UTC) - for mtime-aware sync */
  mtime?: string;
}

export interface WSFilesChangedMessage extends WSBaseMessage {
  type: "files.changed";
  session_id: string;
  changes: FileChangePayload[];
  /** Event timestamp (ISO 8601 UTC) - for out-of-order event handling */
  timestamp?: string;
  /** WS-5 fix: UUID for grouping chunks (null if not chunked) */
  batch_id?: string | null;
  /** WS-5 fix: 0-based index of this chunk (null if not chunked) */
  chunk_index?: number | null;
  /** WS-5 fix: Total number of chunks in batch (null if not chunked) */
  total_chunks?: number | null;
}

// ============================================
// Standard Session Events (from SDK)
// ============================================

/**
 * Session paused for user input (questions or approval)
 */
export interface WSSessionPausedUserMessage extends WSBaseMessage {
  type: "session_paused_user";
  session_id: string;
  status: "paused_user";
  question_ids?: string[];
  pending_questions?: Array<{
    question_id: string;
    question_text: string;
    answer_kind?: string;
    options?: string[];
  }>;
}

/**
 * LLM token usage event for billing
 */
export interface WSLLMUsageMessage extends WSBaseMessage {
  type: "llm_usage";
  session_id: string;
  job_id?: string;
  listing_id?: string;
  data: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    billing?: {
      cost_cents: number;
      balance_cents: number;
      session_cost_cents: number;
    };
  };
}

/**
 * Billing pause event (budget exhausted or provider error)
 */
export interface WSBillingPauseMessage extends WSBaseMessage {
  type: "billing_pause";
  session_id: string;
  job_id?: string;
  listing_id?: string;
  data: {
    reason:
      | "budget_exhausted"
      | "insufficient_balance"
      | "provider_error"
      | "billing_error";
    balance_cents: number;
    session_cost_cents: number;
  };
}

export type WSMessage =
  | WSConnectedMessage
  | WSErrorMessage
  | WSPongMessage
  | WSSessionStatusChangedMessage
  | WSSessionCompletedMessage
  | WSSessionFailedMessage
  | WSSessionCancelledMessage
  | WSSessionActivityMessage
  | WSAgentEventMessage
  | WSSessionQuestionAskedMessage
  | WSSessionQuestionAnsweredMessage
  | WSSessionPausedUserMessage
  | WSLLMUsageMessage
  | WSBillingPauseMessage
  | WSFilesChangedMessage;

export function isAgentEventMessage(
  msg: WSMessage
): msg is WSAgentEventMessage {
  return msg.type === "agent.event";
}

export function isMessagePayload(
  payload: AgentEventPayload
): payload is MessagePayload {
  return "content" in payload && "role" in payload;
}

export function isThinkingPayload(
  payload: AgentEventPayload
): payload is ThinkingPayload {
  return "content" in payload && "is_delta" in payload && !("role" in payload);
}

export function isToolCallPayload(
  payload: AgentEventPayload
): payload is ToolCallPayload {
  return "tool_kind" in payload && "call_id" in payload;
}

export function isPlanUpdatePayload(
  payload: AgentEventPayload
): payload is PlanUpdatePayload {
  return (
    "entries" in payload &&
    Array.isArray((payload as PlanUpdatePayload).entries)
  );
}

export function isApprovalRequestPayload(
  payload: AgentEventPayload
): payload is ApprovalRequestPayload {
  return "call_id" in payload && "tool_kind" in payload && "reason" in payload;
}

export function isApprovalResponsePayload(
  payload: AgentEventPayload
): payload is ApprovalResponsePayload {
  return "call_id" in payload && "approved" in payload;
}

export function isSessionStartPayload(
  payload: AgentEventPayload
): payload is SessionStartPayload {
  return "model" in payload || "cwd" in payload || "tools" in payload;
}

export function isSessionEndPayload(
  payload: AgentEventPayload
): payload is SessionEndPayload {
  return (
    "success" in payload && ("duration_ms" in payload || "num_turns" in payload)
  );
}

export function isErrorPayload(
  payload: AgentEventPayload
): payload is ErrorPayload {
  return (
    "message" in payload && !("role" in payload) && !("is_delta" in payload)
  );
}

export function isFilesChangedMessage(
  msg: WSMessage
): msg is WSFilesChangedMessage {
  return msg.type === "files.changed";
}

export interface WSPingMessage {
  type: "ping";
}

export type WSClientMessage = WSPingMessage;
