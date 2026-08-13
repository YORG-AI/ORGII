//! Pure-SQLite project & work item store.
//!
//! Projects and work items are first-class rows in a centralized SQLite store
//! rooted at `~/.orgii/`. Cross-device sync flows through the project sync
//! framework (Linear / GitHub / manual export).
//!
//! # Storage layout
//!
//! - Tables live in their own `~/.orgii/projects/projects.db` (separate
//!   from `~/.orgii/sessions.db`) so a project export is a single-file
//!   copy. The two databases share the orgii root but never share a
//!   transaction.
//! - Binary assets (work item attachments, project covers) live on disk
//!   under `~/.orgii/projects/assets/{project_id}/` — never in DB.
//!
//! # Layering
//!
//! - `schema` / `paths` / `types` — DDL, path helpers, wire types.
//! - `io` — Rust API for projects, work items (CRUD / atomic RMW /
//!   partial / enrichment / views / batch), labels, milestones,
//!   members, assets. All `Result<_, String>` and slug-keyed at the
//!   public surface.
//! - `commands` — Tauri command façade. Each `project_*` handler is a
//!   thin `spawn_blocking` wrapper over an `io` function so the async
//!   IPC boundary doesn't block the runtime on rusqlite.
//!
pub mod commands;
pub mod events;
pub mod io;
pub mod paths;
pub mod routine_schedule;
pub mod schema;
pub mod sync_export;
pub mod types;
