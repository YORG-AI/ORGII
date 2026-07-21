//! Streaming Buffer
//!
//! Accumulates streaming delta events (message, thinking) in Rust.
//! Eliminates frontend delta accumulation, providing a single source of truth.
//!
//! ## Design
//!
//! Instead of:
//!   Rust → delta → WebSocket → TS accumulator → Jotai → UI
//!
//! We now have:
//!   Rust → delta → StreamingBuffer → complete event → EventStore → WebSocket → UI
//!
//! ## Features
//!
//! - Accumulates consecutive deltas by type (message, thinking)
//! - Auto-completes after inactivity timeout (5s default)
//! - Emits complete events to EventStore
//! - Thread-safe for concurrent delta reception
//!
//! ## Usage
//!
//! ```ignore
//! let buffer = StreamingBuffer::new(5000); // 5s timeout
//! buffer.append_message_delta(session_id, content);
//! // ... more deltas ...
//! // On completion or timeout:
//! let event = buffer.complete_message(session_id);
//! event_store.upsert(event);
//! ```

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use core_types::session_event::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};
use uuid::Uuid;

// ============================================================================
// CLI Streaming Buffer Singleton
// ============================================================================

/// Global streaming buffer shared by all CLI agent sessions.
///
/// CLI parsers emit fine-grained delta chunks which are accumulated here.
/// On completion (or tool-call / session-end), the buffer is flushed into a
/// single `SessionEvent` that is broadcast as `agent:streaming_complete`.
pub static CLI_STREAMING_BUFFER: LazyLock<StreamingBuffer> =
    LazyLock::new(StreamingBuffer::with_default_timeout);

/// Maximum accumulated content length (500KB)
const MAX_CONTENT_LENGTH: usize = 500_000;

/// Default inactivity timeout (5 seconds)
const DEFAULT_TIMEOUT_MS: u64 = 5000;

// ============================================================================
// Types
// ============================================================================

/// Type of streaming content
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StreamType {
    Message,
    Thinking,
}

/// Active streaming state for a single stream
#[derive(Debug, Clone)]
struct StreamState {
    stream_type: StreamType,
    session_id: String,
    content: String,
    last_updated_at: Instant,
}

impl StreamState {
    fn new(stream_type: StreamType, session_id: &str, initial_content: &str) -> Self {
        Self {
            stream_type,
            session_id: session_id.to_string(),
            content: initial_content.to_string(),
            last_updated_at: Instant::now(),
        }
    }

    fn append(&mut self, content: &str) {
        self.last_updated_at = Instant::now();
        self.content.push_str(content);
        // Cap content length - ensure we stay within limit even after trying
        // to preserve line boundaries
        if self.content.len() > MAX_CONTENT_LENGTH {
            // Calculate how much to trim
            let excess = self.content.len() - MAX_CONTENT_LENGTH;
            // Find first newline after excess point to preserve line boundaries
            let start = self.content[excess..]
                .find('\n')
                .map(|i| excess + i + 1)
                .unwrap_or(excess);
            self.content = self.content[start..].to_string();
            // Double-check we're within limit (newline search might overshoot)
            if self.content.len() > MAX_CONTENT_LENGTH {
                self.content = self.content[self.content.len() - MAX_CONTENT_LENGTH..].to_string();
            }
        }
    }

    fn is_expired(&self, timeout: Duration) -> bool {
        self.last_updated_at.elapsed() > timeout
    }

