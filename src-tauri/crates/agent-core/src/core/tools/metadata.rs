//! Tool metadata: priority, UI metadata, and structured actions.
//!
//! Split out of `traits.rs` so the giant `Tool` trait file isn't also the home
//! for all the descriptor types attached to it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ============================================
// Tool Priority (Deferred Loading)
// ============================================

/// Priority level that controls whether a tool's schema is included in
/// every LLM request or deferred until the agent explicitly searches.
///
/// Tools with `Always` (the default) are always sent to the LLM.
/// Tools with `OnDemand` are hidden from the prompt and only discoverable
/// via `tool_search`. This reduces prompt token usage for rarely-used tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPriority {
    /// Always include in tool definitions sent to the LLM.
    Always,
    /// Deferred — only discoverable via `tool_search`.
    OnDemand,
}

/// Cache-stability segment for a tool schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ToolSchemaCacheScope {
    /// Session-stable built-in schema. These tools are emitted first so provider
    /// adapters can place a cache breakpoint after the stable prefix.
    StablePrefix,
    /// Runtime-live schema supplied by an external server/plugin. These tools are
    /// emitted after the stable prefix so connect/disconnect changes do not move
    /// stable schemas.
    LiveSuffix,
}

impl ToolSchemaCacheScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StablePrefix => "stable_prefix",
            Self::LiveSuffix => "live_suffix",
        }
    }

    pub fn from_wire_value(value: &str) -> Option<Self> {
        match value {
            "stable_prefix" => Some(Self::StablePrefix),
            "live_suffix" => Some(Self::LiveSuffix),
            _ => None,
        }
    }
}

pub const ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY: &str = "x_orgii_tool_schema_cache_scope";

pub fn tool_schema_cache_scope(schema: &Value) -> ToolSchemaCacheScope {
    schema
        .get(ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY)
        .and_then(Value::as_str)
        .and_then(ToolSchemaCacheScope::from_wire_value)
        .unwrap_or(ToolSchemaCacheScope::StablePrefix)
}

pub fn strip_tool_schema_cache_scope(schema: &mut Value) {
    if let Some(object) = schema.as_object_mut() {
        object.remove(ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY);
    }
}

// ============================================
// UI Metadata (Dual-Track Response)
// ============================================

/// Structured metadata for rich UI rendering of tool results.
///
/// This separates UI presentation concerns from LLM context, following
/// the Onyx pattern of `rich_response` vs `llm_facing_response`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUIMetadata {
    /// Display type hint for frontend (e.g., "search_results", "file_diff", "table").
    pub display_type: String,

    /// Structured data for rendering (schema depends on display_type).
    pub data: Value,

    /// Optional: summary line for collapsed view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

// ============================================
// Tool Actions (UI Metadata)
// ============================================

/// Structured action/subcommand metadata sent to the frontend via IPC.
///
/// Each tool can declare the actions (subcommands, modes) it supports.
/// The frontend uses `app_subtool` to pick a Block/Panel component, and
/// the per-engine, per-state layout arrays to decide what slots to render.
///
/// See `.cursor/rules/event-rendering.mdc` for the full dispatch model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolAction {
    pub name: String,
    pub summary: String,

    /// Per-action AppSubtool override. When present, the frontend uses this
    /// instead of the tool-level `ToolInfo.app_subtool`. Enables a single
    /// tool (e.g. `code_search`) to route different actions to different
    /// simulator panels (grep → Search, find_files → Glob).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "appSubtool"
    )]
    pub app_subtool: Option<super::ui_metadata::AppSubtool>,

    /// Per-action ChatBlock override. When present, the frontend uses this
    /// instead of the tool-level `ToolInfo.chat_block`. Enables a single
    /// tool (e.g. `code_search`) to route different actions to different
    /// chat blocks (grep → Search, find_files → Glob, check_status → Fallback).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "chatBlock")]
    pub chat_block: Option<super::ui_metadata::ChatBlock>,

    /// Per-action display behavior override. When absent, the frontend uses
    /// the tool-level `ToolInfo.display_behavior`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "displayBehavior"
    )]
    pub display_behavior: Option<super::ui_metadata::ToolDisplayBehavior>,

    #[serde(
        default,
        skip_serializing_if = "String::is_empty",
        rename = "labelRunning"
    )]
    pub label_running: String,
    #[serde(
        default,
        skip_serializing_if = "String::is_empty",
        rename = "labelDone"
    )]
    pub label_done: String,
    #[serde(
        default,
        skip_serializing_if = "String::is_empty",
        rename = "labelFailed"
    )]
    pub label_failed: String,

    /// Per-action extra state → i18n key map. Falls back to the tool-level
    /// `ToolInfo.status_labels` when absent.
    #[serde(
        default,
        skip_serializing_if = "std::collections::HashMap::is_empty",
        rename = "statusLabels"
    )]
    pub status_labels: std::collections::HashMap<String, String>,
}
