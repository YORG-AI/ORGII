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
pub mod project_service;
pub mod projects;
pub mod provider_host;
pub mod routine_service;
pub mod sync;
pub mod team_inbox;
pub mod work_item_features;
pub mod work_run_service;
pub mod work_service;

#[cfg(test)]
mod test_support;
