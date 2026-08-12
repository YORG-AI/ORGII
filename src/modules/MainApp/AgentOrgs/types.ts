/**
 * Agent & Team types for the Agent Teams page.
 *
 * Automation/policy types live in:
 *   @src/modules/MainApp/Integrations/RulesMemoryEvolution/types.ts
 *
 * CLI agent metadata (display name, docs URL, compatible providers, etc.)
 * comes from the Rust backend via `get_available_agents`.
 */
import type {
  ModelType,
  NativeHarnessType,
} from "@src/api/tauri/rpc/schemas/validation";
import type { KeySource } from "@src/api/tauri/session/dispatchTypes";

export type { AvailableAgent as AvailableCliAgent } from "@src/config/cliAgents";

export type AgentOrgsTab = "org" | "agents" | "integrations";

// ── Sub-agent references ──

export const SUB_AGENT_ISOLATION = {
  WORKTREE: "worktree",
} as const;

export type SubAgentIsolation =
  (typeof SUB_AGENT_ISOLATION)[keyof typeof SUB_AGENT_ISOLATION];

/** Reference to another agent that can be spawned as a sub-agent */
export interface SubAgentRef {
  /** ID of the target AgentDefinition */
  agentId: string;
  isolation?: SubAgentIsolation;
}

// ── Skills configuration ──

export interface AgentSkillsConfig {
  enabled?: boolean;
  /**
   * Optional whitelist of skill IDs. When present and non-empty, the
   * Rust prompt builder restricts skill listing to this subset; when
   * absent, every enabled skill is offered. Optional so callers can
   * patch `exclude` without being forced to send an empty array.
   */
  include?: string[];
  exclude: string[];
  /** Additional read-only skill directories or built-in source identifiers. */
  sourceDirs?: string[];
}

// ── Tool selection ──

/**
 * Unified tool selection for an agent definition. Mirrors Rust
 * `AgentToolSelection`. Three orthogonal axes:
 *
 * - `systemRestrictToTools` — system-pinned allowlist authored by builtin
 *   definitions (Wingman / explore / memory_*). Read-only in the UI.
 *   `null` means "no system restriction".
 * - `userAllowedTools` — user additions on top of the system set.
 *   Can restore system-restricted tools, but cannot cross capability
 *   boundaries at resolve time. Default `[]`.
 * - `excludedTools` — user subtractions; honoured regardless of which set
 *   the tool came from.
 *
 * MCP toggles (`disabledMcpServers`, `disabledMcpTools`) are independent.
 */
export interface AgentToolSelection {
  systemRestrictToTools?: string[] | null;
  userAllowedTools?: string[];
  excludedTools?: string[];
  disabledMcpServers?: string[];
  disabledMcpTools?: string[];
}

// ── Security configuration ──

export type AutonomyLevel = "readonly" | "full";

export interface CommandRiskRules {
  medium?: string[];
  high?: string[];
}

/** Per-agent unified policy. Mirrors the backend Rust `AgentPolicy`
 *  struct field-for-field. The runtime fields (`confirmation_commands`,
 *  `block_high_risk_commands`) are policy invariants
 *  supplied at session launch and intentionally not editable per agent.
 *
 *  Tool allow/deny is NOT carried here — it lives entirely on
 *  `AgentDefinition.tools.excludedTools` (per-agent name-based deny)
 *  and the runtime `AutonomyLevel.ask_tools()` (Ask gating). */
export interface AgentPolicy {
  /** Agent autonomy level */
  autonomy?: AutonomyLevel;
  /** Restrict file/shell access to workspace only */
  workspaceOnly?: boolean;
  /** Commands always blocked (blacklist) */
  blockedCommands?: string[];
  /** Filesystem paths that file and shell tools cannot access */
  forbiddenPaths?: string[];
  /** User-configurable always-ask/block shell command policy rules */
  riskRules?: CommandRiskRules;
}

// ── Agent tier ──

export const AGENT_TIERS = ["primary", "secondary"] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];

// ── Agent definitions ──

/** Capability set — defines what an agent can do.
 *
 * Mirrors the trimmed Rust `CapabilitySet`: gateway / data / management
 * are flag-only buckets, `desktop` carries a single `enabled` toggle,
 * `coding` exposes `modeSwitch`, and `browser` distinguishes external
 * vs internal. Anything not listed here is intentionally out of scope.
 */
export interface CapabilitySet {
  gateway?: Record<string, never>;
  coding?: { modeSwitch: boolean };
  desktop?: { enabled: boolean };
  browser?: { external: boolean; internal: boolean };
  data?: Record<string, never>;
  management?: Record<string, never>;
}

/**
 * Compaction config — mirrors Rust `CompactionConfig` in
 * `src-tauri/src/agent_core/core/model_context/compaction.rs`. All fields
 * are optional on the wire; missing fields fall back to Rust serde defaults.
 */
export interface CompactionConfig {
  enabled?: boolean;
  triggerRatio?: number;
  keepRatio?: number;
  /** Override summarization model (empty / null = use the agent's main model). */
  model?: string | null;
  summaryMaxTokens?: number;
  minMessages?: number;
  floorTokens?: number;
  reservedSummaryTokens?: number;
  bufferTokens?: number;
}

/** Session model — controls how agent sessions are managed */
export interface SessionModel {
  mode: string;
  compaction?: CompactionConfig;
  processingLock: boolean;
  maxIterations: number;
}

