import { z } from "zod/v4";

import { JsonRecordFromAnySchema } from "@src/util/schemas/jsonRecord";

const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const ActivityChunkSchema = z.object({
  chunk_id: z.string(),
  session_id: z.string().optional(),
  action_type: z.string(),
  function: z.string(),
  args: UnknownRecordSchema,
  result: JsonRecordFromAnySchema,
  created_at: z.string(),
  thread_id: z.string().optional(),
  process_id: z.string().optional(),
});

export const QuestionPayloadSchema = z.object({
  question_id: z.string(),
  question_text: z.string(),
  answer_kind: z.string().optional(),
  options: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  context: UnknownRecordSchema.optional(),
  created_at: z.string(),
});

const MessagePayloadSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  is_delta: z.boolean(),
});

const ThinkingPayloadSchema = z.object({
  content: z.string(),
  is_delta: z.boolean(),
});

const FileDiffSchema = z.object({
  path: z.string(),
  old_text: z.string().nullable(),
  new_text: z.string(),
});

const ToolCallPayloadSchema = z.object({
  call_id: z.string(),
  tool_kind: z.enum([
    "read",
    "write",
    "edit",
    "delete",
    "execute",
    "search",
    "web_search",
    "web_fetch",
    "mcp",
    "subagent",
    "other",
  ]),
  tool_name: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  title: z.string().nullable().optional(),
  input: UnknownRecordSchema.nullable(),
  output: z.unknown().nullable(),
  is_error: z.boolean(),
  file_path: z.string().nullable(),
  diff: FileDiffSchema.nullable().optional(),
  command: z.string().nullable(),
  exit_code: z.number().int().nullable().optional(),
});

const PlanEntrySchema = z.object({
  id: z.string().nullable().optional(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.string().nullable().optional(),
});

const PlanUpdatePayloadSchema = z.object({
  entries: z.array(PlanEntrySchema),
});

const ApprovalRequestPayloadSchema = z.object({
  call_id: z.string(),
  tool_kind: z.enum([
    "read",
    "write",
    "edit",
    "delete",
    "execute",
    "search",
    "web_search",
    "web_fetch",
    "mcp",
    "subagent",
    "other",
  ]),
  tool_name: z.string(),
  reason: z.string().nullable().optional(),
  risk_level: z.string().nullable().optional(),
});

const ApprovalResponsePayloadSchema = z.object({
  call_id: z.string(),
  approved: z.boolean(),
});

const SessionStartPayloadSchema = z.object({
  model: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  tools: z.array(z.string()).nullable().optional(),
});

const SessionEndPayloadSchema = z.object({
  success: z.boolean(),
  duration_ms: z.number().nullable().optional(),
  num_turns: z.number().nullable().optional(),
  error_message: z.string().nullable().optional(),
});

const ErrorPayloadSchema = z.object({
  message: z.string(),
  code: z.string().nullable().optional(),
  details: UnknownRecordSchema.nullable().optional(),
});

const AgentEventPayloadSchema = z.union([
  MessagePayloadSchema,
  ThinkingPayloadSchema,
  ToolCallPayloadSchema,
  PlanUpdatePayloadSchema,
  ApprovalRequestPayloadSchema,
  ApprovalResponsePayloadSchema,
  SessionStartPayloadSchema,
  SessionEndPayloadSchema,
  ErrorPayloadSchema,
]);

const WSBaseSchema = z.object({
  timestamp: z.string().optional(),
});

const WSConnectedMessageSchema = WSBaseSchema.extend({
  type: z.literal("connected"),
  session_id: z.string(),
});

const WSErrorMessageSchema = WSBaseSchema.extend({
  type: z.literal("error"),
  error_code: z.string(),
  message: z.string(),
});

const WSPongMessageSchema = z.object({
  type: z.literal("pong"),
});

const WSSessionStatusChangedMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.status_changed"),
  session_id: z.string(),
  status: z.string(),
  previous_status: z.string(),
});

const WSSessionCompletedMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.completed"),
  session_id: z.string(),
  completed_at: z.string(),
});

const WSSessionFailedMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.failed"),
  session_id: z.string(),
  error_message: z.string().optional(),
});

const WSSessionCancelledMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.cancelled"),
  session_id: z.string(),
});

const WSSessionActivityMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.activity"),
  session_id: z.string(),
  chunk: ActivityChunkSchema,
});

const WSAgentEventMessageSchema = WSBaseSchema.extend({
  type: z.literal("agent.event"),
  session_id: z.string(),
  chunk_id: z.string(),
  event_type: z.enum([
    "session_start",
    "session_end",
    "error",
    "message",
    "message_delta",
    "thinking",
    "thinking_delta",
    "tool_call_start",
    "tool_call_update",
    "tool_call_end",
    "plan_update",
    "ask_user_permissions",
    "approval_response",
  ]),
  agent_type: z.enum([
    "claude",
    "amp",
    "cursor",
    "codex",
    "acp",
    "droid",
    "copilot",
    "unknown",
  ]),
  payload: AgentEventPayloadSchema,
});

const WSSessionQuestionAskedMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.question_asked"),
  session_id: z.string(),
  question: QuestionPayloadSchema,
});

const WSSessionQuestionAnsweredMessageSchema = WSBaseSchema.extend({
  type: z.literal("session.question_answered"),
  session_id: z.string(),
  question_id: z.string(),
  answered_at: z.string(),
});

const PendingQuestionSchema = z.object({
  question_id: z.string(),
  question_text: z.string(),
  answer_kind: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const WSSessionPausedUserMessageSchema = WSBaseSchema.extend({
  type: z.literal("session_paused_user"),
  session_id: z.string(),
  status: z.literal("paused_user"),
  question_ids: z.array(z.string()).optional(),
  pending_questions: z.array(PendingQuestionSchema).optional(),
});

const WSLLMUsageMessageSchema = WSBaseSchema.extend({
  type: z.literal("llm_usage"),
  session_id: z.string(),
  job_id: z.string().optional(),
  listing_id: z.string().optional(),
  data: z.object({
    model: z.string(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    billing: z
      .object({
        cost_cents: z.number(),
        balance_cents: z.number(),
        session_cost_cents: z.number(),
      })
      .optional(),
  }),
});

const WSBillingPauseMessageSchema = WSBaseSchema.extend({
  type: z.literal("billing_pause"),
  session_id: z.string(),
  job_id: z.string().optional(),
  listing_id: z.string().optional(),
  data: z.object({
    reason: z.enum([
      "budget_exhausted",
      "insufficient_balance",
      "provider_error",
      "billing_error",
    ]),
    balance_cents: z.number(),
    session_cost_cents: z.number(),
  }),
});

const FileChangePayloadSchema = z.object({
  path: z.string(),
  action: z.enum(["created", "modified", "deleted"]),
  size: z.number().optional(),
  mtime: z.string().optional(),
});

const WSFilesChangedMessageSchema = WSBaseSchema.extend({
  type: z.literal("files.changed"),
  session_id: z.string(),
  changes: z.array(FileChangePayloadSchema),
  batch_id: z.string().nullable().optional(),
  chunk_index: z.number().int().nullable().optional(),
  total_chunks: z.number().int().nullable().optional(),
});

export const WSMessageSchema = z.discriminatedUnion("type", [
  WSConnectedMessageSchema,
  WSErrorMessageSchema,
  WSPongMessageSchema,
  WSSessionStatusChangedMessageSchema,
  WSSessionCompletedMessageSchema,
  WSSessionFailedMessageSchema,
  WSSessionCancelledMessageSchema,
  WSSessionActivityMessageSchema,
  WSAgentEventMessageSchema,
  WSSessionQuestionAskedMessageSchema,
  WSSessionQuestionAnsweredMessageSchema,
  WSSessionPausedUserMessageSchema,
  WSLLMUsageMessageSchema,
  WSBillingPauseMessageSchema,
  WSFilesChangedMessageSchema,
]);

export const CODE_EDITOR_WEB_SOCKET_EVENT_TYPES = [
  "repo:status_updated",
  "file:changed",
  "repo:git_operation",
  "repo:watcher_health",
  "lsp:diagnostics",
  "terminal_agent.status_changed",
] as const;

export const CodeEditorWebSocketMessageSchema = z.object({
  type: z.enum(CODE_EDITOR_WEB_SOCKET_EVENT_TYPES),
  repo_id: z.string().optional(),
  language: z.string().optional(),
  data: z.unknown().optional(),
  payload: z.unknown().optional(),
  status: z.unknown().optional(),
  files: z.array(z.unknown()).optional(),
  terminal_session_id: z.string().optional(),
  cli_agent_type: z.string().optional(),
  agent_status: z
    .enum(["starting", "running", "waiting", "blocked", "done"])
    .optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input_preview: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
  approval_surface: z.string().optional(),
  timestamp: z.number(),
});

export type ParsedWSMessage = z.output<typeof WSMessageSchema>;
export type ParsedCodeEditorWebSocketMessage = z.output<
  typeof CodeEditorWebSocketMessageSchema
>;

export function parseWSMessage(raw: string): ParsedWSMessage {
  return WSMessageSchema.parse(JSON.parse(raw));
}

export function parseCodeEditorWebSocketMessage(
  raw: string
): ParsedCodeEditorWebSocketMessage {
  return CodeEditorWebSocketMessageSchema.parse(JSON.parse(raw));
}

export function maybeParseCodeEditorWebSocketMessage(
  raw: string
): ParsedCodeEditorWebSocketMessage | null {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }

  const type = (parsed as { type: unknown }).type;
  if (
    typeof type !== "string" ||
    !CODE_EDITOR_WEB_SOCKET_EVENT_TYPES.includes(
      type as (typeof CODE_EDITOR_WEB_SOCKET_EVENT_TYPES)[number]
    )
  ) {
    return null;
  }

  return CodeEditorWebSocketMessageSchema.parse(parsed);
}