    fn to_event(&self, event_id: &str) -> SessionEvent {
        let now = chrono::Utc::now().to_rfc3339();
        let mut event = match self.stream_type {
            StreamType::Message => SessionEvent {
                id: event_id.to_string(),
                chunk_id: Some(event_id.to_string()),
                session_id: self.session_id.clone(),
                created_at: now,
                function_name: "assistant".to_string(),
                ui_canonical: "agent_message".to_string(),
                action_type: "assistant".to_string(),
                args: serde_json::json!({}),
                result: serde_json::json!({
                    "content": self.content,
                    "observation": self.content,
                    "role": "assistant",
                    "is_delta": false
                }),
                source: EventSource::Assistant,
                display_text: self.content.clone(),
                display_status: EventDisplayStatus::Completed,
                display_variant: EventDisplayVariant::Message,
                activity_status: ActivityStatus::Agent,
                thread_id: None,
                process_id: None,
                call_id: None,
                file_path: None,
                command: None,
                is_delta: Some(false),
                repo_id: None,
                repo_path: None,
                extracted: None,
                payload_refs: Vec::new(),
                shell_replay: None,
                shell_replay_bookmarks: None,
                last_extract_at: None,
            },
            StreamType::Thinking => SessionEvent {
                id: event_id.to_string(),
                chunk_id: Some(event_id.to_string()),
                session_id: self.session_id.clone(),
                created_at: now,
                function_name: "thinking".to_string(),
                ui_canonical: "thinking".to_string(),
                action_type: "llm_thinking".to_string(),
                args: serde_json::json!({}),
                result: serde_json::json!({
                    "thought": self.content,
                    "content": self.content,
                    "observation": self.content,
                    "is_delta": false
                }),
                source: EventSource::Assistant,
                display_text: self.content.clone(),
                display_status: EventDisplayStatus::Completed,
                display_variant: EventDisplayVariant::Thinking,
                activity_status: ActivityStatus::Agent,
                thread_id: None,
                process_id: None,
                call_id: None,
                file_path: None,
                command: None,
                is_delta: Some(false),
                repo_id: None,
                repo_path: None,
                extracted: None,
                payload_refs: Vec::new(),
                shell_replay: None,
                shell_replay_bookmarks: None,
                last_extract_at: None,
            },
        };
        event.recompute_extracted();
        event
    }
}

// ============================================================================
// StreamingBuffer
// ============================================================================

/// Per-session streaming buffer key: (session_id, stream_type)
type BufferKey = (String, StreamType);

fn stream_event_id(stream_type: StreamType, session_id: &str, seq: u64) -> String {
    let unique = Uuid::new_v4().simple();
    match stream_type {
        StreamType::Message => format!("stream-msg-{}-{}-{}", session_id, seq, unique),
        StreamType::Thinking => format!("stream-think-{}-{}-{}", session_id, seq, unique),
    }
}

/// Thread-safe streaming buffer for accumulating deltas
pub struct StreamingBuffer {
    streams: Arc<Mutex<HashMap<BufferKey, StreamState>>>,
    /// Monotonic segment counter per (session, stream_type) so every flushed
    /// segment within a turn gets a distinct event id. Without this, a
    /// turn that interleaves `text → tool → text` would flush two segments
    /// with the same id (`stream-msg-{session}`) and the frontend's upsert
    /// would overwrite the first segment's text with the second.
    segment_counters: Arc<Mutex<HashMap<BufferKey, u64>>>,
    timeout_ms: u64,
}

