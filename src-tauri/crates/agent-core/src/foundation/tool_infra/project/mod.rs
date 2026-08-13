//! Shared project service: project + work-item operations.
//!
//! Used by:
//! - Tauri commands for frontend project/work-item operations
//!
//! Wraps `project_management::projects::io` (global SQLite store)
//! with:
//! - Async execution via `spawn_blocking`
//! - Timeout protection via [`FILE_IO_TIMEOUT`]
//! - Automatic ID allocation for work items
//! - Slug-based addressing (no `repo_path`; the store is global at
//!   `~/.orgii/projects/projects.db`)
//!
//! All public functions return a human-readable `String` result suitable
//! for both UI display and agent consumption.
//!
//! # Modules
//!
//! - [`helpers`]: Internal utilities (slugify, truncate, blocking runner)
//! - [`projects`]: Project CRUD operations
//! - [`work_items`]: Work item CRUD operations
//! - [`execution`]: Work item execution and agent session launching
//! - [`search`]: Cross-project search for work items and projects

#[cfg(test)]
mod tests;

mod execution;
mod helpers;
mod projects;
mod search;
mod work_items;

#[cfg(debug_assertions)]
pub use execution::debug_parse_work_item_launch_sources;
pub use execution::start_work_item;
pub use execution::{
    launch_phase_session, start_work_item_session_with_reason, start_work_item_with_reason,
    PhaseLaunch, StartWorkItemSessionRequest, StartedWorkItemSession,
};
pub use helpers::{resolve_slug, slugify, OrchestratorConfigOverrides};
pub use projects::{create_project, delete_project, list_projects, read_project, update_project};
pub use search::find_across_workspaces;
pub use work_items::{
    create_work_item, delete_work_item, list_work_items, read_work_item, update_work_item,
};

#[cfg(test)]
pub(crate) use execution::{build_agent_prompt, build_project_prompt};
