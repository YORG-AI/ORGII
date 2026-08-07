/**
 * Session Types
 *
 * Type definitions for Session API based on session-router-design.md
 * Session is the workflow execution engine for agent runs.
 */
import type { BackendEvent, WsSpec } from "./steps";

// ============================================
// Enums
// ============================================

/**
 * Unified session status — maps to Rust's simplified 3-state model.
 *
 * All session types (CLI, Market, Workflow) normalize to this.
 * Source of truth: Rust unified_session_status in agent_core.
 */
export type UnifiedSessionStatus = "active" | "completed" | "failed";

/**
 * Session status enum — single source of truth for all session types.
 *
 * Covers SDE/OS agent sessions (HTTP API), CLI sessions (Tauri IPC / WS), and
 * market-backed sessions. Align with Rust SessionStatus and
 * src-tauri/src/agent_sessions/session_directory/status.rs.
 */
export type SessionStatus =
  // Active statuses (session alive)
  | "pending"
  | "idle"
  | "running"
  | "waiting_for_user"
  | "waiting_for_funds"
  | "paused"
  | "queued" // Market queue
  | "in_progress" // Market / workflow in-flight
  // Terminal statuses (session finished)
  | "completed"
  | "failed"
  | "error"
  | "cancelled"
  | "abandoned"
  | "timeout"
  | "killed" // Market / operator-terminated
  | "archived"; // Hidden by idle-reset / compact-fork; content preserved

/**
 * CLI-specific session statuses.
 *
 * Must cover every value the Rust backend can emit via WS `status_changed`
 * or `PostLoadResult.runStatus`. The Rust source of truth is
 * `SessionStatus` in `agent_core/core/session/types/enums.rs`. Any value
 * present there but missing here gets coerced to `"idle"` by
 * `toCliSessionStatus`, which makes terminal sessions look alive and
 * breaks chat loading. Keep this union in sync with the Rust enum.
 *
 * - "idle" — session not started or returned to idle after a turn
 * - "installing" — CLI agent dependencies being installed
 * - "pending" — created but not yet running
 * - "paused" — paused by user
 * - "abandoned" — recovered orphaned `running`/`waiting_for_user` row on startup
 * - "timeout" — backend killed the run after a deadline
 * - "archived" — hidden by idle-reset / compact-fork; content preserved
 * - Other terminal/active values shared with SessionStatus
 */
export type CliSessionStatus =
  | "idle"
  | "running"
  | "installing"
  | "pending"
  | "paused"
  | "completed"
  | "failed"
  | "error"
  | "cancelled"
  | "abandoned"
  | "timeout"
  | "archived"
  | "waiting_for_user"
  | "waiting_for_funds";

/**
 * Market-specific session statuses.
 * - "queued", "in_progress", "killed" — Market-only states
 * - Others shared with SessionStatus
 */
export type MarketSessionStatus =
  | "pending"
  | "queued"
  | "in_progress"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "cancelled";

// ============================================
// Status Sets
// ============================================

/** Statuses that indicate the session has finished (successfully or not). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "abandoned",
  "timeout",
  "killed", // Market-specific
  "archived", // CLI: idle-reset / compact-fork tombstone
]);

/** Statuses that indicate the session is alive / in-progress. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "pending",
  "running",
  "waiting_for_user",
  "waiting_for_funds",
  "paused",
  "installing", // CLI-specific
  "queued", // Market-specific
  "in_progress", // Market-specific
]);

// ============================================
// Status Helpers
// ============================================

export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status);
}

export function isActiveStatus(status: string | undefined): boolean {
  return status !== undefined && ACTIVE_STATUSES.has(status);
}

/**
 * Convert any session status to unified 3-state model.
 * This matches Rust's unified_session_status mapping.
 */
export function toUnifiedStatus(
  status: string | undefined
): UnifiedSessionStatus {
  if (!status) return "active";
  if (status === "completed") return "completed";
  if (TERMINAL_STATUSES.has(status)) return "failed";
  return "active";
}

/**
 * Check if status represents an "active" session in unified model.
 */
export function isUnifiedActive(status: string | undefined): boolean {
  return toUnifiedStatus(status) === "active";
}

/**
 * Check if status represents a "completed" session in unified model.
 */
export function isUnifiedCompleted(status: string | undefined): boolean {
  return toUnifiedStatus(status) === "completed";
}

/**
 * Check if status represents a "failed" session in unified model.
 */
export function isUnifiedFailed(status: string | undefined): boolean {
  return toUnifiedStatus(status) === "failed";
}

// ============================================
// Request Models
// ============================================

/**
 * Request to create a new session
 */
export interface SessionCreateRequest {
  /** Repo UUID (path derived from repo.path) */
  repo_id: string;
  /** User's request/goal for this session */
  user_input: string;
  /** Session configuration overrides (provider, model, etc.) */
  config?: Record<string, unknown>;
}

/**
 * Request to answer a pending question
 */
export interface AnswerQuestionRequest {
  /** Question UUID to answer */
  question_id: string;
  /** User's answer */
  answer: string;
}

/**
 * Request to send a message to a session
 */
export interface MessageRequest {
  /** Message content */
  content: string;
  /** Role of the message sender (default: "user") */
  role?: "user" | "system";
}

/**
 * Query parameters for listing sessions
 */
