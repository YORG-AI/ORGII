//! Flow Awareness System - tracks user activities to infer intent.
//!
//! This module provides a unified activity tracking system that all agent
//! sessions can use to understand user context.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────┐
//! │                     Flow Awareness System                           │
//! ├─────────────────────────────────────────────────────────────────────┤
//! │  Activity Store (per-session + global)                              │
//! │  ├─ File edits (path, timestamp, edit type)                         │
//! │  ├─ Terminal commands (command, cwd, exit code)                     │
//! │  ├─ Navigation events (file opened, tab switched)                   │
//! │  ├─ Search queries (query, scope, result count)                     │
//! │  ├─ Clipboard activity (copy/cut, content preview)                  │
//! │  └─ Git operations (commit, branch switch, pull/push)               │
//! ├─────────────────────────────────────────────────────────────────────┤
//! │  Intent Inference                                                   │
//! │  ├─ Pattern detection (debugging, refactoring, exploring, etc.)     │
//! │  ├─ Active context (current focus area, recent files)               │
//! │  └─ Work session summary (what user has been doing)                 │
//! ├─────────────────────────────────────────────────────────────────────┤
//! │  Context Builder Integration                                        │
//! │  └─ format_flow_context() -> String (for system prompts)            │
//! └─────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Usage
//!
//! ```rust,ignore
//! use crate::flow_awareness::{FlowStore, Activity, ActivityType};
//!
//! // Record activities
//! let store = FlowStore::global();
//! store.record(Activity::file_edit("src/main.rs", EditType::Modify));
//! store.record(Activity::terminal_command("npm test", "/project", Some(0)));
//!
//! // Get context for system prompt
//! let context = store.format_context(session_id);
//! ```

pub mod commands;
mod store;
pub(super) mod types;

pub use store::FlowStore;
// The only external consumer (`session::wingman::loop_runner`) imports
// just `FlowStore`. The 11 activity types (`Activity`, `ActivityType`,
// `ClipboardOp`, `DebugAction`, `ErrorType`, `FileEditType`,
// `FlowSummary`, `GitOpType`, `InferredIntent`, `NavigationTarget`,
// `SearchScope`) are recorded internally by `commands.rs` / `store.rs`
// and serialized straight to/from the `flow_record_activity` Tauri wire
// — they never escape this module. The `pub use types::*` re-export
// that used to be here was dead surface; `commands.rs` and the in-tree
// tests now reach them via the explicit `super::types::{...}` path.

/// Format flow awareness context for injection into system prompts.
///
/// This is the main entry point for agents to get user activity context.
/// Returns a formatted string suitable for appending to the system prompt.
pub fn format_flow_context(session_id: Option<&str>, max_activities: usize) -> String {
    let store = FlowStore::global();
    store.format_context(session_id, max_activities)
}

#[cfg(test)]
#[path = "tests/flow_awareness_tests.rs"]
mod flow_awareness_tests;

#[cfg(test)]
#[path = "tests/integration_tests.rs"]
mod integration_tests;
