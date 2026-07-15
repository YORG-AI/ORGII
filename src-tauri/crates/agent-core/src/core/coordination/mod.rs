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
pub mod agent_org_plan_approvals;
pub mod agent_org_runs;
pub mod agent_org_tasks;
pub mod agent_org_watchdog;
pub mod routine_scheduler;
pub mod work_item_recovery;
pub mod work_item_scheduler;
