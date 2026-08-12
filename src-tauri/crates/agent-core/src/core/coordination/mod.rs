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
pub mod child_done_wake;
pub mod routine_scheduler;
pub mod work_item_recovery;
pub mod work_item_run_dispatcher;
pub mod work_item_scheduler;

/// Initialize the complete durable Agent Org runtime schema in dependency
/// order. Production and sandbox test entry points share this registry so a
/// newly-added recovery table cannot silently exist in only one environment.
pub fn init_agent_org_schemas(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    agent_org_runs::init_schema(conn)?;
    agent_inbox::init_schema(conn)?;
    agent_org_tasks::init_schema(conn)?;
    agent_org_plan_approvals::init_schema(conn)?;
    agent_member_interventions::init_schema(conn)?;
    agent_org_watchdog::init_schema(conn)?;
    Ok(())
}