export interface SessionListParams {
  /** Filter by repo path */
  repoPath?: string;
  /** Filter by status */
  status?: SessionStatus;
  /** Max results (default: 50, max: 200) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/**
 * Query parameters for activity polling
 */
export interface ActivityListParams {
  /** ISO timestamp - only return chunks created after this time */
  since?: string;
  /** ISO timestamp - only return chunks created before this time (for loading older data) */
  before?: string;
  /** Max chunks to return (default: 50, max: 200) */
  limit?: number;
}

// ============================================
// Response Data Models
// ============================================

/**
 * A pending question waiting for user answer
 */
export interface PendingQuestion {
  /** Question UUID */
  question_id: string;
  /** The question text */
  question_text: string;
  /** ISO timestamp when asked */
  asked_at?: string;
  /** Why this question is being asked */
  rationale?: string;
}

/**
 * What the session is waiting for when status is "waiting_for_user"
 * - "question": Waiting for user answer
 */
export type WaitingForType = "question" | null;

/**
 * Session status response - used for both detail and list endpoints
 *
 * For list endpoints: pending_questions will be empty.
 * For detail endpoint: all fields populated.
 */
export interface SessionStatusData {
  /** Session UUID */
  session_id: string;
  /** Current status */
  status: SessionStatus;
  /** What the session is waiting for (only when status is "waiting_for_user") */
  waiting_for?: WaitingForType;

  // Timestamps
  /** ISO timestamp when created */
  created_at?: string;
  /** ISO timestamp when last updated */
  updated_at?: string;
  /** ISO timestamp when completed (if completed) */
  completed_at?: string;
  /** Legacy: created_time */
  created_time?: string;
  /** Legacy: updated_time */
  updated_time?: string;

  // User interaction (empty in list responses for performance)
  /** Questions waiting for user answer */
  pending_questions?: PendingQuestion[];
  /** Number of pending questions */
  pending_questions_count?: number;

  // Error info
  /** Error details if failed */
  error_message?: string;

  // Original request
  /** Original user request */
  user_input?: string;

  // Fields from getSessionState
  /** Step events */
  events?: BackendEvent[];
  /** Specs list */
  specs?: WsSpec[];
}

/**
 * Response data for session creation
 */
export interface SessionCreatedData {
  /** Created session UUID */
  session_id: string;
}

/**
 * Response data for successful answer submission
 */
export interface AnswerSuccessData {
  /** Whether answer was accepted */
  success: boolean;
}

/**
 * Response data for pause/resume/message operations
 */
export interface PauseResumeSuccessData {
  /** Whether operation was successful */
  success: boolean;
  /** Whether message was queued (for send message while running) */
  queued?: boolean;
}

/**
 * Structured question answer for market sessions
 */
export interface QuestionAnswer {
  /** Question ID to answer */
  question_id: string;
  /** User's answer */
  answer: string;
}

/**
 * Request to continue a completed session with new feedback
 * Supports two modes:
 * 1. Simple text feedback: Just provide `feedback` string
 * 2. Structured answers: Provide `question_answers` list for form-based responses
 */
export interface ContinueSessionRequest {
  /** New user feedback/instruction (1-10000 chars) - optional if question_answers provided */
  feedback?: string;
  /** Structured question answers (for market sessions) */
  question_answers?: QuestionAnswer[];
}

/**
 * Response data for continue session
 */
export interface ContinueSessionData {
  /** Session UUID */
  session_id: string;
  /** New status (will be "pending" after continue) */
  status: string;
  /** How many times session has been continued */
  continue_count: number;
  /** Total cost in USD */
  total_cost_usd: number;
  /** Success message */
  message: string;
}

/**
 * Response data for session list
 */
export interface SessionListData {
  /** List of sessions (sparse list fields) */
  sessions: SessionStatusData[];
  /** Total count (for pagination) */
  total: number;
}

/**
 * Response data for cancel all
 */
export interface CancelAllData {
  /** Number of sessions cancelled */
  cancelled_count: number;
}

// ============================================
// Activity Models
// ============================================

/**
 * An activity chunk representing an action during session execution
 */
export interface ActivityChunk {
  /** Unique chunk identifier */
  chunk_id: string;
  /** Session ID (optional - may be omitted in API responses when context is known) */
  session_id?: string;
  /** Type of action (e.g., tool_call, execute_thread, etc.) */
  action_type: string;
  /** Specific agent/tool name (e.g., cursor_cli, read_file, bash, etc.) */
  function: string;
  /** Input arguments to the action */
  args: Record<string, unknown>;
  /** Output result (includes success, output, etc.) */
  result: Record<string, unknown>;
  /** ISO timestamp when action occurred */
  created_at: string;
  /** Thread ID if part of thread execution */
  thread_id?: string;
  /** Process ID if part of a process */
  process_id?: string;
}

/**
 * Response data for activity list
 */
export interface ActivityListData {
  /** List of activity chunks */
  chunks: ActivityChunk[];
  /** Total count of chunks returned */
  total: number;
  /** Whether more chunks exist after this batch */
  has_more: boolean;
}

// ============================================
// API Response Types (wrapped in BaseResp)
// ============================================

/**
 * Base API response wrapper
 */
export interface BaseResp<T> {
  status: number;
  data: T;
}

export type SessionCreateResponse = BaseResp<SessionCreatedData>;
export type WorkflowSessionStatusResponse = BaseResp<SessionStatusData>;
export type SessionListResponse = BaseResp<SessionListData>;
export type AnswerResponse = BaseResp<AnswerSuccessData>;
export type CancelAllResponse = BaseResp<CancelAllData>;
export type ActivityListResponse = BaseResp<ActivityListData>;
