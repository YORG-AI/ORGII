/**
 * Typed constants for Work Item orchestration domain values.
 *
 * Replaces hardcoded string literals scattered across orchestrator hooks,
 * adapters, and UI components.
 */

export const ORCHESTRATOR_PHASE = {
  Idle: "idle",
  Coding: "coding",
  Sde: "sde",
  Review: "review",
  FollowUp: "follow_up",
  Completed: "completed",
  Failed: "failed",
  AwaitingUser: "awaiting_user",
} as const;

export type OrchestratorPhase =
  (typeof ORCHESTRATOR_PHASE)[keyof typeof ORCHESTRATOR_PHASE];

export const TERMINAL_PHASES: ReadonlySet<OrchestratorPhase> = new Set([
  ORCHESTRATOR_PHASE.Idle,
  ORCHESTRATOR_PHASE.Completed,
  ORCHESTRATOR_PHASE.Failed,
  ORCHESTRATOR_PHASE.AwaitingUser,
]);

export const ACTIVE_PHASES: ReadonlySet<OrchestratorPhase> = new Set([
  ORCHESTRATOR_PHASE.Coding,
  ORCHESTRATOR_PHASE.Sde,
  ORCHESTRATOR_PHASE.Review,
  ORCHESTRATOR_PHASE.FollowUp,
]);

export const AGENT_ROLE = {
  Coding: "coding",
  Sde: "sde",
  Review: "review",
  FollowUp: "follow_up",
} as const;

export type AgentRole = (typeof AGENT_ROLE)[keyof typeof AGENT_ROLE];

export function toAgentRole(role: string | null | undefined): AgentRole | null {
  if (
    role === AGENT_ROLE.Coding ||
    role === AGENT_ROLE.Sde ||
    role === AGENT_ROLE.Review ||
    role === AGENT_ROLE.FollowUp
  ) {
    return role;
  }
  return null;
}

export const SESSION_STATUS = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const satisfies Record<
  string,
  import("@src/types/session/session").SessionStatus
>;

export const PENDING_SESSION_ID = "pending";

/**
 * Default OrchestratorConfig — single source of truth.
 * Import this instead of duplicating inline defaults.
 */
export const DEFAULT_ORCHESTRATOR_CONFIG = {
  review_enabled: false,
  follow_up_enabled: false,
  auto_retry_on_failure: false,
  max_retry_count: 2,
  auto_create_pr: true,
} as const;
