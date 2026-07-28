//! Persistence and query layer for Agent Org tasks.
//!
//! The store grew to cover the full task lifecycle, so its concerns now live in
//! focused submodules that this module wires together:
//!
//! - [`validation`] — pre-write guards (run mutability, text limits, persistence
//!   invariants).
//! - [`dependencies`] — dependency-graph canonicalization and the persisted
//!   `blocks`/`blocked_by` projection.
//! - [`create`] — single and batched task creation.
//! - [`read`] — full-row reads, the operational projection, summary pages, and
//!   previews.
//! - [`update`] — partial updates and plan-completion.
//! - [`delete`] — deletion with dependent-guard.
//! - [`requeue`] — owner-scoped shutdown disposal and failure requeue.
//!
//! Every method hangs off [`AgentOrgTaskStore`] via inherent `impl` blocks split
//! across those submodules, so the public API
//! (`agent_org_tasks::AgentOrgTaskStore`) is unchanged.

mod create;
mod delete;
mod dependencies;
mod read;
mod requeue;
mod update;
mod validation;

pub(super) fn normalize_legacy_dependency_rows(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<()> {
    dependencies::normalize_legacy_dependency_rows(conn)
}

// Names referenced with an explicit `super::` prefix inside the submodule
// bodies below. Re-binding them here keeps those references verbatim: from a
// submodule, `super::` resolves to this module.
use super::{
    eligible_member_ids, TaskExecutionMode, TaskOutput, TASK_COMPLETED_IMMUTABLE_ERROR,
    TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_EXECUTION_MODE, TASK_METADATA_OUTPUT,
    TASK_METADATA_REQUIRED_ROLE, TASK_MUTATION_CONFLICT_ERROR,
};

pub struct AgentOrgTaskStore;
