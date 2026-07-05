import type {
  CliAgentType,
  ModelType,
  NativeHarnessType,
} from "@src/api/tauri/rpc/schemas/validation";
import type { KeySource } from "@src/api/tauri/session";
import type { OrgMemberLaunchOverride } from "@src/modules/MainApp/AgentOrgs/types";

/**
 * Session Creator Type Definitions
 */

// ============================================
// Repository Types
// ============================================

// ============================================
// File Upload Types
// ============================================

export interface UploadedFile {
  id: string;
  name: string;
  type: "text" | "image" | "document" | "folder";
  file?: File;
  /** File path for Tauri drops (used for image preview) */
  path?: string;
}

// ============================================
// Branch Types
// ============================================

export interface BranchOption {
  label: string;
  value: string;
}

export interface RepoBranchesMap {
  [repoId: string]: string;
}

export interface RepoBranchOptionsMap {
  [repoId: string]: BranchOption[];
}

// ============================================
// Session Configuration Types
// ============================================

export type TabType = "projects" | "repos";

export const SESSION_CREATOR_LAUNCH_MODE = {
  START_FOREGROUND: "start_foreground",
  START_BACKGROUND: "start_background",
} as const;

export type SessionCreatorLaunchMode =
  (typeof SESSION_CREATOR_LAUNCH_MODE)[keyof typeof SESSION_CREATOR_LAUNCH_MODE];

export type { KeySource };

/** Advanced configuration for session creation */
export interface AdvancedConfig {
  /**
   * Key source for billing (own key vs hosted key).
   * - "own_key": User's own API keys (BYOK)
   * - "hosted_key": Hosted ORGII key
   */
  keySource?: KeySource;
  provider?: string;
  model?: string;
  agent?: ModelType;
  branch?: string;
  /** Selected code account ID (when keySource="own_key") */
  selectedAccountId?: string;
  /** Rust Agent provider override for subscription-bound native harness sessions. */
  nativeHarnessType?: NativeHarnessType;
  /**
   * CLI agent type — the ModelType of the selected CLI agent (e.g. "claude_code", "cursor_cli").
   * Only set for CLI sessions (`DispatchCategory === "cli_agent"`).
   * Serialized as the `platform` key in the Rust `cli_agent_create` command.
   */
  cliAgentType?: CliAgentType;
  /** Per-session CLI launch argument override. Empty string explicitly clears defaults. */
  launchArgs?: string;
  /** Price tier for hosted_key sessions (e.g., "standard", "premium", "vip", "basic") */
  tier?: string;
  /** Hosted listing display name (when keySource is hosted) */
  listingName?: string;
  /** Hosted listing model/provider type — used for icon display (when keySource is hosted) */
  listingModelType?: ModelType;
  /** Hosted listing price info (when keySource is hosted) */
  listingPriceInfo?: string;
  /** Market listing model name for API (e.g., "auto") */
  listingModel?: string;
  /** Market listing model display name for UI (e.g., "Auto (Standard)") */
  listingModelDisplay?: string;
  /** Display label of the selected source (e.g. "My Anthropic Key", "Token Market", "Claude Code") */
  selectedSourceLabel?: string;
  /** Model/provider type of the selected source — used for icon display */
  selectedSourceModelType?: ModelType;
  /** Per-Agent-Team-member launch overrides keyed by team member id. */
  agentOrgMemberOverrides?: Record<string, OrgMemberLaunchOverride>;
  /** Persist Agent Team member overrides back to the team definition after successful launch. */
  applyAgentOrgMemberOverridesForFuture?: boolean;
}
