//! Tool execution result types.
//!
//! `ToolExecuteResult` is what `Tool::execute` returns. It carries the
//! LLM-facing text plus optional structured payloads (MCP content blocks,
//! `_meta` / `structuredContent`) that the wire layer consumes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// Structured content block that a tool can return alongside the LLM-facing
/// text. Populated by the MCP bridge from `rmcp::model::Content`; most
/// native tools only emit `Text(...)` blocks.
///
/// Not a wire format — see `turn_executor/helpers.rs` for how blocks are
/// serialized into provider-specific tool_result messages (OpenAI-compat
/// flattens, Anthropic-native keeps blocks verbatim).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContentBlock {
    Text {
        text: String,
    },
    Image {
        mime_type: String,
        /// Base64-encoded image bytes.
        data: String,
    },
    Audio {
        mime_type: String,
        /// Base64-encoded audio bytes.
        data: String,
    },
    Resource {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    ResourceLink {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

/// MCP protocol metadata that must flow from an MCP server tool call through
/// the agent loop to downstream consumers (frontend, logs, SDK clients).
///
/// - `meta`: the `_meta` field from MCP `CallToolResult` (arbitrary JSON).
/// - `structured_content`: the `structuredContent` field (arbitrary JSON,
///   intended for machine-readable output alongside `content` blocks).
///
/// Both are opaque JSON passthroughs — we do not introspect them, and any
/// downstream consumer that needs structured access must parse them on its
/// own. The agent loop only forwards them through unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
}

impl McpMeta {
    pub fn is_empty(&self) -> bool {
        self.meta.is_none() && self.structured_content.is_none()
    }
}

/// Structured result returned by `Tool::execute`.
///
/// Replaced the legacy `String` return type. The vast majority of native
/// tools only populate `text` and leave the other fields at their
/// defaults — use `ToolExecuteResult::text(...)` for that common case.
///
/// The MCP bridge fills in `content_blocks` and `mcp_meta`; the
/// Anthropic-native wire format consumes `content_blocks` directly;
/// OpenAI-compat wire keeps using `text` only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecuteResult {
    /// LLM-facing text. For OpenAI-compat providers this is the entire
    /// `tool` message `content`. For Anthropic-native providers this is a
    /// fallback when `content_blocks` is empty.
    pub text: String,

    /// Structured content blocks (images, resources, etc.). Empty for
    /// native tools; populated by the MCP bridge when a server returns
    /// non-text content.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_blocks: Vec<ToolContentBlock>,

    /// MCP `_meta` + `structuredContent` passthrough. `None` for non-MCP
    /// tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_meta: Option<McpMeta>,

    /// Internal control signal consumed by the local turn executor. It is
    /// never serialized onto provider/MCP wires.
    #[serde(skip)]
    pub turn_directive: Option<ToolTurnDirective>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTurnDirective {
    EndTurn,
}

impl ToolExecuteResult {
    /// Construct a plain-text result. Use this for every native tool.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            content_blocks: Vec::new(),
            mcp_meta: None,
            turn_directive: None,
        }
    }

    pub fn end_turn(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            content_blocks: Vec::new(),
            mcp_meta: None,
            turn_directive: Some(ToolTurnDirective::EndTurn),
        }
    }

    /// Whether any non-text content was attached (images, resources, MCP meta).
    pub fn has_structured_payload(&self) -> bool {
        !self.content_blocks.is_empty()
            || self
                .mcp_meta
                .as_ref()
                .map(|m| !m.is_empty())
                .unwrap_or(false)
    }
}

impl From<String> for ToolExecuteResult {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

impl From<&str> for ToolExecuteResult {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}

impl AsRef<str> for ToolExecuteResult {
    fn as_ref(&self) -> &str {
        &self.text
    }
}

impl fmt::Display for ToolExecuteResult {
    /// Display prints only the LLM-facing text. Structured payloads are
    /// intentionally omitted — use the `text` / `content_blocks` fields
    /// directly if you need them.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.text)
    }
}

impl std::ops::Deref for ToolExecuteResult {
    type Target = str;

    /// Deref-to-str lets test code and simple consumers call `String`/`str`
    /// methods (`.contains`, `.trim`, `.starts_with`, …) directly on a
    /// `ToolExecuteResult` without unwrapping the inner `text` field. Prod
    /// code that needs structured payloads must access `content_blocks` /
    /// `mcp_meta` explicitly — deref does not leak those.
    fn deref(&self) -> &str {
        &self.text
    }
}

impl PartialEq<str> for ToolExecuteResult {
    fn eq(&self, other: &str) -> bool {
        self.text == other
    }
}

impl PartialEq<&str> for ToolExecuteResult {
    fn eq(&self, other: &&str) -> bool {
        self.text == *other
    }
}

impl PartialEq<String> for ToolExecuteResult {
    fn eq(&self, other: &String) -> bool {
        &self.text == other
    }
}
