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
pub mod agent_org_archive;
#[cfg(test)]
mod agent_org_archive_tests;
pub(crate) mod agent_org_ownership;
pub mod agent_org_pause;
pub mod agent_org_payload_limits;
pub mod agent_org_plan_approvals;
pub mod agent_org_run_events;
pub mod agent_org_runs;
pub mod agent_org_tasks;
pub(crate) mod agent_org_tool_receipts;
pub(crate) mod agent_org_turn_contexts;
pub mod agent_org_watchdog;
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

/// Reconcile Agent Org-owned Turn lifecycle only after its companion schema
/// has been initialized and verified.
pub fn reconcile_agent_org_turns_after_restart(
    conn: &rusqlite::Connection,
) -> Result<usize, String> {
    let runtime_absence = agent_org_pause::reconcile_runtime_absence_after_restart(conn)?;
    let turn_reconciliation = agent_org_turn_contexts::reconcile_in_flight_after_restart(conn)?;
    Ok(runtime_absence + turn_reconciliation)
}
