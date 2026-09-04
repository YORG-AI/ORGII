//! ORGII Tauri Application Library
//!
//! This is the main library crate for the ORGII desktop application built with Tauri.
//! It provides the Rust backend for the frontend React application.
//!
//! # Architecture Overview
//!
//! The application is structured into several modules:
//!
//! - **[`api`]**: HTTP/WebSocket server for Git operations, search, and real-time events
//! - **[`git`]**: Git utilities, bundle creation, and file system watching
//! - **[`search`]**: File search (fuzzy) and code search (regex, symbols)
//! - **[`session`]**: Session management, indexing, and folder archiving
//! - **[`processes`]**: External process management (sidecars)
//! - **[`platform`]**: Platform-specific features (notifications, system tray)
//! - **[`terminal`]**: PTY (pseudo-terminal) management for integrated terminal
//! - **[`browser`]**: Browser windows and inline webviews
//! - **[`integrations`]**: External integrations (external IDEs, Cursor credentials)
//! - **[`lsp`]**: Language Server Protocol client for code intelligence
//!
//! # Initialization Sequence
//!
//! The [`run()`] function initializes the application in the following order:
//!
//! 1. Tauri plugins (single-instance, deep-link, OAuth, filesystem, shell, notifications)
//! 2. Repository watch manager for real-time git status
//! 3. WebSocket broadcast channel for frontend events
//! 4. CLI sessions (CLI agent spawning, parsing, persistence)
//! 5. Proxy integration (ORGII billing, MITM for Cursor/Kiro/Copilot)
//! 5. Unified IDE server (Git API + Search API + WebSocket on port 13847)
//! 6. Centralized index manager for lightweight workspace indexing
//! 7. Test runner, PTY, and LSP state managers
//!
//! # Tauri Commands
//!
//! Commands are exposed to the frontend via `tauri::command` and registered in
//! the `invoke_handler` (see `commands/handler_list.inc`, referenced from the generated
//! include in [`run`]).
//! They are grouped by area in that file (e.g. browser, search, agents).

// ============================================
// Module Declarations
// ============================================

// `agent_core` is now a workspace crate at `crates/agent-core/`. The
// `commands/handler_list.inc` and call sites inside `app/src/` reach it
// directly as `agent_core::…`.

// Workstation (IDE functionality and development tools)
pub mod agent_sessions; // Agent session management (CLI, event pipeline, persistence, aggregation)
pub mod api;
pub(crate) mod app; // Tauri application assembly: bootstrap, plugins, setup hook, lifecycle
pub mod app_update; // Channel-aware (stable/beta) app update checks
pub mod cli_managed_proxy;
pub mod infrastructure; // In-tree-only cross-cutting infrastructure (paths, platform, archive, jsonrpc, housekeeping). Leaf pieces live in their own workspace crates.
pub mod orgtrack;
mod runtime_instance;
pub(crate) mod setup;
#[cfg(target_os = "macos")]
mod single_instance_focus;
pub mod usage_diagnostics;

#[cfg(test)]
pub mod test_utils;

// ============================================
// Global State
// ============================================

// Python sidecar (`newmain`) has been removed.
// All backend functionality is now handled natively in Rust:
// - Session execution: cli_session module (CLI agent spawning + parsing)
// - Proxy billing: proxy module (token allocation + MITM proxy)
// - Config/Providers: key_vault module (reads credentials.json)
// - Git operations: api/git module (git2 crate)
// - Repo management: git/repos module (SQLite + git watcher)
// See docs/architecture-guide/unified-proxy-architecture-0210.md

/// Main entry point for the Tauri application.
///
/// This function:
/// 1. Configures Tauri plugins (deep-link, OAuth, FS, shell, notifications, store, process, updater)
/// 2. Registers all Tauri command handlers organized by module
/// 3. Runs the setup hook which initializes all backend services
///
/// # Panics
///
/// Panics if the Tauri application fails to build or run. Individual subsystems
/// (sidecar, etc.) fail gracefully without crashing the app.
///
/// # Example
///
/// ```ignore
/// // Called from main.rs
/// app_lib::run();
/// ```
pub fn run() {
    app::run();
}
