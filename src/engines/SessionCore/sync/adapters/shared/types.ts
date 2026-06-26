/**
 * Shared Agent Event Types
 *
 * Canonical type definitions for all agent session adapters (SDE, OS, custom).
 * New adapters should import from here instead of defining their own event types.
 */
import type { RustAgentType } from "@src/util/session/sessionDispatch";

/** Base message structure common to all agents. */
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  streaming?: boolean;
  subagentElapsedMs?: number;
  subagentToolCalls?: number;
  streamingToolCall?: boolean;
  subagentReasoningText?: string;
}

// ============================================
// Streaming Error Types (from Rust StreamingError)
// ============================================

/**
 * Error codes for agent streaming errors.
 *
 * Enables frontend to display appropriate UI and retry logic.
 * Mirrors Rust `StreamingErrorCode` enum.
 */
export type StreamingErrorCode =
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "PROVIDER_OVERLOADED"
  | "MODEL_NOT_FOUND"
  | "NETWORK_ERROR"
  | "STREAM_INTERRUPTED"
  | "TOOL_ERROR"
  | "CONTEXT_OVERFLOW"
  | "CANCELLED"
  | "PERMISSION_DENIED"
  | "SESSION_NOT_FOUND"
  | "INTERNAL_ERROR"
  | "UNKNOWN";

/**
 * Structured error details for agent:error events.
 *
 * Enables rich error display and retry logic in the frontend.
 */
export interface StreamingErrorDetails {
  /** Retry delay hint from the provider (rate limit / overload). */
  retryAfterSecs?: number;
  /** Tool name if this is a tool error. */
  toolName?: string;
  /** File path if applicable. */
  filePath?: string;
}

/**
 * Superset WebSocket event payload covering all agent types.
 * Each agent only uses a subset; unused fields stay undefined.
 */
export interface AgentWSEvent {
  type: string;
  sessionId?: string;
  content?: string;
  tool?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  toolArgs?: Record<string, unknown>;
  result?: string;
  /**
   * Populated by `agent:interaction_finalized` (see Rust
   * `interaction/finalize.rs`). Carries the authoritative structured result
   * ({ status, answers?, choice?, content, observation }) for an
   * `ask_user_questions` / permission / mode-switch response at the moment
   * the user clicks — so the UI flips to "answered" without waiting for the
   * tool's `execute()` to return.
   */
  resultObject?: Record<string, unknown>;
  /** Backup content string mirroring `result` for `agent:interaction_finalized`. */
  resultPreview?: string;
  /** Finalized interaction status: "answered" | "cancelled" | "timed_out" | "rejected". */
  status?: string;
  error?: string;

  // ============================================
  // Structured Error Fields (agent:error)
  // ============================================

  /** Error code for programmatic handling. */
  errorCode?: StreamingErrorCode;
  /** Whether this error is retryable. */
  isRetryable?: boolean;
  /** Stack trace (debug builds only). */
  stackTrace?: string;
  /** Additional error details. */
  details?: StreamingErrorDetails;
  requestId?: string;
  questions?: unknown[];
  /**
   * Backend-authoritative auto-resolve deadline (epoch ms) for a pending
   * question batch, from the user's presence policy. Null/absent = no
   * auto-skip under the current presence.
   */
  autoResolveAt?: number | null;
  model?: string;
  /** True when agent:complete is only closing a terminal provider-error turn. */
  isStreamError?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  /** Per-category context usage snapshot — emitted by Rust in agent:complete when available. */
  contextUsage?: AgentContextUsageSnapshot;
  /** Legacy per-category context breakdown. */
  contextBreakdown?: AgentContextBreakdown;
  index?: number;
  argumentsDelta?: string;
  description?: string;
  elapsedMs?: number;
  toolCalls?: number;
  success?: boolean;
  chunk?: string;
  stream?: string;
  files?: string[];
  workspacePath?: string;
  todos?: unknown[];
  /** OS Agent: ADE action correlation (agent:ade_action) */
  correlationId?: string;
  operation?: "list" | "inspect" | "dispatch";
  action?: string;
  params?: Record<string, unknown>;
  agentType?: RustAgentType;

  // ============================================
  // Plan Approval (non-blocking flow)
  //
  //   agent:plan_ready_for_approval  → create_plan finished writing the file
  //                                    and marked the snapshot ready; the
  //                                    Build button should become clickable
  //   agent:exit_plan_mode           → user clicked Build, flip mode back
  //
  // Rust also broadcasts `agent:plan_approval_archived` inside
  // `PlanApprovalManager::mark_ready`. The current action surface is
  // driven by the paired `plan_ready_for_approval` upsert, while the
  // transcript surface coalesces only raw streaming drafts with lifecycle
  // updates for the same revision. Older revisions remain visible history.
  // ============================================

