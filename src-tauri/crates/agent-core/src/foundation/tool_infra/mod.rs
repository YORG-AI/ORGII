//! Shared Tool Infrastructure Layer
//!
//! Single source of truth for tool implementations. Both the agent tools
//! (via `Tool` trait) and Tauri commands (via `invoke()`) delegate to these
//! shared functions, eliminating duplicate implementations.
//!
//! # Modules
//!
//! - `terminal`: PTY session management + command execution. Hoisted into
//!   the `terminal` workspace crate (`terminal::agent_tool` for the LLM-tool
//!   helpers, `terminal::pty_commands` for the front-side Tauri commands).
//! - [`file`]: File read/write/edit/list with path validation and sandboxing
//! - [`search`]: Code search (grep-searcher) and file search (ignore crate)
//! - [`project`]: Global project store operations (projects, work items, execution, search)
//!
//! # Centralized Timeouts
//!
//! All blocking operations (subprocess spawning, file I/O) use the timeout
//! constants defined here. This prevents any single tool invocation from
//! blocking the agent indefinitely (e.g., `find /`, `git push` waiting for
//! credentials, NFS hangs).

pub mod file;
mod project;
pub mod search;

// `terminal` lives in the `terminal` workspace crate. Re-export under the
// historical path so existing call sites (`crate::tool_infra::terminal::*`)
// keep compiling unchanged. The shim points at the back-side
// (`agent_tool`) module — that's the one all `agent_core` callers reach for.
pub use ::terminal::agent_tool as terminal;

// `project` is private; this re-export is its sole public surface.
#[cfg(debug_assertions)]
pub use project::debug_parse_work_item_launch_sources;
pub use project::{
    // projects
    create_project,
    // work_items
    create_work_item,
    delete_project,
    delete_work_item,
    // search
    find_across_workspaces,
    // execution
    launch_phase_session,
    list_projects,
    list_work_items,
    read_project,
    read_work_item,
    // helpers
    resolve_slug,
    slugify,
    start_work_item,
    start_work_item_session_with_reason,
    start_work_item_with_reason,
    update_project,
    update_work_item,
    OrchestratorConfigOverrides,
    PhaseLaunch,
    StartWorkItemSessionRequest,
    StartedWorkItemSession,
};

use std::time::Duration;

// ============================================
// Centralized Timeout Constants
// ============================================

/// Timeout for search operations (`rg`, `find`).
/// Generous for large repos, but prevents runaway `find /` etc.
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for file I/O operations (read, write, edit, list_dir).
/// Normally instant on local disk; this guards against NFS/network mounts.
pub const FILE_IO_TIMEOUT: Duration = Duration::from_secs(10);
