//! Mock transport adapter for testing
//!
//! Provides a test-friendly adapter that captures emitted events
//! for verification in unit tests.

#[cfg(test)]
use crate::traits::{AgentEvent, TextChunk, ToolEvent, TransportAdapter};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct EmittedEvent {
    pub event_name: String,
    pub payload: serde_json::Value,
    pub session_id: String,
}

#[cfg(test)]
#[derive(Debug)]
pub struct MockTransportAdapter {
    captured_events: Arc<Mutex<Vec<EmittedEvent>>>,
}

#[cfg(test)]
impl Default for MockTransportAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl MockTransportAdapter {
    pub fn new() -> Self {
        Self {
            captured_events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn get_captured_events(&self) -> Vec<EmittedEvent> {
        self.captured_events.lock().await.clone()
    }

    pub async fn clear_events(&self) {
        self.captured_events.lock().await.clear();
    }

    async fn capture_event(&self, event_name: &str, payload: serde_json::Value, session_id: &str) {
        let event = EmittedEvent {
            event_name: event_name.to_string(),
            payload,
            session_id: session_id.to_string(),
        };
        self.captured_events.lock().await.push(event);
    }
}

#[cfg(test)]
#[async_trait]
impl TransportAdapter for MockTransportAdapter {
    async fn emit_agent_event(&self, session_id: &str, event: AgentEvent) -> anyhow::Result<()> {
        // Mirror the Tauri adapter: serialize the typed event straight to the
        // wire so the mock captures exactly what production emits.
        let payload = serde_json::to_value(&event)?;
        self.capture_event("agent://event", payload, session_id)
            .await;
        Ok(())
    }

    async fn emit_text_chunk(&self, session_id: &str, chunk: TextChunk) -> anyhow::Result<()> {
        let payload = serde_json::to_value(&chunk)?;
        self.capture_event("agent://text-chunk", payload, session_id)
            .await;
        Ok(())
    }

    async fn emit_tool_event(&self, session_id: &str, event: ToolEvent) -> anyhow::Result<()> {
        let payload = serde_json::to_value(&event)?;
        self.capture_event("agent://tool-event", payload, session_id)
            .await;
        Ok(())
    }

    async fn emit_stream_start(
        &self,
        session_id: &str,
        turn_id: &str,
        round_id: &str,
    ) -> anyhow::Result<()> {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "roundId": round_id,
        });

        self.capture_event("agent://stream-start", payload, session_id)
            .await;
        Ok(())
    }

    async fn emit_stream_end(
        &self,
        session_id: &str,
        turn_id: &str,
        round_id: &str,
    ) -> anyhow::Result<()> {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "turnId": turn_id,
            "roundId": round_id,
        });

        self.capture_event("agent://stream-end", payload, session_id)
            .await;
        Ok(())
    }

    async fn emit_generic(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()> {
        // For generic events, we don't know the session_id, so use empty string
        self.capture_event(event_name, payload, "").await;
        Ok(())
    }

    fn adapter_type(&self) -> &str {
        "mock"
    }
}
