/**
 * Session Core Types
 *
 * Unified event type that replaces:
 * - BackendEvent (Simulator)
 * - Per-event chat payloads previously shaped as nested activity blobs (Chat panel)
 * - ActivityChunk (API response)
 *
 * Single source of truth for all session events.
 */
import type { SessionStatus } from "@src/types/session/session";

// ============================================
// Display Variants
// ============================================

/**
 * How an event should be displayed across different components.
 * Determines rendering strategy in ChatPanel and Simulator.
 */
export type EventDisplayVariant =
  | "tool_call" // File operations, shell commands, etc.
  | "message" // Assistant/user messages
  | "thinking" // LLM thinking/reasoning
  | "plan" // Plan updates
  | "approval" // Approval request/response
  | "session" // Session start/end
  | "summary" // Turn completion summary
  | "error"; // Errors

/**
 * Current status of an event for display purposes.
 *
 * `awaiting_user` is distinct from `running` for interactive tool calls
 * (`ask_user_questions`, `ask_user_permissions`, `suggest_mode_switch`,
 * `create_plan`) that block the agent turn while waiting for user input.
 * Generic "complete the last running event" paths must skip this phase —
 * only `agent:interaction_finalized` (via `merge_events`) transitions it
 * to `completed`. This prevents the interactive card from disappearing
 * when the surrounding turn emits `agent:complete` before the user answers.
 */
export type EventDisplayStatus =
  | "running"
  | "completed"
  | "failed"
  | "pending"
  | "awaiting_user";

/**
 * Activity status from user perspective.
 * - agent: Agent has processed (default)
 * - pending: Waiting for user action
 * - processed: User has responded
 */
export type ActivityStatus = "agent" | "pending" | "processed";

// ============================================
// SessionEvent - The Unified Event Type
// ============================================

/**
 * Unified event type representing any action during a session.
 *
 * This is the SINGLE SOURCE OF TRUTH for all event data.
 * All UI components (ChatPanel, Simulator, ActivityList) read from this.
 *
 * Converted once at ingestion from ActivityChunk/WebSocket events.
 */
export interface PayloadRef {
  eventId: string;
  fieldPath: string;
  preview: string;
  fullSizeBytes: number;
  truncated: boolean;
}

export interface EventPayloadBody {
  eventId: string;
  fieldPath: string;
  body: string;
  fullSizeBytes: number;
}

export type SimulatorEventFilterValue =
  | "key_interactions"
  | "file_changes"
  | "terminal_events"
  | "explore"
  | "other";

export interface SimulatorEventPreview {
  id: string;
  sessionId: string;
  createdAt: string;
  functionName: string;
  uiCanonical: string;
  actionType: string;
  source: "assistant" | "user" | "system";
  displayText: string;
  displayStatus: EventDisplayStatus;
  displayVariant: EventDisplayVariant;
  activityStatus: ActivityStatus;
  filterCategory: SimulatorEventFilterValue;
  threadId?: string;
  processId?: string;
  callId?: string;
  filePath?: string;
  command?: string;
  isDelta?: boolean;
  repoId?: string;
  repoPath?: string;
}

export const TOOL_USAGE_ARGS_KEY = "__orgiiToolUsage";
export const LLM_USAGE_ARGS_KEY = "__orgiiLlmUsage";

export interface LlmUsageMetadata {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model?: string | null;
  attributionMethod: string;
}

export interface ToolUsageMetadata {
  decisionCompletionTokens: number;
  resultContextTokens: number;
  followupCompletionTokens: number;
  inputBytes: number;
  outputBytes: number;
  relatedCacheReadTokens: number;
  relatedCacheWriteTokens: number;
  attributionMethod: string;
}

export interface SessionEvent {
  chunk_id: string | null;
  // ============================================
  // Identity (from backend)
  // ============================================

  /** Unique identifier - chunk_id from backend */
  id: string;

  /** Session this event belongs to */
  sessionId: string;

  /** ISO timestamp when event occurred */
  createdAt: string;

  // ============================================
  // Core Data (normalized from various sources)
  // ============================================

  /** Normalized function name (e.g., "read_file", "edit_file_by_replace") */
  functionName: string;

  /** Pre-computed UI canonical name for component routing (e.g., "edit_file", "run_shell").
   * Computed once in Rust at ingestion. Replaces runtime normalizeFunctionName() calls. */
  uiCanonical: string;

  /** Raw action type from backend (e.g., "tool_call", "assistant", "llm_thinking") */
  actionType: string;

  /** Function arguments */
  args: Record<string, unknown>;

  /** Function result */
  result: Record<string, unknown>;

  /** Event source */
  source: "assistant" | "user" | "system";

