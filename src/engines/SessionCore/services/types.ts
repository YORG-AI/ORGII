/**
 * Session Service Types
 *
 * Types for the SessionService singleton, which provides a unified interface
 * for session operations used by both human UI and OS agent dispatch.
 *
 * All sessions are managed by the Rust backend via Tauri.
 */
import type { AgentRole } from "@src/api/http/project";
import type { CancelReason } from "@src/api/tauri/agent/session";
import type { DispatchCategory } from "@src/api/tauri/session";

// ============================================
// Action Params
// ============================================

export interface SessionCreateParams {
  /** User's task description */
  task: string;
  /** Repository path for the SDE agent to work in (agent_session_message's workspacePath) */
  repoPath?: string;
  /** Project repo path where Work Items live (stored in session DB for orchestration notifications) */
  projectRepoPath?: string;
  /** Override LLM model (defaults to OS agent's model) */
  model?: string;
  /** Override account ID (defaults to OS agent's account) */
  accountId?: string;
  /** Session name override */
  name?: string;
  /** Linked work item short ID (e.g. "PROJ-0042") */
  workItemId?: string;
  /** Agent role in the work item lifecycle */
  agentRole?: AgentRole;
  /** Agent mode (build, review, plan, explore). Defaults to "build" if not set. */
  mode?: string;
  /** Project slug for direct work item lookup in the backend project store */
  projectSlug?: string;
  /** ID of the AgentDefinition to use for this session */
  agentDefinitionId?: string;
  /**
   * When set, creates a CLI agent session instead of a Rust agent session.
   * Serialised as `platform` in the Rust `cli_agent_create` wire format.
   */
  cliAgentType?: string;
  /** "own_key" | "hosted_key" — billing source for the session */
  keySource?: string;
  /** Marketplace listing model ID (hosted_key sessions) */
  listingModel?: string;
  /** Marketplace listing provider type (hosted_key sessions) */
  listingModelType?: string;
  /** Marketplace price tier (hosted_key sessions) */
  tier?: string;
  /** Source session when this run is forked from imported or compacted history. */
  parentSessionId?: string;
}

export interface SessionMergeParams {
  /** Target session ID */
  sessionId: string;
  /** Merge strategy: "auto" | "leave" | "ff" */
  strategy?: "auto" | "leave" | "ff";
}

export interface SessionMergeResult {
  merged: boolean;
  branch: string;
  baseBranch: string;
  conflicts: string[];
  error?: string;
}

export interface SessionSendMessageParams {
  /** Target session ID */
  sessionId: string;
  /** Message content */
  content: string;
  /**
   * Pill-format display text from the frontend composer (e.g.
   * `"create-skill [skill:/create-skill]"`). When set, the backend stores
   * this as the event's display_text so that re-editing a historical message
   * re-populates the pill rather than the expanded YAML / skill content.
   */
  displayText?: string;
  /** Optional model override for OS Agent sessions (mid-session switching) */
  model?: string;
  /** Optional account ID for OS Agent sessions */
  accountId?: string;
  /** Optional agent mode for SDE sessions (build/plan/explore) */
  mode?: string;
  /** Base64 image data URLs attached to this message. */
  imageDataUrls?: string[];
  /** Client-side idempotency key used to suppress duplicate sends. */
  clientMessageId?: string;
  /**
   * Canonical user-intent id minted at the FE submit boundary.
   * Passed to `agent_send_message` so the backend wire layer, scheduler,
   * persisted user_message event, and `session_turn_intents` lifecycle
   * row all observe the same logical identity.
   */
  turnIntentId?: string;
  /**
   * When `true`, this is a user-initiated Resume after a failed turn.
   * Backend runs deletion-based orphan tool-use filter.
   */
  isResume?: boolean;
}

export interface SessionAnswerQuestionParams {
  /** Target session ID */
  sessionId: string;
  /** Question ID to answer */
  questionId: string;
  /** User's answer */
  answer: string;
}

export interface SessionPauseResumeParams {
  /** Target session ID */
  sessionId: string;
}

export interface SessionCancelParams {
  /** Target session ID */
  sessionId: string;
  /** Force cancel (skip graceful shutdown) */
  force?: boolean;
}

export interface SessionInterruptParams {
  /** Target session ID */
  sessionId: string;
  /** Explicit reason controlling backend turn-boundary effects. */
  reason: CancelReason;
  /** Optional error callback for non-fatal errors (shown as toasts). */
  onError?: (msg: string) => void;
}

export interface SessionResumeCliParams {
  /** Target session ID (CLI sessions only) */
  sessionId: string;
  /** Optional error callback for non-fatal errors (shown as toasts). */
  onError?: (msg: string) => void;
}

export interface SessionGetStatusParams {
  /** Target session ID */
  sessionId: string;
}

export interface SessionListParams {
  /** Filter by status */
  status?: string;
  /** Filter by repository path (absolute path on disk) */
  repoId?: string;
  /** Maximum results */
  limit?: number;
}

export interface SessionOpenParams {
  /** Target session ID */
  sessionId: string;
}

// ============================================
// Result Types
// ============================================

export interface SessionInfo {
  sessionId: string;
  name: string;
  status: string;
  category: DispatchCategory;
  createdAt: string;
  updatedAt: string;
  repoName?: string;
  branch?: string;
  pendingQuestionsCount?: number;
  userInput?: string;
}

export interface SessionStatusInfo {
  sessionId: string;
  status: string;
  waitingFor?: string | null;
  pendingQuestions?: Array<{
    questionId: string;
    questionText: string;
    rationale?: string;
  }>;
  pendingQuestionsCount?: number;
}