  /** Absolute path of the plan file awaiting approval. */
  planPath?: string;
  /** Human-readable plan title derived from the slug. */
  planTitle?: string;
  /** Current content of the plan file (markdown). */
  planContent?: string;
  /** Stable identity of the pending approval slot. */
  planId?: string;
  /** Stable identity of the active plan-card revision. */
  planRevisionId?: string;
  /** Tool-call id that originated the current revision. */
  originToolCallId?: string;
  /** Source of the plan-ready broadcast; edit_file refreshes should render in the current turn. */
  planEventSource?: "create_plan" | "edit_file" | "rehydrate";
  /** `AgentExecMode` (as its serialized string) to restore when Build is clicked. */
  restoreMode?: string;
  /** True when Build triggered an `approve_with_edits` persistence. */
  edited?: boolean;
  /** True when the user skipped/rejected the pending plan without starting Build. */
  rejected?: boolean;

  // ============================================
  // Warning Events (agent:warning)
  // ============================================

  /** Non-fatal warning message from a background subsystem. */
  warning?: string;
  /** Subsystem source of the warning (e.g. "session_memory", "compaction"). */
  source?: string;

  /** Turn summary text (agent:turn_summary) */
  summary?: string;
  /** Stable turn id for anchoring post-turn summary events. */
  turnId?: string;
  /** Transcript timestamp for anchoring post-turn summary events. */
  createdAt?: string;
  /** Wall time in seconds for the completed turn (agent:turn_summary) */
  wallTimeSecs?: number;
  /** Terminal turn status from agent:turn_completed. */
  turnStatus?: string;
  /** Terminal session status from agent:turn_completed. */
  sessionStatus?: string;

  // ============================================
  // Queue Status Events (agent:queue_status)
  // ============================================

  /** Number of messages queued behind the currently running turn. */
  pendingCount?: number;
  /** Whether the Rust scheduler is currently executing a queued turn. */
  isProcessing?: boolean;

  // ============================================
  // Shell Process Events (agent:shell_process_started/backgrounded/exited)
  // ============================================

  /** Shell process PID */
  pid?: number;
  /** Shell process exit code */
  exitCode?: number;
  /** Whether the process was killed (vs normal exit) */
  killed?: boolean;
  /** Path to the terminal log file */
  logPath?: string;
  /** Shell command (explicit for shell process events) */
  command?: string;
  /**
   * Backgrounded reason (agent:shell_process_backgrounded):
   * - "explicit" — `run_shell(mode="background")` requested detach up-front
   * - "timeout"  — blocking run hit `wait_secs` and was auto-detached
   */
  reason?: "explicit" | "timeout";

  // ============================================
  // Background Subagent Job Events (agent:subagent_job_changed)
  // ============================================

  /** Job-registry handle of the background subagent (its session id) */
  handle?: string;
  /** Display name of the subagent's agent definition */
  agentName?: string;
  /** "delegate" | "shadow" | agent id label */
  subagentType?: string;
  // (job status rides the shared `status` field above)

  // ============================================
  // Streaming Complete Events (agent:streaming_complete)
  // From Rust StreamingBuffer — replaces TS-side delta accumulation
  // ============================================

  /** Stream type: "message" or "thinking" */
  streamType?: "message" | "thinking";
  /** Complete SessionEvent from Rust (replaces streaming event) */
  event?: unknown;

  // ============================================
  // Stream Retry Events
  //
  //   agent:stream_retry              → low-key footer indicator while the
  //                                     turn executor silently retries a
  //                                     network-interrupted LLM call.
  //   agent:stream_error_exhausted    → terminal failure after retry budget
  //                                     is exhausted; show a persistent
  //                                     "Connection failed" banner.
  //
  // Neither event is a chat bubble. `agent:stream_retry` is explicitly
  // NOT `agent:message_delta` because we don't want retry internals to
  // render inside the assistant's text stream.
  // ============================================

  /** StreamErrorKind as snake_case ("idle_timeout" | "provider_error" | "connection_error" | "unknown"). */
  kind?: string;
  /** 1-indexed retry attempt (only on `agent:stream_retry`). */
  attempt?: number;
  /** Retry budget ceiling (only on `agent:stream_retry`). */
  maxAttempts?: number;
  /** Wall-clock backoff before the next retry in milliseconds. */
  backoffMs?: number;
  /** Total number of failed attempts (only on `agent:stream_error_exhausted`). */
  attempts?: number;
  /** User-visible message (only on `agent:stream_error_exhausted`). */
  message?: string;

