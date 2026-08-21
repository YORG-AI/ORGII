//! Persistence and query layer for Agent Org tasks.
//!
//! The store grew to cover the full task lifecycle, so its concerns now live in
//! focused submodules that this module wires together:
//!
//! - [`validation`] — pre-write guards (run mutability, text limits, persistence
//!   invariants).
//! - [`dependencies`] — canonical `blocked_by` graph validation and derived
//!   reverse-edge projection.
//! - [`fsm`] — production actor-gated creation and lifecycle transitions.
//! - [`create`] — test-only compatibility fixtures for older Store tests.
//! - [`read`] — full-row reads, the operational projection, summary pages, and
//!   previews.
//! - [`update`] — production plan-completion plus test-only compatibility
//!   updates.
//! - [`delete`] — test-only physical deletion fixtures.
//! - [`requeue`] — owner-scoped shutdown disposal and failure requeue.
//!
//! Every method hangs off [`AgentOrgTaskStore`] via inherent `impl` blocks split
//! across those submodules, so the public API
//! (`agent_org_tasks::AgentOrgTaskStore`) is unchanged.

mod annotations;
#[cfg(test)]
mod create;
#[cfg(test)]
mod delete;
mod dependencies;
mod fsm;
mod read;
mod requeue;
mod update;
mod validation;

// Names referenced with an explicit `super::` prefix inside the submodule
// bodies below. Re-binding them here keeps those references verbatim: from a
// submodule, `super::` resolves to this module.
use super::{
    TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_EXECUTION_MODE, TASK_METADATA_OUTPUT,
    TASK_METADATA_REQUIRED_ROLE, TASK_MUTATION_CONFLICT_ERROR,
};

#[cfg(test)]
use super::{TaskExecutionMode, TaskOutput, TASK_COMPLETED_IMMUTABLE_ERROR};

pub struct AgentOrgTaskStore;
