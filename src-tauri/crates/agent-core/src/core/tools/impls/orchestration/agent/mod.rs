//! Unified `agent` tool — single entry point for Delegate and Shadow workers.
//!
//! Replaces three older execution paths:
//! - built-in worker dispatch (explore / generalPurpose)
//! - named org-agent spawning with instance limits
//! - specialist-agent delegation with fresh registries
//!
//! Dispatch strategy: every worker inherits the parent's `ToolRegistry`
//! and applies the agent's `AgentToolSelection` as a policy overlay. The
//! hard-deny layer (`subagent_forbidden_tools`) always sits on top of the
//! agent's own selection so, e.g., `agent` / `send_message` can never be
//! exposed to a worker regardless of definition.
//!
//! `AgentToolSelection` combination rules (see design doc §4):
//! - `system_restrict_to_tools = None` → inherit everything minus
//!   `excluded_tools` (e.g. `builtin:general`). Any user additions in
//!   `user_allowed_tools` are no-ops in this mode.
//! - `system_restrict_to_tools = Some(list)` → strict allowlist
//!   (e.g. `builtin:explore`, memory workers). The resolver merges
//!   `user_allowed_tools` on top of this list (capability-gated) and
//!   honours `excluded_tools` from either source.
//!
//! `manage_agent_def` is a management-capability tool for
//! OS/coordinator-style sessions, not a default SDE worker tool.

mod authorization;
mod background;
mod dispatch;
mod foreground;
/// `pub mod` only to expose helpers to `app::api::agent::test::core`
/// debug routes via `agent_core::debug::*`. `#[doc(hidden)]` keeps
/// the surface out of rustdoc; the underlying items are otherwise
/// internal to `agent_core`.
#[doc(hidden)]
pub mod helpers;
mod launch_plan;
mod linked_session;
mod messages;
mod persistence;
mod policy;
mod request;
mod schema;
mod state;
mod system_prompt;
mod workspace;

#[cfg(test)]
mod tests;

pub use state::{AgentTool, AgentToolConfig};

// Re-exported with `#[doc(hidden)]` so the `app` crate's debug routes
// can reach them via `agent_core::debug::*`. Not part of agent_core's
// documented public API.
#[doc(hidden)]
pub use helpers::{
    background_launch_message, looks_like_valid_subagent_session_id, org_roster_spawn_rejection,
    resolve_agent_id_for_execute, subagent_of_subagent_rejection, subagent_type_label,
    ResolvedAgentId,
};

#[doc(hidden)]
pub use schema::llm_visible_agent_ids;