  // ============================================
  // Pre-computed Display Hints
  // (Computed once at ingestion, used by all components)
  // ============================================

  /** Primary display text for this event */
  displayText: string;

  /** Current status for display */
  displayStatus: EventDisplayStatus;

  /** Rendering variant - determines component type */
  displayVariant: EventDisplayVariant;

  /** Activity status for border color in chat */
  activityStatus: ActivityStatus;

  // ============================================
  // Optional Metadata
  // ============================================

  /** Thread ID if part of thread execution */
  threadId?: string;

  /** Process ID if part of a process */
  processId?: string;

  /** Tool call ID for matching start/update/end events */
  callId?: string;

  /** Token/context attribution metadata for this tool call. */
  toolUsage?: ToolUsageMetadata;

  /** Token usage metadata for the LLM span represented by this event. */
  llmUsage?: LlmUsageMetadata;

  /** File path for file operations */
  filePath?: string;

  /** Command for shell operations */
  command?: string;

  /** Whether this is a delta/streaming update */
  isDelta?: boolean;

  /** Repository ID that was active when this event was created */
  repoId?: string;

  /** Repository filesystem path that was active when this event was created */
  repoPath?: string;

  // ============================================
  // Shell Process State (from ShellProcessStarted/Exited events)
  // ============================================

  /** Shell process PID (set by ShellProcessStarted event) */
  shellPid?: number;

  /** Shell process status (updated by ShellProcessStarted/Exited events) */
  shellProcessStatus?: "running" | "background" | "exited" | "killed";

  /** Shell process exit code (set by ShellProcessExited event) */
  shellExitCode?: number;

  /** Path to the terminal log file */
  shellLogPath?: string;

  /**
   * Rust-computed typed payload for block rendering.
   *
   * Populated by `event_pipeline::extractors::extract_event_data` on the
   * Rust side and attached to the event wire. Frontend blocks read this
   * directly instead of re-parsing `args`/`result` JSON.
   *
   * Recomputed on creation, on display_status transitions, and at most
   * every 500ms during streaming. See `.cursor/rules/event-rendering.mdc`.
   */
  extracted?: ExtractedData;

  payloadRefs?: PayloadRef[];
}

// ============================================
// Extracted Data — Mirrors Rust `ExtractedData` enum
// (src-tauri/src/agent_sessions/event_pipeline/extractors/types.rs)
//
// Serde serializes with `#[serde(tag = "kind", rename_all = "camelCase")]`
// so every variant is an object with a `kind` discriminant and the payload
// fields inlined at the top level.
// ============================================

export type ExtractedDataKind =
  | "thinking"
  | "file"
  | "edit"
  | "shell"
  | "search"
  | "glob"
  | "todo"
  | "message"
  | "listDir"
  | "await"
  | "webSearch"
  | "subagent"
  | "orgTask"
  | "deleteFile";

export type ExtractedData =
  | ({ kind: "thinking" } & RustExtractedThinkingData)
  | ({ kind: "file" } & RustExtractedFileData)
  | ({ kind: "edit" } & RustExtractedEditData)
  | ({ kind: "shell" } & RustExtractedShellData)
  | ({ kind: "search" } & RustExtractedSearchData)
  | ({ kind: "glob" } & RustExtractedGlobData)
  | ({ kind: "todo" } & RustExtractedTodoData)
  | ({ kind: "message" } & RustExtractedMessageData)
  | ({ kind: "listDir" } & RustExtractedListDirData)
  | ({ kind: "await" } & RustExtractedAwaitData)
  | ({ kind: "webSearch" } & RustExtractedWebSearchData)
  | ({ kind: "subagent" } & RustExtractedSubagentData)
  | ({ kind: "orgTask" } & RustExtractedOrgTaskData)
  | ({ kind: "deleteFile" } & RustExtractedDeleteFileData);

export interface RustExtractedThinkingData {
  content?: string;
  duration?: number;
}

export interface RustExtractedFileData {
  filePath: string;
  fileName: string;
  language: string;
  content?: string;
  lineCount?: number;
  /** 1-indexed first line of a ranged read (offset/limit); 1 or absent = from top. */
  startLine?: number;
}

export interface RustPatchSegmentWire {
  filePath: string;
  fileName: string;
  language: string;
  content?: string;
  lineCount?: number;
  oldContent?: string;
  newContent?: string;
  diff?: string;
  oldStartLine?: number;
  newStartLine?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isDeleted: boolean;
  applyPatchSegments: RustPatchSegmentWire[];
}

export interface RustExtractedEditData extends RustExtractedFileData {
  oldContent?: string;
  newContent?: string;
  diff?: string;
  oldStartLine?: number;
  newStartLine?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isDeleted: boolean;
  applyPatchSegments: RustPatchSegmentWire[];
}

