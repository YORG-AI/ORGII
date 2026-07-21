//! Coding tool implementations.
//!
//! One file (or subfolder) per tool — the file/folder name matches the tool
//! name. Helper-only modules such as `action_router` are kept flat.
//!
//! - [`code_search`]   — `code_search` tool
//! - [`edit_file`]     — `edit_file` tool (subfolder: strategies + tests)
//! - [`exec`]          — `run_shell` + `await_output` tools (subfolder)
//! - [`files`]         — `read_file` + `list_dir` + `delete_file` tools (subfolder)
//! - [`manage_lsp`]    — `manage_lsp` tool (subfolder: tests)
//! - [`manage_todo`]   — `manage_todo` tool
//! - [`manage_workspace`] — `manage_workspace` tool
//! - [`query_lsp`]     — `query_lsp` tool (subfolder: tests)
//! - [`setup_repo`]    — `setup_repo` tool
//! - [`worktree`]      — `worktree` tool
//!
//! Helpers:
//! - [`action_router`] — `ActionRouter` (per-tool routing layer over `ActionBridge`)

pub mod action_router;
pub mod code_search;
pub mod edit_file;
pub mod exec;
pub mod files;
pub mod inspect_terminals;
pub mod manage_file_history;
pub mod manage_lsp;
pub mod manage_todo;
pub mod manage_workspace;
pub mod query_lsp;
pub mod render_inline_canvas;
pub mod setup_repo;
pub mod skill;
pub mod worktree;
