//! Agent Org watchdog: periodic stall detection and recovery.
//!
//! Every [`WATCHDOG_INTERVAL_SECS`] the watchdog scans running Agent Org
//! runs whose workers are all quiescent and produces a
//! [`StallRecoveryPlan`]:
//!
//! - **Wake members** that have durable input: unread inbox rows, a
//!   redelivered explicit assignment, or a concrete continuation message.
//!   Ownerless work and mere ownership are not wake signals: without real
//!   input they would create empty turns and UI flicker.
//! - **Escalate to the coordinator** when the board cannot make progress
//!   without explicit repair: tasks owned by dead members, stale
//!   `in_progress` work, and ready ownerless tasks awaiting explicit
//!   coordinator assignment (issue #272 E1).
//! - **Reconcile the run** when every task is resolved and every worker
//!   is terminal.
//!
//! Failed members are rate-limited by a per-`(run, member)` rewake budget
//! (three attempts with 1/5/15-minute backoff) that resets on the next
//! successful member turn.
//!
//! Implementation is split across submodules: [`budget`] persists recovery
//! attempts and gates backoff; [`reservation`] wraps a member-rewake budget
//! spend in a two-phase reserve/commit-or-refund dispatch; [`plan`] defines
//! the [`StallRecoveryPlan`] the watchdog produces; [`inspect`] reads the
//! task board and worker sessions to build that plan; and [`recover`] runs
//! the periodic scan and carries the plan out.

mod budget;
mod inspect;
mod plan;
mod recover;
mod reservation;

#[cfg(test)]
mod tests;

pub use budget::clear_rewake_budget;
pub use budget::init_schema;
#[cfg(test)]
pub use budget::test_only_mark_failed_rewake_attempt;
pub(crate) use budget::member_rewake_fingerprint;
pub use inspect::inspect_stalled_run;
pub use plan::{MemberContinuationAction, MemberTaskAssignmentAction, StallRecoveryPlan};
pub use recover::{recover_stalled_run, spawn};
pub(crate) use reservation::{
    commit_member_rewake_reservation, refund_member_rewake_reservation,
    reserve_member_rewake_dispatch, MemberRewakeReservationOutcome,
};

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::AppHandle;

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
};
use crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore;
use crate::coordination::agent_org_runs::{
    AgentOrgFinalityBlocker, AgentOrgFinalityDecision, AgentOrgRunRecord, AgentOrgRunStatus,
    AgentOrgRunStore, COORDINATOR_MEMBER_ID,
};
use crate::coordination::agent_org_tasks::{self, Task, TaskStatus};
use crate::core::session::SessionStatus;
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;

const WATCHDOG_INTERVAL_SECS: u64 = 60;
const RECOVERY_DELAYS_SECS: [i64; 3] = [60, 5 * 60, 15 * 60];
const MEMBER_REWAKE: &str = "member_rewake";
const COORDINATOR_NOTICE: &str = "coordinator_notice";

fn has_unread_for_member(run_id: &str, member_id: &str) -> Result<bool, String> {
    AgentInboxStore::has_unread_for_member(member_id, run_id)
}
