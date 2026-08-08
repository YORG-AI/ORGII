//! Agent Tauri commands.

pub mod channel_handler;
pub mod desktop;
pub mod routines;
pub mod session;
pub mod tools;

// `pub use session::*` is required because `tauri::generate_handler!`
// in `commands/handler_list.inc` resolves a long list of session-level
// Tauri commands at the `state::commands::<name>` path
// (`agent_session_list`, `gateway_status`, `agent_load_messages`, …).
// `tools::*` commands are referenced through the deeper
// `state::commands::tools::<name>` path, so they don't need to be
// flattened here.
pub use routines::*;
pub use session::*;
