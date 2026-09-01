//! Integration Commands
//!
//! Centralized registry of all Tauri commands for external tool integrations.
//!
//! **Note:** Browser commands have been moved to the top-level `browser` module.
//! Cursor/Kiro credential commands have moved to `agent_sessions::cli::runners`.
//! This file now only re-exports integration-specific commands.

// ============================================
// External IDE Commands (1 command)
// ============================================

pub use super::external_ide::show_in_folder;
