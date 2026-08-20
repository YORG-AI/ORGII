//! Code session runner — split into focused submodules.
//!
//! Spawns a CLI agent subprocess, pipes stdout through the appropriate parser,
//! stores ActivityChunks, and broadcasts them via WebSocket.
//!
//! Submodules:
//! - `helpers`        — shared state, emit_chunk, image persistence
//! - `command`        — CLI command building and parser factory
//! - `session`        — core run_session function
//! - `input_assembly` — effective-prompt assembly (bridges, images, skills)
//! - `env_setup`      — child-process env / profile-dir / proxy preparation
//! - `finalize`       — post-run status, error surfacing, resource teardown
//! - `lifecycle`      — kill, cancel, cleanup
//! - `proxy_release`  — market proxy token release
//! - `cursor_usage`   — Cursor Dashboard API token tracking
//! - `context_bridge` — prior-conversation injection for CLI sessions
//! - `oauth_setup`    — OAuth auth file writing and retry detection
//! - `plan_approval`  — plan detection and approval card registration
//! - `token_sync`     — post-run token sync back to key vault

pub(crate) mod command;
mod context_bridge;
mod cursor_usage;
mod env_setup;
mod finalize;
mod harness_hooks;
mod helpers;
mod input_assembly;
pub(crate) mod launch_profiles;
mod lifecycle;
mod oauth_setup;
mod plan_approval;
mod proxy_release;
mod session;
mod token_sync;

pub(crate) use harness_hooks::stop_session as stop_session_hooks;
pub use helpers::{flush_cli_streams_for_session, session_control_lock, RUNNING_SESSIONS};
pub(crate) use input_assembly::forget_session_context;
pub use lifecycle::{
    cancel_session, cleanup_cursor_config_dir, kill_running_agent, terminate_process_tree,
};
pub use proxy_release::release_proxy_token_for_session_pub;
pub use session::run_session;

#[cfg(test)]
#[path = "../tests/runner_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/runner_command_tests.rs"]
mod command_tests;
