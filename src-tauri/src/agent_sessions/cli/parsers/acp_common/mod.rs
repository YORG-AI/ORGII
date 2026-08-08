//! Shared ACP (Agent Client Protocol) logic for agents using JSON-RPC over stdin/stdout.
//!
//! Both Copilot and Kiro use ACP. This module contains the generic protocol handling;
//! agent-specific behavior is provided via the `AcpAgentAdapter` trait.
//!
//! Submodules:
//! - `approval` — pending-approval registry + permission-request helpers
//! - `content`  — content/diff/todo/tool-result normalization helpers
//! - `parser`   — `session/update` → `ActivityChunk` parsing
//! - `protocol` — the ACP lifecycle (initialize → session → prompt → stream)
//! - `rpc`      — JSON-RPC framing over the child process stdio

mod approval;
mod content;
mod parser;
mod protocol;
mod rpc;

use serde_json::Value;

use core_types::activity::ActivityChunk;

pub use approval::{resolve_approval, ApprovalResponse, ACP_APPROVAL_TIMEOUT};
pub(crate) use parser::AcpNotificationParser;
pub use protocol::run_acp_protocol;

/// Test-only re-exports: the external test module (`../tests/acp_common_tests.rs`)
/// does `use super::*` and exercises these helpers directly.
#[cfg(test)]
pub(crate) use content::{
    count_diff_lines, extract_edit_content, extract_tool_call_content, normalize_tool_result,
    parse_markdown_todos, synthesize_diff,
};

// ============================================
// Trait: Agent-specific ACP behavior
// ============================================

/// Agent-specific behavior for ACP protocol.
/// Implement this trait to customize tool name mapping and handle custom notifications.
pub trait AcpAgentAdapter: Send {
    /// Map ACP tool_call `kind` to Cursor-normalized tool name.
    /// Default handles standard ACP kinds (execute, read, write, etc.).
    fn map_tool_kind(&self, kind: &str, _raw_input: &Value) -> String {
        match kind {
            "execute" => "Shell",
            "read" => "Read",
            "write" | "edit" => "Edit",
            "search" => "Grep",
            "delete" => "Delete",
            "fetch" => "WebFetch",
            "other" => "Task",
            _ => kind,
        }
        .to_string()
    }

    /// Handle agent-specific notifications (non-standard methods like `_kiro.dev/*`).
    /// Return chunks to emit, or empty vec to ignore.
    fn handle_custom_notification(&mut self, _method: &str, _params: &Value) -> Vec<ActivityChunk> {
        vec![]
    }

    #[allow(clippy::too_many_arguments)]
    // Adapter implementations share the ACP tool-result callback shape; every
    // field is optional protocol context rather than parser-owned state.
    fn map_tool_result_chunk(
        &self,
        _session_id: &str,
        _cursor_name: &str,
        _result_text: &str,
        _detailed_text: &str,
        _raw_input: Option<&Value>,
        _title: Option<&str>,
        _parent_task: Option<&str>,
        _is_error: bool,
    ) -> Option<ActivityChunk> {
        None
    }

    fn should_emit_tool_start(&self, _cursor_name: &str) -> bool {
        true
    }

    fn should_emit_tool_result(
        &self,
        _cursor_name: &str,
        _result_text: &str,
        _is_error: bool,
    ) -> bool {
        true
    }
}

// ============================================
// Types
// ============================================

/// Result from a completed ACP session.
pub struct AcpSessionResult {
    /// The ACP session ID (for resume via `session/load`).
    pub acp_session_id: String,
    /// Why the prompt turn ended (e.g. "end_turn", "cancelled").
    pub stop_reason: String,
}

#[cfg(test)]
#[path = "../tests/acp_common_tests.rs"]
mod tests;
