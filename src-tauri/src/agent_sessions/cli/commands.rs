//! Tauri commands for CLI agent session management.
//!
//! Split into focused submodules:
//! - `create`          — session/worktree provisioning
//! - `launch_profile`  — get/update/reset per-agent CLI launch profile
//! - `resume_delete`   — resume and delete lifecycle
//! - `run`             — run, message and approval responses
//! - `status`          — status, history, cancel and list queries
//! - `transcript`      — transcript path lookup and truncation
//! - `worktree`        — merge, diff and discard operations

mod create;
mod launch_profile;
mod resume_delete;
mod run;
mod status;
mod transcript;
mod worktree;

// Glob re-exports keep each `#[tauri::command]` macro-generated
// `__cmd__<name>` symbol reachable from the existing handler paths.
pub use create::*;
pub use launch_profile::*;
pub use resume_delete::*;
pub use run::*;
pub use status::*;
pub use transcript::*;
pub use worktree::*;
