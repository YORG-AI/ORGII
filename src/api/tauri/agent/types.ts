/**
 * Agent API Types
 *
 * Shared types for all agent Tauri commands.
 */
import type { WorkspaceSnapshot } from "@src/services/context/workspaceSnapshot";
import type { SessionStatus } from "@src/types/session/session";

export const RUST_AGENT_TYPE = {
  OS: "os",
  SDE: "sde",
  WINGMAN: "wingman",
  CUSTOM: "custom",
} as const;

export type RustAgentType =
  (typeof RUST_AGENT_TYPE)[keyof typeof RUST_AGENT_TYPE];

export type AgentToolFilter =
  | typeof RUST_AGENT_TYPE.OS
  | typeof RUST_AGENT_TYPE.SDE;

export type PermissionResponseValue = "allow" | "deny" | "always_allow";

export type ModeSwitchChoice = "switch" | "skip";

export type PlanApprovalChoice = "approve" | "approve_with_edits" | "reject";

export type FileResolutionValue = "accepted" | "rejected" | "reverted";

/** Metadata row from `agent_list_modes` (Rust `AgentExecMode` catalog). */
export interface AgentExecModeConfig {
  id: string;
  name: string;
  description: string;
}

export interface AgentStatusInfo {
  running: boolean;
  gatewayRunning: boolean;
  activeSessions: number;
  sessionIds: string[];
}

export interface RedoSnapshotAnchorRecord {
  sessionId: string;
  snapshotId: string;
  createdAt: string;
}

export interface RevertResult {
  reverted: number;
  restored: number;
  deleted: number;
  skipped: number;
  failed: number;
  createdAt?: string;
  redoAnchors?: RedoSnapshotAnchorRecord[];
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  isSingleton: boolean;
}

export type ManualCompactStatus =
  | "compacted"
  | "too_short"
  | "already_compact"
  | "busy"
  | "no_runtime"
  | "channel_attached"
  | "failed";

export interface ManualCompactBoundary {
  id: string;
  content: string;
  createdAt: string;
}

export interface ManualCompactResult {
  status: ManualCompactStatus;
  message?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  /** Set on `compacted`: persisted boundary row for in-place chat append. */
  boundary?: ManualCompactBoundary;
}

export type HousekeeperContextCompactionStatus =
  | "disabled"
  | "idle"
  | "running"
  | "complete"
  | "error"
  | "unavailable"
  | "busy";

export interface HousekeeperContextCompactionState {
  enabled: boolean;
  status: HousekeeperContextCompactionStatus;
  coveredMessages: number;
  sourceTokens: number;
  summaryTokens: number;
  lastRunAt?: string;
  lastError?: string;
  message?: string;
}

export interface AgentMessageResponse {
  content: string;
  sessionId: string;
  model: string;
}

export interface GatewayStatus {
  running: boolean;
  activeSessions: number;
}

export interface MessageParams {
  sessionId: string;
  content: string;
  model?: string;
  accountId?: string;
  workspacePath?: string;
  mode?: string;
  images?: string[];
  ideContext?: WorkspaceSnapshot;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  createdAt: string;
  /** Non-null on compact-boundary rows: sequence the compacted tail starts at. */
  compactFromSequence?: number | null;
}

export interface QuestionResponseParams {
  requestId: string;
  answer: string;
  sessionId?: string;
}

export interface PermissionResponseParams {
  requestId: string;
  approved: boolean;
  sessionId?: string;
  reason?: string;
}

export interface ModeSwitchResponseParams {
  requestId: string;
  approved: boolean;
  sessionId: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options?: string[];
  timestamp: string;
}

export interface TodoItem {
  id: string;
  content: string;
  /**
   * Present-continuous label shown while this todo is `in_progress`
   * (e.g. "Running tests" for a content of "Run tests"). Ported from
   * Claude Code V2 Task tools. Optional — if missing, UI falls back to
   * `content`.
   */
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface SessionMeta {
  sessionId: string;
  name?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  workspacePath?: string;
  model?: string;
  accountId?: string;
  workItemId?: string;
  projectSlug?: string;
  agentDefinitionId?: string;
  userInput?: string | null;
  totalTokens?: number;
  /** Error message from the last failed turn, if any. */
  errorMessage?: string | null;
}

export interface SnapshotRecord {
  sessionId: string;
  toolCallId: string;
  hash: string;
  createdAt: string;
}

export interface SessionFileRecord {
  path: string;
  count: number;
  additions: number;
  deletions: number;
  lineCount: number;
}

export interface FileResolution {
  path: string;
  resolution: FileResolutionValue;
}

/**
 * Wire format for a single desktop permission row returned by
 * `agent_check_desktop_permissions` / `agent_request_desktop_permissions`.
 *
 * `name` is constrained to {@link DesktopPermissionName}; the backend
 * mirror is `DesktopPermissionName` in
 * `src-tauri/src/agent_core/state/commands/desktop.rs`.
 *
 * `grantInstructions` is supplied by the backend and is platform-localized;
 * the frontend should prefer it over hand-rolled English copy.
 */
export interface DesktopPermission {
  name: DesktopPermissionName;
  granted: boolean;
  required: boolean;
  grantInstructions?: string;
}

/** Source of truth for the permission names exchanged over the wire. */
export const DESKTOP_PERMISSION = {
  ACCESSIBILITY: "Accessibility",
  SCREEN_RECORDING: "Screen Recording",
} as const;

export type DesktopPermissionName =
  (typeof DESKTOP_PERMISSION)[keyof typeof DESKTOP_PERMISSION];

export interface AutomationRule {
  id: string;
  name: string;
  trigger: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
}
export type SlashItemCategory = "skill" | "action" | "command";

export interface SlashItem {
  name: string;
  description: string;
  category: SlashItemCategory;
  source: string;
  acceptsArgs: boolean;
}