export type GitArtifactKind = "commit" | "pullRequest";

export interface ExtractedGitArtifactData {
  kind: GitArtifactKind;
  url?: string;
  repoFullName?: string;
  sha?: string;
  shortSha?: string;
  subject?: string;
  prNumber?: number;
  prTitle?: string;
  sourceBranch?: string;
  targetBranch?: string;
}

export interface RustExtractedShellData {
  command: string;
  action?: string;
  killHandle?: string;
  description?: string;
  output?: string;
  streamOutput?: string;
  exitCode?: number;
  cwd?: string;
  executionTime?: number;
  isFailure: boolean;
  shellPid?: number;
  shellProcessStatus?: "running" | "background" | "exited" | "killed";
  shellLogPath?: string;
  gitArtifacts?: ExtractedGitArtifactData[];
}

export interface RustSearchResult {
  file: string;
  line: number;
  content: string;
}

export interface RustExtractedSearchData {
  query: string;
  results: RustSearchResult[];
  totalMatches: number;
}

export interface RustExtractedGlobData {
  pattern: string;
  files: string[];
  totalFiles: number;
}

export interface RustTodoItem {
  id: string;
  content: string;
  status: string;
  /** Present-continuous label preferred while the todo is in_progress. */
  activeForm?: string;
  blockedBy?: number[];
}

export interface RustExtractedTodoData {
  todos: RustTodoItem[];
  wasMerge: boolean;
}

export interface RustExtractedMessageData {
  content?: string;
  isUser: boolean;
}

export interface RustDirEntry {
  name: string;
  isDirectory: boolean;
}

export interface RustExtractedListDirData {
  directory: string;
  entries: RustDirEntry[];
  contentSummary?: string;
}

export interface RustExtractedAwaitData {
  handle?: string;
  blockUntilMs?: number;
  resultText?: string;
}

export interface RustWebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface RustExtractedWebSearchData {
  query: string;
  results: RustWebSearchResult[];
}

export interface RustExtractedSubagentData {
  description: string;
  subagentType: string;
  resultContent: string;
  resultSummary?: string;
  success: boolean;
  subagentSessionId?: string;
  elapsedMs?: number;
  errorMessage?: string;
  prompt?: string;
}

export interface RustOrgTaskItem {
  id: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: string;
  owner?: string;
  ownerName?: string;
  ownerAgentIconId?: string;
  ownerCliAgentType?: string;
  priority?: string;
  blocks?: string[];
  blockedBy?: string[];
}

export interface RustExtractedOrgTaskData {
  action: "create" | "update" | "delete" | "get" | "list";
  /** Missing only on persisted events produced before operation outcomes existed. */
  outcome?: "pending" | "succeeded" | "rejected" | "failed" | "unknown";
  task?: RustOrgTaskItem;
  tasks?: RustOrgTaskItem[];
  total?: number;
  orgRunId?: string;
  ownerChanged?: boolean;
  statusChanged?: boolean;
  taskAssignedDispatched?: boolean;
  guidance?: string;
  errorMessage?: string;
}

export interface RustExtractedDeleteFileData {
  filePath: string;
  fileName: string;
}

// ============================================
// Replay State Types
// ============================================

export interface ReplayTimeRange {
  start: string;
  end: string;
}

export type ReplayMode = "follow" | "replay";

// ============================================
// Session Status
// ============================================

export type SessionLoadStatus = "idle" | "loading" | "loaded" | "error";

/**
 * SessionRunStatus — Subset of SessionStatus for runtime tracking
 *
 * Derived from SessionStatus using Extract<T, U> to ensure type-level
 * consistency. Represents the statuses relevant to the session sync
 * engine during active session execution.
 *
 * Excluded from full SessionStatus:
 * - "idle" (not a run status, session hasn't started)
 * - "waiting_for_funds" (market-specific billing pause)
 * - "paused" (market-specific user pause)
 * - "abandoned" (session left without completion)
 * - "timeout" (session exceeded time limit)
 *
 * @see SessionStatus in @src/types/session/session.ts for full definition
 */
export type SessionRunStatus = Extract<
  SessionStatus,
  | "pending"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "cancelled"
>;

// ============================================
// Cache Types
// ============================================

export interface CachedSession {
  sessionId: string;
  events: SessionEvent[];
  specs: SessionSpec[];
  timeRange: ReplayTimeRange;
  cachedAt: number;
  eventCount: number;
}

// ============================================
// Session Spec
// ============================================

export interface SessionSpec {
  specId: string;
  sessionId: string;
  spec: string;
  content?: string;
  createdTime: string;
  status?: string;
  stepId?: string | null;
}
