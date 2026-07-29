//! Tests for transport layer abstraction

use super::adapters::MockTransportAdapter;
use super::traits::{AgentEvent, TextChunk, ToolEvent, ToolEventType, TransportAdapter};
use super::TransportEmitter;
use std::sync::Arc;

#[tokio::test]
async fn test_mock_transport_adapter_agent_events() {
    let adapter = MockTransportAdapter::new();
    let session_id = "test-session-123";

    // Test session created event
    let event = AgentEvent::SessionCreated {
        session_id: session_id.to_string(),
        session_name: "Test Session".to_string(),
        agent_type: "sde".to_string(),
        workspace_path: Some("/path/to/workspace".to_string()),
    };

    adapter.emit_agent_event(session_id, event).await.unwrap();

    // Test dialog turn started event
    let event = AgentEvent::DialogTurnStarted {
        session_id: session_id.to_string(),
        turn_id: "turn-1".to_string(),
        turn_index: 1,
        user_input: "Hello, world!".to_string(),
    };

    adapter.emit_agent_event(session_id, event).await.unwrap();

    // Verify events were captured
    let events = adapter.get_captured_events().await;
    assert_eq!(events.len(), 2);

    // Both events now emit under a single tagged channel; the variant is
    // carried by the serde `type` discriminator (camelCase) instead of a
    // per-variant event name.
    assert_eq!(events[0].event_name, "agent://event");
    assert_eq!(events[0].session_id, session_id);
    assert_eq!(events[0].payload["type"], "sessionCreated");

    assert_eq!(events[1].event_name, "agent://event");
    assert_eq!(events[1].session_id, session_id);

    // Verify tagged payload structure (camelCase fields nested under `payload`).
    let turn_payload = &events[1].payload;
    assert_eq!(turn_payload["type"], "dialogTurnStarted");
    assert_eq!(turn_payload["payload"]["sessionId"], session_id);
    assert_eq!(turn_payload["payload"]["turnId"], "turn-1");
    assert_eq!(turn_payload["payload"]["turnIndex"], 1);
    assert_eq!(turn_payload["payload"]["userInput"], "Hello, world!");
}

#[tokio::test]
async fn test_transport_emitter_text_chunks() {
    let adapter = Arc::new(MockTransportAdapter::new());
    let emitter = TransportEmitter::new(adapter.clone());

    let chunk = TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        text: "This is a test chunk".to_string(),
        timestamp: 1640995200000, // Jan 1, 2022 UTC
        content_type: Some("response".to_string()),
        is_complete: false,
    };

    emitter.emit_text_chunk("session-1", chunk).await.unwrap();

    let events = adapter.get_captured_events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name, "agent://text-chunk");

    let payload = &events[0].payload;
    assert_eq!(payload["text"], "This is a test chunk");
    assert_eq!(payload["contentType"], "response");
    assert_eq!(payload["isComplete"], false);
}

#[tokio::test]
async fn test_transport_emitter_tool_events() {
    let adapter = Arc::new(MockTransportAdapter::new());
    let emitter = TransportEmitter::new(adapter.clone());

    let tool_event = ToolEvent {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        tool_id: "file-write-123".to_string(),
        tool_name: "file_write".to_string(),
        event_type: ToolEventType::Started,
        params: Some(serde_json::json!({
            "file_path": "test.rs",
            "content": "fn main() {}"
        })),
        result: None,
        error: None,
        duration_ms: None,
    };

    emitter
        .emit_tool_event("session-1", tool_event)
        .await
        .unwrap();

    let events = adapter.get_captured_events().await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_name, "agent://tool-event");

    // Flat, camelCase-serialized `ToolEvent` (no bespoke `toolEvent` nesting).
    let payload = &events[0].payload;
    assert_eq!(payload["toolName"], "file_write");
    assert_eq!(payload["eventType"], "started");
    assert_eq!(payload["params"]["file_path"], "test.rs");
}

#[tokio::test]
async fn test_stream_lifecycle() {
    let adapter = Arc::new(MockTransportAdapter::new());
    let emitter = TransportEmitter::new(adapter.clone());

    // Start stream
    emitter
        .emit_stream_start("session-1", "turn-1", "round-1")
        .await
        .unwrap();

    // Send some text chunks
    let chunk = TextChunk {
        session_id: "session-1".to_string(),
        turn_id: "turn-1".to_string(),
        round_id: "round-1".to_string(),
        text: "Streaming content...".to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        content_type: Some("thinking".to_string()),
        is_complete: false,
    };

    emitter.emit_text_chunk("session-1", chunk).await.unwrap();

    // End stream
    emitter
        .emit_stream_end("session-1", "turn-1", "round-1")
        .await
        .unwrap();

    let events = adapter.get_captured_events().await;
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event_name, "agent://stream-start");
    assert_eq!(events[1].event_name, "agent://text-chunk");
    assert_eq!(events[2].event_name, "agent://stream-end");
}

#[tokio::test]
async fn test_adapter_type() {
    let adapter = MockTransportAdapter::new();
    assert_eq!(adapter.adapter_type(), "mock");

    let emitter = TransportEmitter::new(Arc::new(adapter));
    assert_eq!(emitter.adapter_type(), "mock");
}