/**
 * Delegation configuration. Iteration caps live on
 * `SessionModel.maxIterations` (which the turn processor consumes);
 * delegation purely toggles whether this agent can be spawned as a
 * sub-agent and which context builders run for it.
 */
export interface DelegationConfig {
  delegatable: boolean;
  contextBuilders: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  builtIn: boolean;
  /** Tier classification: primary (core) or secondary (supporting) */
  tier?: AgentTier;
  /** Parent template to inherit from (e.g. "builtin:sde") */
  inheritsFrom?: string | null;
  /** Capability set — defines what this agent can do */
  capabilities?: CapabilitySet | null;
  /** Session model — controls how sessions are managed */
  sessionModel?: SessionModel | null;
  /** Context window override (0 = auto) */
  contextWindow?: number;
  /** Max response tokens */
  maxTokens?: number;
  /** Sampling temperature (0–2) */
  temperature?: number;
  /** Per-agent personality and communication style.
   *  Flows into the prompt `identity` section (orderHint 10) for every
   *  session of this agent.
   *  NOTE: context compaction lives on `sessionModel.compaction`
   *  (matches the Rust wire shape). Top-level `compaction` is not
   *  a backend field and previous writes there were silently dropped. */
  soulContent?: string;
  /** Agents that can be spawned as sub-agents during execution */
  subAgents?: SubAgentRef[];
  /** Per-turn concurrent read-only tool/sub-agent tool-use hard cap. */
  maxToolUseConcurrency?: number | null;
  /** Tool selection — allowlist + blacklists. See `AgentToolSelection`. */
  tools?: AgentToolSelection;
  /** Load workspace-scoped skills, MCP servers, and plugins. Missing resolves to enabled. */
  loadWorkspaceResources?: boolean;
  /** Load workspace-scoped rules. Missing resolves to enabled. */
  loadWorkspaceRules?: boolean;
  /** Per-agent skills configuration */
  skillsConfig?: AgentSkillsConfig;
  /** Preferred code account for this agent. None = inherit from work item config. */
  selectedAccountId?: string;
  /** Preferred model for this agent. None = inherit from work item config. */
  selectedModelId?: string;
  /** Per-agent unified policy (security autonomy + tool rules).
   *  Wire field name matches Rust `AgentDefinition.agent_policy`. */
  agentPolicy?: AgentPolicy;
  /** Delegation configuration */
  delegationConfig?: DelegationConfig | null;
  /** Icon identifier resolved to a React component by the frontend */
  iconId?: string;
  /** When true, prompt builder injects only soul + minimal meta sections
   *  (use for self-contained roles like the gateway router). */
  sovereignPrompt?: boolean;
  /** Enable animation in UI (OS-only). */
  animate?: boolean;
  /** Coding-tool dispatch mode (`Direct` vs `WorkStation`).
   *  Type-narrowed in `src/api/tauri/agent/config.ts` callers. */
  executionMode?: string;
  /** Per-agent L3 learnings policy. */
  learnings?: AgentLearningsConfig;
  /** Provider reliability settings (retry, fallback chain). */
  reliability?: ReliabilityConfig;
  /** Per-agent shell/subprocess timeout in seconds. `null`/missing = inherit
   *  the resolver default (60s for OS, 120s for SDE). Consumed by the Exec
   *  tool via `ResolvedAgent.exec_timeout`. */
  execTimeout?: number | null;
}

/** Per-agent L3 learnings policy. Mirrors Rust `AgentLearningsConfig`. */
export interface AgentLearningsConfig {
  enabled?: boolean;
  extractMemoriesEnabled?: boolean;
  autoDreamEnabled?: boolean;
}

/** Provider reliability config. Mirrors Rust `ReliabilityConfig`. */
export interface ReliabilityConfig {
  maxRetries?: number;
  baseBackoffMs?: number;
  fallbackModels?: string[];
}

// ── CLI agent types (installed CLI coding agents) ──

/** Prefix used in selectedAgentId to distinguish CLI agents from built-in/custom */
export const CLI_AGENT_PREFIX = "cli:";

// ── Flat Team definitions ──

/** Who decides whether a plan produced by an Agent Org planning task is ready. */
export const PLAN_APPROVAL_POLICIES = [
  "coordinator",
  "user",
  "automatic",
] as const;
export type PlanApprovalPolicy = (typeof PLAN_APPROVAL_POLICIES)[number];
export const DEFAULT_PLAN_APPROVAL_POLICY: PlanApprovalPolicy = "coordinator";

export interface OrgMemberRuntimeConfig {
  keySource?: KeySource;
  accountId?: string;
  model?: string;
  nativeHarnessType?: NativeHarnessType;
  tier?: string;
  listingModel?: string;
  listingModelDisplay?: string;
  listingModelType?: ModelType;
  selectedSourceLabel?: string;
  selectedSourceModelType?: ModelType;
}

export interface OrgMemberLaunchOverride {
  agentId?: string;
  runtimeConfig?: OrgMemberRuntimeConfig;
}

export interface FlatOrgMember {
  memberId: string;
  name: string;
  role: string;
  agentId: string;
  runtimeConfig?: OrgMemberRuntimeConfig;
}

export interface MemberCommunicationLink {
  memberAId: string;
  memberBId: string;
}

export interface OrgDefinition {
  id: string;
  name: string;
  role: string;
  agentId: string;
  description?: string;
  planApprovalPolicy: PlanApprovalPolicy;
  members: FlatOrgMember[];
  additionalTaskGraphWriterMemberIds: string[];
  memberCommunicationLinks: MemberCommunicationLink[];
}
