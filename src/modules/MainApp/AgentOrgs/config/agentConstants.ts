/**
 * Internal built-in agents that must never appear in user-facing pickers
 * or the tool-matrix.
 *
 * Two buckets:
 * 1. Delegation primitives (`builtin:explore`, `builtin:general`) — owned
 *    by the runtime (`agent_tool` schema fallback). Always reachable from
 *    every parent regardless of its `subAgents` list, so listing them in a
 *    picker would create a ghost knob.
 * 2. Internal templates / memory subsystem (`builtin:base`,
 *    `builtin:memory-extractor`, `builtin:memory-consolidator`) —
 *    inheritance scaffolding and background workers, never delegated to
 *    from a parent agent.
 *
 * Mirror of `SUBAGENT_FORBIDDEN_IDS` in
 * `src-tauri/crates/agent-core/src/core/definitions/builtin/mod.rs`.
 * Keep these two lists in sync whenever a new internal agent is added.
 */
export const INTERNAL_AGENT_IDS = new Set([
  "builtin:base",
  "builtin:ai-research",
  "builtin:explore",
  "builtin:general",
  "builtin:memory-extractor",
  "builtin:memory-consolidator",
  "builtin:wingman",
]);

/**
 * Maximum number of members in an Agent Team (coordinator excluded).
 *
 * Mirror of `MAX_AGENT_ORG_MEMBERS` in
 * `src-tauri/crates/agent-core/src/core/definitions/orgs.rs`.
 * Keep the two values in sync — the Rust validator is authoritative and
 * rejects definitions above this cap.
 */
export const MAX_AGENT_ORG_MEMBERS = 50;