impl StreamingBuffer {
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            streams: Arc::new(Mutex::new(HashMap::new())),
            segment_counters: Arc::new(Mutex::new(HashMap::new())),
            timeout_ms,
        }
    }

    pub fn with_default_timeout() -> Self {
        Self::new(DEFAULT_TIMEOUT_MS)
    }

    /// Append a message delta. Returns true if a new stream was started.
    pub fn append_message_delta(&self, session_id: &str, content: &str) -> bool {
        self.append_delta(StreamType::Message, session_id, content)
    }

    /// Append a thinking delta. Returns true if a new stream was started.
    pub fn append_thinking_delta(&self, session_id: &str, content: &str) -> bool {
        self.append_delta(StreamType::Thinking, session_id, content)
    }

    fn append_delta(&self, stream_type: StreamType, session_id: &str, content: &str) -> bool {
        let key = (session_id.to_string(), stream_type);
        let mut streams = self.streams.lock().unwrap();

        if let Some(state) = streams.get_mut(&key) {
            state.append(content);
            false
        } else {
            streams.insert(key, StreamState::new(stream_type, session_id, content));
            true
        }
    }

    /// Complete and remove a stream, returning the accumulated event.
    /// Returns None if no stream exists for this session/type.
    pub fn complete_message(&self, session_id: &str) -> Option<SessionEvent> {
        self.complete_stream(StreamType::Message, session_id)
    }

    /// Complete and remove a thinking stream, returning the accumulated event.
    pub fn complete_thinking(&self, session_id: &str) -> Option<SessionEvent> {
        self.complete_stream(StreamType::Thinking, session_id)
    }

    fn complete_stream(&self, stream_type: StreamType, session_id: &str) -> Option<SessionEvent> {
        let key = (session_id.to_string(), stream_type);
        let mut streams = self.streams.lock().unwrap();
        let state = streams.remove(&key)?;

        // Bump segment counter so each flushed segment has a distinct id.
        // The first segment within a session gets seq=1, the next gets seq=2, etc.
        // The counter is kept alive across multiple turns for the same session
        // so that IDs remain unique per (session, stream_type) pair.
        // Entries are purged by clear_session() when the session ends.
        let seq = {
            let mut counters = self.segment_counters.lock().unwrap();
            let entry = counters.entry(key).or_insert(0);
            *entry += 1;
            *entry
        };

        let event_id = stream_event_id(stream_type, session_id, seq);
        Some(state.to_event(&event_id))
    }

    /// Get current accumulated content for a stream (without completing).
    pub fn get_content(&self, stream_type: StreamType, session_id: &str) -> Option<String> {
        let key = (session_id.to_string(), stream_type);
        let streams = self.streams.lock().unwrap();
        streams.get(&key).map(|s| s.content.clone())
    }

    /// Check if a stream exists and has content.
    pub fn has_stream(&self, stream_type: StreamType, session_id: &str) -> bool {
        let key = (session_id.to_string(), stream_type);
        let streams = self.streams.lock().unwrap();
        streams.contains_key(&key)
    }

    /// Clear all streams for a session. Also resets segment counters so the
    /// next session with the same id starts at seq=1.
    pub fn clear_session(&self, session_id: &str) {
        let mut streams = self.streams.lock().unwrap();
        streams.retain(|(sid, _), _| sid != session_id);
        let mut counters = self.segment_counters.lock().unwrap();
        counters.retain(|(sid, _), _| sid != session_id);
    }

    /// Discard any in-flight streams for a session WITHOUT resetting segment
    /// counters. Used by stream-error retry: the partial accumulation belongs
    /// to an aborted LLM response and must not prefix the retry's regenerated
    /// text, while counters keep advancing so retracted segment ids are never
    /// reused by later flushes.
    pub fn discard_streams(&self, session_id: &str) {
        let mut streams = self.streams.lock().unwrap();
        streams.retain(|(sid, _), _| sid != session_id);
    }

    /// Flush expired streams. Returns events for streams that timed out.
    /// Call this periodically (e.g., every second) to auto-complete stale streams.
    pub fn flush_expired(&self) -> Vec<SessionEvent> {
        let timeout = Duration::from_millis(self.timeout_ms);
        let mut streams = self.streams.lock().unwrap();

        let expired_keys: Vec<BufferKey> = streams
            .iter()
            .filter(|(_, state)| state.is_expired(timeout))
            .map(|(key, _)| key.clone())
            .collect();

        let mut events = Vec::with_capacity(expired_keys.len());
        for key in expired_keys {
            if let Some(state) = streams.remove(&key) {
                // Same per-segment counter as `complete_stream` — an expired
                // flush is just an auto-flush, it must also get a unique id.
                let seq = {
                    let mut counters = self.segment_counters.lock().unwrap();
                    let entry = counters.entry(key.clone()).or_insert(0);
                    *entry += 1;
                    *entry
                };
                let event_id = stream_event_id(state.stream_type, &state.session_id, seq);
                events.push(state.to_event(&event_id));
            }
        }
        events
    }
}

impl Default for StreamingBuffer {
    fn default() -> Self {
        Self::with_default_timeout()
    }
}

// ============================================================================
// CLI helpers — convenience wrappers around CLI_STREAMING_BUFFER
// ============================================================================

