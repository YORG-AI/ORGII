//! Project tools — global project store lifecycle and per-project work-item CRUD.
//!
//! - [`manage_project`]   — `manage_project` (project metadata, init, list)
//! - [`manage_work_item`] — `manage_work_item` (work-item CRUD under the project)
//!
//! Category: [`tool_categories::PROJECT`].
//!
//! [`tool_categories::PROJECT`]: crate::tools::categories::PROJECT

pub mod import_context;
pub mod manage_project;
pub mod manage_work_item;
