//! Durable Work Item Run application service.
//!
//! This module is the single persistence boundary for execution episodes and
//! dispatch delivery. Enqueue writes the Run and outbox row atomically;
//! workers claim with expiring leases; every acknowledgement checks the lease
//! token. Run terminal state never completes product intent; a successful Run
//! only projects the Work Item to `in_review` for explicit human acceptance.

mod consumer_cursor;
mod dispatch;
mod enqueue;
mod path_lock;
mod read;
mod store;
mod terminal;

use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::projects::types::{WorkItemRunSkillManifestEntry, WorkItemRunTargetSnapshot};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

pub use consumer_cursor::{advance_consumer_cursor, initialize_consumer_cursor};
pub use dispatch::{
    acknowledge_dispatch_started, claim_dispatch_for_run, claim_next_dispatch,
    has_claimable_dispatch, next_dispatch_due_at_ms,
};
pub(crate) use enqueue::enqueue_in_transaction;
pub use enqueue::{enqueue, enqueue_for_inline_dispatch};
pub(crate) use read::read_in_transaction;
pub use read::{
    latest_for_session, list_active_session_runs, list_for_work_item, read, routine_origin,
};
pub(crate) use terminal::{
    cancel_pending_assignee_escalations_for_agent_reply, context_exhausted_session_snapshot_in,
};
pub use terminal::{
    classify_failure, mark_waiting, record_dispatch_failure, record_run_terminal,
    record_session_terminal, retry,
};

#[cfg(test)]
use crate::projects::io::helpers::{conn, now_ms};
#[cfg(test)]
use crate::projects::types::{
    WorkItemRunFailureClass, WorkItemRunRetryDisposition, WorkItemRunStatus, WorkItemRunUsage,
};
#[cfg(test)]
use dispatch::has_claimable_dispatch_on;
#[cfg(test)]
use rusqlite::TransactionBehavior;

pub mod error {
    pub const PREFIX: &str = "PM_RUN_ERR:";
    pub const INVALID_REQUEST: &str = "PM_RUN_ERR:INVALID_REQUEST";
    pub const NOT_FOUND: &str = "PM_RUN_ERR:NOT_FOUND";
    pub const IDEMPOTENCY_CONFLICT: &str = "PM_RUN_ERR:IDEMPOTENCY_CONFLICT";
    pub const STALE_LEASE: &str = "PM_RUN_ERR:STALE_LEASE";
    pub const INVALID_TRANSITION: &str = "PM_RUN_ERR:INVALID_TRANSITION";
    pub const RETRY_NOT_ALLOWED: &str = "PM_RUN_ERR:RETRY_NOT_ALLOWED";
    pub const PATH_LOCKED: &str = "PM_RUN_ERR:PATH_LOCKED";
    pub const RUN_QUEUED: &str = "PM_RUN_ERR:RUN_QUEUED";
}

const DEFAULT_LEASE_MS: i64 = 30_000;
const MAX_RUN_ATTEMPTS: u32 = 10;

/// Dependency-inverted resolver supplied by `agent_core` at app startup.
pub type WorkItemRunSkillManifestResolver =
    fn(&WorkItemRunTargetSnapshot) -> Result<Vec<WorkItemRunSkillManifestEntry>, String>;
static WORK_ITEM_RUN_SKILL_MANIFEST_RESOLVER: OnceLock<WorkItemRunSkillManifestResolver> =
    OnceLock::new();

pub fn register_skill_manifest_resolver(resolver: WorkItemRunSkillManifestResolver) {
    let _ = WORK_ITEM_RUN_SKILL_MANIFEST_RESOLVER.set(resolver);
}

pub fn skill_manifest_digest(manifest: &[WorkItemRunSkillManifestEntry]) -> Result<String, String> {
    let json = serde_json::to_vec(manifest)
        .map_err(|err| format!("work run skill manifest serialization: {err}"))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(json))))
}

fn resolve_skill_manifest(
    snapshot: &WorkItemRunTargetSnapshot,
) -> Result<Vec<WorkItemRunSkillManifestEntry>, String> {
    match WORK_ITEM_RUN_SKILL_MANIFEST_RESOLVER.get() {
        Some(resolve) => resolve(snapshot),
        None => Ok(Vec::new()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkItemRunTerminalOutcome {
    Succeeded,
    Failed,
    Cancelled,
}
