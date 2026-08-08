//! Tauri commands for CLI agent session management.
//!
//! Split into focused submodules:
//! - `create`          — `cli_agent_create` session/worktree provisioning
//! - `failure_broadcast` — shared async runner-failure status broadcast
//! - `launch_profile`  — get/update/reset per-agent CLI launch profile
//! - `resume_delete`   — `cli_agent_resume` / `cli_agent_delete`
//! - `run`             — `cli_agent_run` / `cli_agent_message` / `cli_agent_approval_response`
//! - `status`          — status/history/cancel/list queries
//! - `transcript`      — native/legacy transcript chunk loading and truncation
//! - `worktree`        — `cli_agent_merge` / `cli_agent_worktree_diff` / `cli_agent_worktree_discard`

mod create;
mod failure_broadcast;
mod launch_profile;
mod resume_delete;
mod run;
mod status;
mod transcript;
mod worktree;

// Glob re-exports so each `#[tauri::command]`'s generated `__cmd__<name>` macro is
// re-exported alongside the fn, keeping `commands::<name>` resolvable for
// `generate_handler!` (which references `commands::__cmd__<name>`).
pub use create::*;
pub use launch_profile::*;
pub use resume_delete::*;
pub use run::*;
pub use status::*;
pub use transcript::*;
pub use worktree::*;
