//! SDE Agent, custom agent, and agent-core optimization scenarios.
//!
//! Split into submodules by feature area. All functions are re-exported so
//! `main.rs` can reference them as `sde::function_name` unchanged.

mod agent_core;
mod agent_definition;
mod auto_dream;
mod background_reminder;
mod cancel_interrupt;
mod chat;
mod cursor_cli;
mod exec_modes;
mod extract_memories_config_path;
mod extract_memories_fs;
mod file_history;
mod hooks;
mod interactive_tool;
mod mode_switch;
mod permission;
mod resume;
mod scratchpad_fs;
mod session_memory_db;
mod todo;
mod web;
mod workspace;
mod worktree;

pub use agent_core::*;
pub use agent_definition::*;
pub use auto_dream::*;
pub use background_reminder::*;
pub use cancel_interrupt::*;
pub use chat::*;
pub use cursor_cli::*;
pub use exec_modes::*;
pub use extract_memories_config_path::*;
pub use extract_memories_fs::*;
pub use file_history::*;
pub use hooks::*;
pub use interactive_tool::*;
pub use mode_switch::*;
pub use permission::*;
pub use resume::*;
pub use scratchpad_fs::*;
pub use session_memory_db::*;
pub use todo::*;
pub use web::*;
pub use workspace::*;
pub use worktree::*;

pub(crate) fn tmp_workspace_path(label: &str) -> String {
    let dir = std::env::temp_dir().join(format!("e2e-sde-{label}"));
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().to_string()
}