/// Flush all pending streams for a CLI session, returning completed events.
pub fn cli_flush_session(session_id: &str) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    if let Some(evt) = CLI_STREAMING_BUFFER.complete_message(session_id) {
        events.push(evt);
    }
    if let Some(evt) = CLI_STREAMING_BUFFER.complete_thinking(session_id) {
        events.push(evt);
    }
    events
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_complete_message() {
        let buffer = StreamingBuffer::new(5000);
        buffer.append_message_delta("sess-1", "Hello ");
        buffer.append_message_delta("sess-1", "world!");

        let event = buffer.complete_message("sess-1").unwrap();
        assert_eq!(event.display_variant, EventDisplayVariant::Message);
        assert!(event.result["content"]
            .as_str()
            .unwrap()
            .contains("Hello world!"));
        assert_eq!(event.result["is_delta"], false);

        // After completion, stream should be gone
        assert!(buffer.complete_message("sess-1").is_none());
    }

    #[test]
    fn test_append_and_complete_thinking() {
        let buffer = StreamingBuffer::new(5000);
        buffer.append_thinking_delta("sess-1", "Let me think...");

        let event = buffer.complete_thinking("sess-1").unwrap();
        assert_eq!(event.display_variant, EventDisplayVariant::Thinking);
        assert!(event.result["thought"]
            .as_str()
            .unwrap()
            .contains("Let me think"));
    }

    #[test]
    fn test_separate_streams_per_session() {
        let buffer = StreamingBuffer::new(5000);
        buffer.append_message_delta("sess-1", "Session 1");
        buffer.append_message_delta("sess-2", "Session 2");

        let event1 = buffer.complete_message("sess-1").unwrap();
        let event2 = buffer.complete_message("sess-2").unwrap();

        assert!(event1.result["content"]
            .as_str()
            .unwrap()
            .contains("Session 1"));
        assert!(event2.result["content"]
            .as_str()
            .unwrap()
            .contains("Session 2"));
    }

    #[test]
    fn test_separate_streams_per_type() {
        let buffer = StreamingBuffer::new(5000);
        buffer.append_message_delta("sess-1", "Message");
        buffer.append_thinking_delta("sess-1", "Thinking");

        assert!(buffer.has_stream(StreamType::Message, "sess-1"));
        assert!(buffer.has_stream(StreamType::Thinking, "sess-1"));

        let msg = buffer.complete_message("sess-1").unwrap();
        let think = buffer.complete_thinking("sess-1").unwrap();

        assert!(msg.result["content"].as_str().unwrap().contains("Message"));
        assert!(think.result["thought"]
            .as_str()
            .unwrap()
            .contains("Thinking"));
    }

    #[test]
    fn test_clear_session() {
        let buffer = StreamingBuffer::new(5000);
        buffer.append_message_delta("sess-1", "Test");
        buffer.append_thinking_delta("sess-1", "Test");

        buffer.clear_session("sess-1");

        assert!(!buffer.has_stream(StreamType::Message, "sess-1"));
        assert!(!buffer.has_stream(StreamType::Thinking, "sess-1"));
    }

    #[test]
    fn test_content_capping() {
        let buffer = StreamingBuffer::new(5000);
        // First append brings us to limit
        let initial_content = "x".repeat(MAX_CONTENT_LENGTH - 100);
        buffer.append_message_delta("sess-1", &initial_content);

        // Second append exceeds limit, triggering capping
        let extra_content = "y".repeat(200);
        buffer.append_message_delta("sess-1", &extra_content);

        let content = buffer.get_content(StreamType::Message, "sess-1").unwrap();
        assert!(
            content.len() <= MAX_CONTENT_LENGTH,
            "Content length {} exceeds max {}",
            content.len(),
            MAX_CONTENT_LENGTH
        );
        // Should have trimmed from the beginning
        assert!(content.starts_with('x') || content.starts_with('y'));
    }

    #[test]
    fn separate_handler_instances_do_not_reuse_stream_event_ids() {
        let first_handler_buffer = StreamingBuffer::new(5000);
        first_handler_buffer.append_message_delta("sess-1", "first turn");
        let first = first_handler_buffer
            .complete_message("sess-1")
            .expect("first turn event");

        let second_handler_buffer = StreamingBuffer::new(5000);
        second_handler_buffer.append_message_delta("sess-1", "second turn");
        let second = second_handler_buffer
            .complete_message("sess-1")
            .expect("second turn event");

        assert_ne!(first.id, second.id);
        assert!(first.id.starts_with("stream-msg-sess-1-1-"));
        assert!(second.id.starts_with("stream-msg-sess-1-1-"));
    }

    /// Interleaved scenario (text → tool → text within a single turn):
    /// the caller flushes at the tool boundary so the two text segments
    /// are delivered as two separate streaming_complete events. Each
    /// flushed event must carry a DISTINCT id — otherwise the frontend's
    /// upsert will overwrite the first segment with the second.
    #[test]
    fn interleaved_flush_emits_distinct_event_ids() {
        let buffer = StreamingBuffer::new(5000);

        // Segment 1: model says something before calling the tool.
        buffer.append_message_delta("sess-1", "Looking it up.");
        let first = buffer.complete_message("sess-1").expect("first segment");

        // Segment 2: model resumes narration after the tool result comes back.
        buffer.append_message_delta("sess-1", "Here you go.");
        let second = buffer.complete_message("sess-1").expect("second segment");

        assert!(
            first.id != second.id,
            "interleaved segments must have distinct event ids, both were {:?}",
            first.id
        );
        assert!(
            first.result["content"]
                .as_str()
                .unwrap()
                .contains("Looking it up."),
            "first segment must carry only its own text, got {:?}",
            first.result
        );
        assert!(
            second.result["content"]
                .as_str()
                .unwrap()
                .contains("Here you go."),
            "second segment must carry only its own text, got {:?}",
            second.result
        );
        assert!(
            !second.result["content"]
                .as_str()
                .unwrap()
                .contains("Looking it up."),
            "second segment leaked text from the first, got {:?}",
            second.result
        );
    }
}
