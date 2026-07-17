//! Tauri commands for reading and writing the on-disk configuration files
//! that external CLI agents (Cursor, Claude Code, Codex) keep under the
//! user's home directory:
//!
//! - `~/.cursor/cli-config.json` and `~/.cursor/sandbox.json`
//! - `~/.claude/settings.json`
//! - `~/.codex/config.toml`
//!
//! Each submodule owns the format for one agent (JSON for Cursor /
//! Claude Code, TOML for Codex) and exposes a small set of
//! `#[tauri::command]` functions for the frontend's settings UI. The
//! crate is a true leaf — depends only on `app_paths` (for
//! `home_dir()`) and `app_utils::json` for the JSON merge helpers.
//! `app::commands::handler_list` re-registers every command (key-vault
//! / git pattern).

pub mod claude_code;
pub mod codex;
pub mod cursor;
pub mod generic_config;
pub mod managed_config;
pub mod session_provenance;
