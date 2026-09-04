//! Stall inspection: read the task board and worker sessions for one
//! running Agent Org run and decide the [`super::plan::StallRecoveryPlan`].
//!
//! This is the read-only decision half of the watchdog; [`super::recover`]
//! carries out the plan it returns.
//!
//! Implementation is split across submodules: [`facts`] builds the
//! machine-stable recovery facts and their fingerprints; [`liveness`]
//! classifies session statuses and task staleness; [`unread`] analyzes the
//! Agent Org Inbox backlog; [`dependency_integrity`] checks the persisted task
//! graph; [`coordinator_notice`] bounds the coordinator repair prose and reads
//! the notice budget; and [`run`] performs the pass that produces the plan.

mod coordinator_notice;
mod dependency_integrity;
mod facts;
mod liveness;
mod run;
mod unread;

pub(super) use facts::task_snapshot_fingerprint;
pub(super) use liveness::{pending_materialization_disposition, PendingMaterializationDisposition};
// Only `agent_org_watchdog::tests` reaches this predicate through the facade;
// `inspect`'s own callers import it from `liveness` directly.
#[cfg(test)]
pub(super) use liveness::is_wakeable_status;
pub use run::inspect_stalled_run;
pub(super) use run::inspect_stalled_run_with_connection;
pub(super) use unread::unavailable_unread_recipient_repair_fingerprint_with_connection;
