//! Transport Layer - Cross-platform communication traits
//!
//! This module defines unified interfaces for cross-platform communication.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt::Debug;

/// Transport adapter trait - All platforms must implement this interface
#[async_trait]
pub trait TransportAdapter: Send + Sync + Debug {
    /// Emit agent event to frontend
    async fn emit_agent_event(&self, session_id: &str, event: AgentEvent) -> anyhow::Result<()>;

    /// Emit text chunk (streaming output)
    async fn emit_text_chunk(&self, session_id: &str, chunk: TextChunk) -> anyhow::Result<()>;

    /// Emit tool event
    async fn emit_tool_event(&self, session_id: &str, event: ToolEvent) -> anyhow::Result<()>;

    /// Emit stream start event
    async fn emit_stream_start(
        &self,
        session_id: &str,
        turn_id: &str,
        round_id: &str,
    ) -> anyhow::Result<()>;

    /// Emit stream end event
    async fn emit_stream_end(
        &self,
        session_id: &str,
        turn_id: &str,
        round_id: &str,
    ) -> anyhow::Result<()>;

    /// Emit generic event (supports any event type)
    async fn emit_generic(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()>;

    /// Get adapter type name
    fn adapter_type(&self) -> &str;
}

/// Agent event types for session lifecycle
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-rs", derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    SessionCreated {
        session_id: String,
        session_name: String,
        agent_type: String,
        workspace_path: Option<String>,
    },
    SessionDeleted {
        session_id: String,
    },
    DialogTurnStarted {
        session_id: String,
        turn_id: String,
        turn_index: u32,
        user_input: String,
    },
    DialogTurnCompleted {
        session_id: String,
        turn_id: String,
    },
    DialogTurnCancelled {
        session_id: String,
        turn_id: String,
    },
    DialogTurnFailed {
        session_id: String,
        turn_id: String,
        error: String,
    },
    TokenUsageUpdated {
        session_id: String,
        turn_id: String,
        model_id: String,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    },
    SessionStateChanged {
        session_id: String,
        new_state: String,
    },
}

/// Text chunk data structure for streaming
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-rs", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct TextChunk {
    pub session_id: String,
    pub turn_id: String,
    pub round_id: String,
    pub text: String,
    pub timestamp: i64,
    pub content_type: Option<String>, // "thinking", "response", etc.
    pub is_complete: bool,
}

/// Tool event for tracking tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-rs", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    pub session_id: String,
    pub turn_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub event_type: ToolEventType,
    // Opaque tool payloads: ts-rs cannot statically type `serde_json::Value`
    // without the `serde-json-impl` feature, so they surface as `unknown`.
    #[cfg_attr(feature = "ts-rs", ts(type = "unknown"))]
    pub params: Option<serde_json::Value>,
    #[cfg_attr(feature = "ts-rs", ts(type = "unknown"))]
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub duration_ms: Option<u64>,
}

/// Tool event types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-rs", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ToolEventType {
    Started,
    ParamsDetected,
    ParamsComplete,
    Completed,
    Failed,
    Progress,
    StreamChunk,
    ConfirmationNeeded,
}
