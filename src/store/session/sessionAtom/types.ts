/**
 * Session Types
 *
 * Core type definitions for session data used across the application.
 *
 * NOTE: SessionStatus and PendingQuestion are canonical in @src/types/session/session.ts
 * Re-exported here for convenience in store consumers.
 */
import type { AgentRole } from "@src/api/http/project";
import type {
  CliAgentType,
  MergeStatus,
  PriceTier,
} from "@src/api/tauri/rpc/schemas/validation";
import type {
  DispatchCategory,
  KeySource,
} from "@src/api/tauri/session/dispatchTypes";
import type {
  PendingQuestion,
  SessionStatus,
} from "@src/types/session/session";

// Re-export canonical types
export type { SessionStatus, PendingQuestion };

export interface Session {
  session_id: string;
  status: SessionStatus | string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  pending_questions?: PendingQuestion[];
  pending_questions_count?: number;
  error_message?: string;
  user_input?: string;
  repo_name?: string;
  name?: string;
  branch?: string;
  is_active?: boolean;
  /** Session category: CLI-based agent or Rust-native agent */
  category?: DispatchCategory;
  /** CLI agent type: "cursor_cli", "claude_code", "copilot", "codex" (CLI sessions only) */
  cliAgentType?: CliAgentType;
  /** LLM model used: "claude-3.5-sonnet", "gpt-4o", etc. */
  model?: string;
  keySource?: KeySource;
  /** Selected code account ID (own_key sessions) */
  accountId?: string;
  /** Price tier for market sessions */
  tier?: PriceTier;
  /** Process ID of the running agent (null if never started) */
  pid?: number | null;
  /**
   * The session's persisted workspace root, captured at create time from
   * `SessionLaunchParams.workspacePath`. This is the **session-scoped**
   * workspace root the dispatcher must prefer when sending a message;
   * the global repo selection atom is only a fallback for older rows. Mirrors
   * the `repo_path` column on `agent_sessions` / `code_sessions`.
   */
  repoPath?: string;
  /** Worktree path for isolated parallel sessions */
  worktreePath?: string;
  /** Branch name inside the worktree (e.g. `agent/abc123`) */
  worktreeBranch?: string;
  /** Base branch the worktree was created from */
  baseBranch?: string;
  /** Merge status: pending, merged, conflict, skipped */
  mergeStatus?: MergeStatus;
  /** Whether this session was launched in background ("fire and forget") mode */
  background?: boolean;
  /** Owning project/collaboration org ID for this session. */
  orgId?: string;
  /** Linked project ID, when the session is scoped below an org. */
  projectId?: string;
  /** Linked project display name, when available from launch/readback context. */
  projectName?: string;
  /** Linked project slug, when the session is scoped below a project/work item. */
  projectSlug?: string;
  /** Linked work item short ID (e.g. "PROJ-0042") */
  workItemId?: string;
  /** Agent role in the work item lifecycle */
  agentRole?: AgentRole | string;
  /** Parent/root session id for child sessions such as Agent Team member sessions. */
  parentSessionId?: string;
  /** Agent Team roster member id for team member session rows. */
  orgMemberId?: string;
  /** Agent Team definition id for root/coordinator rows launched from a team. */
  agentOrgId?: string;
  /** Agent Team display name for root/coordinator rows launched from a team. */
  agentOrgName?: string;
  /** Rust-native agent definition ID returned by the backend. */
  agentDefinitionId?: string;
  /** Rust-resolved agent icon ID for Rust-native sessions. */
  agentIconId?: string;
  /** Rust-resolved agent display name for Rust-native sessions. */
  agentDisplayName?: string;
  /**
   * Per-session execution mode (Rust-agent sessions only).
   *
   * `undefined` means the user has never patched this session — UI
   * components fall back to `creatorDefaultExecModeAtom` until the
   * first ModePill click, which calls `rpc.sessionAggregate.patch`
   * and writes the value here. CLI sessions always have `undefined`.
   *
   * Source of truth lives in the Rust `agent_sessions.agent_exec_mode`
   * column; this field is the camelCase mirror exposed via
   * `SessionAggregateRecord`.
   */
  agentExecMode?: string;
  /**
   * Per-session unsent draft text (P3). The text the user has typed
   * into the chat composer for this session but not yet sent. `undefined`
   * means "no draft" — the composer renders empty. Mirrors the
   * `draft_text` column on `agent_sessions` / `code_sessions`.
   */
  draftText?: string;
  /**
   * Per-session reply target event id (P3). The agent_messages /
   * chunk id the user has currently pinned via the chat item's "Reply"
   * action. `undefined` means no reply banner is open.
   */
  replyTargetEventId?: string;
  /** Whether this session is pinned to the top of the sidebar. */
  pinned?: boolean;
  created_time?: string;
  updated_time?: string;
  /** Source-cache impact stat for external and Rust-native sessions. */
  filesChanged?: number;
  /** Source-cache impact stat for external and Rust-native sessions. */
  linesAdded?: number;
  /** Source-cache impact stat for external and Rust-native sessions. */
  linesRemoved?: number;
  /** Source-cache touched file list for external and Rust-native sessions. */
  touchedFiles?: string[];
  /** Channel origin for OS Agent sessions (e.g. "feishu", "telegram", "discord"). */
  channel?: string;
}

// ============================================
// Session Record Types (from Tauri backend)
// ============================================

/**
 * Base session record - shared fields across all session types
 */
export interface BaseSessionRecord {
  sessionId: string;
  name: string;
  status: string;
  model: string | null;
  userInput: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * CLI session record from Tauri backend (`code_sessions` table / `cli_sessions` module)
 */
export interface CliSessionRecord extends BaseSessionRecord {
  keySource: KeySource;
  cliAgentType: CliAgentType | null;
  tier: PriceTier | null;
  accountId: string | null;
  repoPath: string | null;
  branch: string | null;
  pid: number | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseBranch: string | null;
  mergeStatus: MergeStatus | null;
  background: boolean;
  totalTokens: number;
}

export interface SessionGroups {
  active: Session[];
  completed: Session[];
  failed: Session[];
}
