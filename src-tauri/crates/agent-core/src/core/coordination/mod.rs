//! Typed Agent Org coordination runtime state.
//!
//! Module boundary:
//! - `definitions::orgs` — the **template**: who is the coordinator, who
//!   are the workers, what tools each role has. Edited by the user. Lives
//!   in JSON.
//! - `coordination::*` (this module) — the **runtime**: a concrete in-flight
//!   execution of a template, plus the typed messages exchanged inside it.
//!   Lives in SQLite.
//!
//! Submodules:
//! - `agent_org_runs` — durable envelope for one org execution
//!   (`AgentOrgRunRecord`, status lifecycle, root-session linkage).
//! - `agent_inbox` — typed inter-agent message primitives + persisted
//!   inbox table (`AgentMessage`, `AgentInboxStore`). Distinct from the
//!   user-facing `inbox` crate; see that module's doc for the contrast.
//! - `agent_org_tasks` — Agent Org task store (Task schema + atomic
//!   mutations). Backs the task system (`task_create` / `task_update` /
//!   `task_list` / `task_get` LLM tools and explicit coordinator
//!   assignment).

pub mod agent_inbox;
pub mod agent_member_interventions;
pub mod agent_org_payload_limits;
pub mod agent_org_plan_approvals;
pub mod agent_org_run_events;
pub mod agent_org_runs;
pub mod agent_org_tasks;
pub mod agent_org_watchdog;
pub mod availability;
pub mod child_done_wake;
pub mod routine_scheduler;
pub mod work_item_recovery;
pub mod work_item_run_dispatcher;
pub mod work_item_scheduler;

mod schema;

/// Initialize the complete durable Agent Org runtime schema in dependency
/// order. Production and sandbox test entry points share this registry so a
/// newly-added recovery table cannot silently exist in only one environment.
pub fn init_agent_org_schemas(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    schema::initialize(conn)
}

/// Production startup entry: initialize the namespace, scoping any failure
/// to the Agent Org surface instead of failing whole sessions.db init.
///
/// On coordinator failure the full diagnostic is logged at error level and
/// recorded in [`availability`]; every Agent Org store entry then returns
/// the structured "agent-org runtime unavailable" error while ordinary
/// chat (and the rest of sessions.db init) proceeds normally.
pub fn init_agent_org_schemas_scoped(conn: &rusqlite::Connection) {
    match schema::initialize(conn) {
        Ok(()) => availability::mark_agent_org_runtime_available(),
        Err(error) => {
            tracing::error!(
                event = "agent_org_runtime_namespace_unavailable",
                error = %error,
                "Agent Org runtime namespace init failed; Agent Org features are disabled for this process while ordinary chat continues"
            );
            availability::mark_agent_org_runtime_unavailable(error.to_string());
        }
    }
}