  // ============================================
  // MCP Tool Streaming (agent:mcp_progress)
  //
  // Emitted for every `notifications/progress` the active MCP server
  // sends while a tool is running. Schema mirrors the MCP spec
  // `ProgressNotificationParam` + the extra session/tool correlation
  // fields we need to route it to the right chat bubble.
  //
  // - progress          : monotonically increasing numeric tick
  // - total             : known upper bound; `null` → unbounded spinner,
  //                       number → progress bar (progress/total)
  // - message           : optional human status string (`null` means
  //                       "no label", NOT "" — Rule 13)
  // - toolCallId        : matches the `__call_id` stamp the turn
  //                       executor injects into every tool arg object,
  //                       so the frontend can look up the exact chat
  //                       bubble to render the inline progress UI on.
  // ============================================

  /** Monotonic progress value from the server. */
  progress?: number;
  /** Optional known upper bound for the progress; `null` when unbounded. */
  total?: number | null;
}

export interface PermissionRequestEvent {
  requestId: string;
  sessionId: string;
  tool: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  agentType?: RustAgentType;
}

export interface QuestionRequestEvent {
  requestId: string;
  sessionId: string;
  questions: unknown[];
  toolCallId?: string;
}

/**
 * Payload for `agent:plan_ready_for_approval` — `create_plan` finished
 * writing the plan file on disk and the inline Build button on the
 * streaming `CreatePlanCard` should become clickable.
 */
export interface PlanReadyForApprovalEvent {
  sessionId: string;
  planPath: string;
  planTitle: string;
  planContent: string;
  toolCallId?: string;
  planId?: string;
  planRevisionId?: string;
  originToolCallId?: string;
  autoApproveAt?: number | null;
}

/**
 * Payload for `agent:exit_plan_mode` — broadcast after
 * `agent_plan_approval_response` consumed the pending snapshot. The FE
 * clears `pendingPlanApprovalsAtom.current` (matched by `toolCallId`)
 * and flips `creatorDefaultExecModeAtom` back to `restoreMode`.
 */
export interface ExitPlanModeEvent {
  sessionId: string;
  planPath: string;
  planTitle: string;
  toolCallId?: string;
  planId?: string;
  planRevisionId?: string;
  originToolCallId?: string;
  restoreMode: string;
  edited: boolean;
  rejected: boolean;
}

export type AgentContextUsageCategory =
  | "stable_prompt"
  | "dynamic_prompt"
  | "rules"
  | "skills"
  | "memory"
  | "conversation"
  | "tool_results"
  | "attachments"
  | "other"
  | "unattributed";

export interface AgentContextUsageItem {
  category: AgentContextUsageCategory;
  label: string;
  source: string;
  estimatedTokens: number;
  included: boolean;
  cacheStatus?: string | null;
  details?: string | null;
}

export interface AgentContextUsageSection {
  category: AgentContextUsageCategory;
  label: string;
  estimatedTokens: number;
  percent: number;
  items: AgentContextUsageItem[];
}

export interface AgentContextUsageSnapshot {
  usedTokens: number;
  maxTokens?: number | null;
  percentUsed?: number | null;
  updatedAt: string;
  sections: AgentContextUsageSection[];
  warnings: string[];
}

/**
 * Legacy per-category context window breakdown.
 */
export interface AgentContextBreakdown {
  systemPromptTokens?: number;
  toolsTokens?: number;
  rulesTokens?: number;
  skillsTokens?: number;
  mcpTokens?: number;
  subagentTokens?: number;
  summaryTokens?: number;
  conversationTokens?: number;
}

export interface AgentTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens from the last LLM call — represents current context window fill level. */
  contextTokens: number;
  /** Context usage snapshot from the final provider request. */
  contextUsage?: AgentContextUsageSnapshot;
  /** Legacy per-category breakdown. */
  contextBreakdown?: AgentContextBreakdown;
}

/**
 * Per-tool-call buffer for accumulating streamed JSON argument fragments.
 *
 * `toolCallId` starts `undefined` — deltas may arrive before the wire id is
 * known. Once set it MUST NOT change (the same `index` stream always refers
 * to one `call_id`). `messageId` is derived from `toolCallId` the first time
 * the real id lands; while it is `null`, no store event exists yet and the
 * buffer is purely in-memory.
 *
 * Historical bug: deltas used to synthesize a
 * `pending-tc-${index}` id and upsert an event immediately, then re-upsert
 * under the real id when it arrived — leaving a zombie tool_call row in the
 * store that `agent:tool_result` could never pair with (Build-button hang).
 */
export interface ToolCallDeltaBuffer {
  toolCallId?: string;
  toolName?: string;
  argsJson: string;
  messageId: string | null;
}

export interface StreamRefs {
  contentRef: { current: string };
  idRef: { current: string };
}

export interface StreamingInfo {
  isStreaming: boolean;
  isThinking: boolean;
  content: string;
}
