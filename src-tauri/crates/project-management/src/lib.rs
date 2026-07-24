//! Project management domain
//!
//! This crate contains project-management functionality:
//! - `projects`: Pure-SQLite project & work item store at
//!   `~/.orgii/projects/projects.db`. Single source of truth.
//! - `team_inbox`: Viewer-scoped projection of assigned Work Items.
//! - `orchestrator`: Workflow orchestration state machine.
//! - `lineage`: Code lineage tracking and analysis.
//! - `sync`: Pluggable sync framework — outbox + adapters draining through
//!   a tokio worker.

pub mod lineage;
pub mod orchestrator;
pub mod projects;
pub mod sync;
pub mod team_inbox;

#[cfg(test)]
mod test_support;
