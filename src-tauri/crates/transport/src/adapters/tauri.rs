//! Tauri transport adapter
//!
//! Uses Tauri's app.emit() system to send events to frontend.
//! Emits the typed event structs directly (serde is the single source of truth
//! for the wire shape), so the emitted payload always matches the ts-rs-generated
//! TypeScript type — no hand-maintained field remapping that can drift.

use crate::traits::{AgentEvent, TextChunk, ToolEvent, TransportAdapter};
use async_trait::async_trait;
use log::debug;
use serde_json::json;
use std::fmt;
use tauri::{AppHandle, Emitter};

/// Tauri transport adapter - wraps AppHandle with unified interface
pub struct TauriTransportAdapter {
    app_handle: AppHandle,
}

impl TauriTransportAdapter {
    pub fn new(app_handle: AppHandle) -> Self {
        debug!("Creating TauriTransportAdapter");
        Self { app_handle }
    }
}

impl fmt::Debug for TauriTransportAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TauriTransportAdapter")
            .field("adapter_type", &"tauri")
            .finish()
    }
}

#[async_trait]
impl TransportAdapter for TauriTransportAdapter {
    async fn emit_agent_event(&self, _session_id: &str, event: AgentEvent) -> anyhow::Result<()> {
        // Serialize the typed event directly. `AgentEvent`'s serde config
        // (`tag = "type"`, `content = "payload"`, camelCase variants/fields) is
        // the single source of truth for the wire shape — identical to what
        // ts-rs generates for the `AgentEvent` type, so the contract can't drift.
        self.app_handle.emit("agent://event", &event)?;
        Ok(())
    }

    async fn emit_text_chunk(&self, _session_id: &str, chunk: TextChunk) -> anyhow::Result<()> {
        self.app_handle.emit("agent://text-chunk", &chunk)?;
        Ok(())
    }

    async fn emit_tool_event(&self, _session_id: &str, event: ToolEvent) -> anyhow::Result<()> {
        self.app_handle.emit("agent://tool-event", &event)?;
        Ok(())
    }

    async fn emit_stream_start(
        &self,
        session_id: &str,
        turn_id: &str,
        round_id: &str,
    ) -> anyhow::Result<()> {
        self.app_handle.emit(
            "agent://stream-start",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
            }),
        )?;
        Ok(())
    }

    async fn emit_stream_end(
        &self,
        session_id: &str,
        turn_id: &str,
        round_id: &str,
    ) -> anyhow::Result<()> {
        self.app_handle.emit(
            "agent://stream-end",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
            }),
        )?;
        Ok(())
    }

    async fn emit_generic(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()> {
        self.app_handle.emit(event_name, payload)?;
        Ok(())
    }

    fn adapter_type(&self) -> &str {
        "tauri"
    }
}
