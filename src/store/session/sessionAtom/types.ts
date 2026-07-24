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
import type { ImportedHistorySourceId } from "@src/types/session/externalHistory";
import type {
  PendingQuestion,
  SessionStatus,
} from "@src/types/session/session";

// Re-export canonical types
export type { SessionStatus, PendingQuestion };

/**
 * Source-owned identity retained for display after a teammate session is
 * imported as a read-only replay. This is intentionally separate from the
 * imported Session's runnable configuration: `Session.model` remains unset so
 * the fork composer asks the viewer which local model/account to use.
 */
export interface SessionSourceDisplayMetadata {
  cliAgentType?: string;
  agentDisplayName?: string;
  agentDefinitionId?: string;
  model?: string;
}

/**
 * Provenance + consumer-side sync cursor for sessions imported from a
 * collaboration org (design §7.4 / §16.7). Lives on the Session record as a
 * first-class field — it replaces the legacy collab idiom of JSON-encoding
 * this metadata into `error_message` (the file-import path in
 * sessionImportExport.ts still uses that idiom and is out of scope here).
 *
 * `Session.orgId` and `importedFrom.orgId` coexist deliberately: `orgId` is
 * ownership (guest imports have none), `importedFrom.orgId` is origin.
 */
export interface SessionImportedFrom {
  orgId: string;
  sourceSessionId: string;
  /**
   * Normalized cloud deployment that owns the source row. Import identity is
   * `(endpoint, orgId, sourceSessionId)`, never just the latter two.
   */
  sourceEndpointUrl?: string;
  ownerMemberId: string;
  /** Segments epoch last applied locally. 0 = legacy snapshot import. */
  epoch: number;
  /** Frozen segment seq last applied locally. */
  seq: number;
  /** Total event count last applied locally. */
  count: number;
  /**
   * Events covered by the frozen region — the local frozen/tail boundary,
   * needed to replace only the tail region on incremental pulls. Optional:
   * absent (legacy cursor) forces a full refetch.
   */
  frozenCount?: number;
  /** segment_hash of the last applied tail segment (tail-change detection). */
  tailHash?: string;
  /** Display convenience carried over from the remote metadata. */
  ownerDisplayName?: string;
  /** Optional profile image carried over from the remote metadata. */
  ownerAvatarUrl?: string;
  /** Original read-only adapter when the shared source came from another app. */
  externalHistorySource?: ImportedHistorySourceId;
  /** Display-only source identity; never used as fork execution authority. */
  sourceDisplay?: SessionSourceDisplayMetadata;
  importedAt?: string;
  /** Share-link capability used for a later guest fork; absent for member imports. */
  shareToken?: string;
  /**
   * Non-secret Supabase origin that issued `shareToken`. A later guest fork
   * resolves and fetches against this same deployment instead of whichever
   * cloud happens to be active then. No anon key or user credential is stored.
   */
  shareEndpointUrl?: string;
}

/**
 * Fork provenance (design §16.11, "fork & continue"). DISTINCT from
 * `SessionImportedFrom`: an imported session is a READ-ONLY replay copy with a
 * consumer-side sync cursor, while a forked session is a normal WRITABLE
 * single-writer session that merely records where its inherited history came
 * from. It carries no cursor — after the fork the source and the fork diverge
 * by design (relay = a chain of single-writer sessions, not multi-writer).
 *
 * Deliberately NOT consulted by `isSessionPushAllowed`: a fork has neither
 * `category === "external_history"` nor `importedFrom`, so the member's
 * continuation syncs back to the org under their OWN member id.
 */
export interface SessionForkedFrom {
  orgId: string;
  sourceSessionId: string;
  ownerMemberId: string;
  ownerDisplayName: string;
  /** Event count inherited from the source at fork time. */
  atCount: number;
  forkedAt: string;
  /**
   * Denormalized ancestor: the ORIGINAL (non-fork) session this chain grew
   * from — inherited from the source's own lineage at fork time, so a
   * fork-of-a-fork still points at the root without any client walking the
   * chain. Denormalized on purpose: intermediate parents can fall out of the
   * cloud retention window, but thread grouping keyed on the root survives.
   * Absent on pre-lineage forks ⇒ treat sourceSessionId as the root.
   */
  rootSessionId?: string;
}

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
  /** Backend-computed display label for list/search surfaces. */
  displayLabel?: string;
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
  /**
   * Canonical Git worktree root discovered for imported history. `repoPath`
   * remains the original working folder captured by the source application.
   */
  repoRootPath?: string;
  /** Raw cached Git remotes for imported history; normalized at scope use. */
  repoRemoteUrls?: string[];
  /** Path to the file or directory where this session's persisted data lives. */
  storagePath?: string;
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
  /** True for imported history rows that cannot be written back. */
  readOnly?: boolean;
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
  /**
   * Set on sessions imported from a collaboration org (auto-import or
   * direct replay). Doubles as the consumer-side segments cursor.
   * Sessions carrying this field are never eligible for collab push.
   */
  importedFrom?: SessionImportedFrom;
  /**
   * Set on sessions created via "fork & continue" from a teammate's shared
   * session (design §16.11). Pure provenance — the session stays writable,
   * runnable, and collab-push-eligible (unlike `importedFrom`). Round-trips
   * through the persisted session list (plain JSON, no schema strip — see
   * `persistence.ts`, which only removes the volatile draft fields).
   */
  forkedFrom?: SessionForkedFrom;
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
  /** Total token usage (input + output) reported by the source, when known. */
  totalTokens?: number;
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
