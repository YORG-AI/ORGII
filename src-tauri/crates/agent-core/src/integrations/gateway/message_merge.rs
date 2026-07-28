//! Message merge buffer.
//!
//! When a user sends multiple messages in quick succession (e.g. a photo album,
//! or split-up long typing), we coalesce them into a single `InboundMessage`
//! before forwarding to the channel inbound handler. This mirrors `hermes-agent`'s
//! `merge_pending_message_event()`.
//!
//! ## Algorithm
//!
//! A per-session entry holds:
//!   - A list of pending `InboundMessage`s
//!   - A deadline (`Instant`) past which the batch is flushed
//!
//! On each new message:
//!   1. Push to the pending list and reset the deadline to `now + MERGE_WINDOW`.
//!   2. The background flush task sleeps until the exact earliest deadline,
//!      waking early when a new message changes the schedule.
//!   3. Draining merges all pending messages by concatenating their `content`
//!      with `\n---\n` separators, preserving the first message's metadata
//!      (channel, chat_id, sender_id, timestamp, session_key_override).
//!
//! Sessions with infrequent messages (most normal sessions) are unaffected:
//! the first message will be flushed after one 500 ms window.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

use crate::bus::InboundMessage;

/// The coalescing window. Messages received within this window of each other
/// are merged into one.
const MERGE_WINDOW: Duration = Duration::from_millis(600);

/// Separator used to join merged message contents.
const MERGE_SEPARATOR: &str = "\n\n---\n\n";
const MAX_PENDING_SESSIONS: usize = 256;
const MAX_MESSAGES_PER_SESSION: usize = 64;
const MAX_BYTES_PER_SESSION: usize = 1024 * 1024;
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;

/// Pending entry for one logical conversation slot.
struct PendingMergeBatch {
    /// Messages accumulated so far.
    messages: Vec<InboundMessage>,
    /// Flush when the current time exceeds this deadline.
    deadline: Instant,
    retained_bytes: usize,
}

#[derive(Default)]
struct MergeState {
    batches: HashMap<String, PendingMergeBatch>,
    retained_bytes: usize,
}

/// Shared merge buffer, keyed by session key (`InboundMessage::session_key()`).
#[derive(Clone)]
pub struct MergeBuffer {
    inner: Arc<Mutex<MergeState>>,
    wake: Arc<Notify>,
}

impl Default for MergeBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl MergeBuffer {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MergeState::default())),
            wake: Arc::new(Notify::new()),
        }
    }

    /// Push a message and return batches forced out by a hard memory bound.
    ///
    /// Overflow never grows the buffer and never silently drops a message:
    /// the oldest/current batch is flushed immediately to the handler.
    pub async fn push(&self, msg: InboundMessage) -> Vec<InboundMessage> {
        let key = msg.session_key();
        let message_bytes = retained_message_bytes(&msg);
        if message_bytes > MAX_BYTES_PER_SESSION {
            return vec![msg];
        }

        let mut state = self.inner.lock().await;
        let mut forced = Vec::new();
        let current_would_overflow = state.batches.get(&key).is_some_and(|entry| {
            entry.messages.len() >= MAX_MESSAGES_PER_SESSION
                || entry.retained_bytes.saturating_add(message_bytes) > MAX_BYTES_PER_SESSION
        });
        if current_would_overflow {
            if let Some(entry) = state.batches.remove(&key) {
                state.retained_bytes = state.retained_bytes.saturating_sub(entry.retained_bytes);
                if let Some(merged) = merge_messages(entry.messages) {
                    forced.push(merged);
                }
            }
        }

        while (!state.batches.contains_key(&key) && state.batches.len() >= MAX_PENDING_SESSIONS)
            || state.retained_bytes.saturating_add(message_bytes) > MAX_PENDING_BYTES
        {
            let Some(oldest_key) = state
                .batches
                .iter()
                .min_by_key(|(_, entry)| entry.deadline)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = state.batches.remove(&oldest_key) {
                state.retained_bytes = state.retained_bytes.saturating_sub(entry.retained_bytes);
                if let Some(merged) = merge_messages(entry.messages) {
                    forced.push(merged);
                }
            }
        }

        let entry = state
            .batches
            .entry(key)
            .or_insert_with(|| PendingMergeBatch {
                messages: Vec::new(),
                deadline: Instant::now() + MERGE_WINDOW,
                retained_bytes: 0,
            });
        entry.messages.push(msg);
        entry.retained_bytes = entry.retained_bytes.saturating_add(message_bytes);
        entry.deadline = Instant::now() + MERGE_WINDOW;
        state.retained_bytes = state.retained_bytes.saturating_add(message_bytes);
        drop(state);
        self.wake.notify_one();
        forced
    }

    /// Drain all sessions whose deadline has passed.
    ///
    /// Returns a list of merged `InboundMessage`s ready for processing.
    pub async fn drain_ready(&self) -> Vec<InboundMessage> {
        let now = Instant::now();
        let mut state = self.inner.lock().await;
        let mut ready_keys: Vec<String> = Vec::new();
        for (key, entry) in state.batches.iter() {
            if now >= entry.deadline {
                ready_keys.push(key.clone());
            }
        }
        let mut results = Vec::new();
        for key in ready_keys {
            if let Some(entry) = state.batches.remove(&key) {
                state.retained_bytes = state.retained_bytes.saturating_sub(entry.retained_bytes);
                if let Some(merged) = merge_messages(entry.messages) {
                    results.push(merged);
                }
            }
        }
        results
    }

    pub async fn next_deadline_delay(&self) -> Option<Duration> {
        let state = self.inner.lock().await;
        let deadline = state.batches.values().map(|entry| entry.deadline).min()?;
        Some(deadline.saturating_duration_since(Instant::now()))
    }

    pub async fn wait_for_change(&self) {
        self.wake.notified().await;
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }
}

fn retained_message_bytes(message: &InboundMessage) -> usize {
    let metadata_bytes = serde_json::to_string(&message.metadata)
        .map(|value| value.len())
        .unwrap_or(MAX_BYTES_PER_SESSION);
    message
        .content
        .len()
        .saturating_add(message.channel.len())
        .saturating_add(message.chat_id.len())
        .saturating_add(message.sender_id.len())
        .saturating_add(message.media.iter().map(String::len).sum::<usize>())
        .saturating_add(metadata_bytes)
}

/// Merge a list of messages into one.
///
/// Uses the first message as the base (channel, chat_id, sender_id, etc.)
/// and concatenates all `content` values with a separator. Returns `None`
/// only if the list is empty.
fn merge_messages(messages: Vec<InboundMessage>) -> Option<InboundMessage> {
    if messages.is_empty() {
        return None;
    }
    if messages.len() == 1 {
        return Some(messages.into_iter().next().unwrap());
    }

    let mut base = messages[0].clone();
    let parts: Vec<&str> = messages.iter().map(|m| m.content.as_str()).collect();
    base.content = parts.join(MERGE_SEPARATOR);
    // Keep the most recent timestamp.
    if let Some(last) = messages.last() {
        base.timestamp = last.timestamp;
    }
    Some(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_msg(channel: &str, content: &str) -> InboundMessage {
        InboundMessage {
            channel: channel.to_string(),
            sender_id: "user1".to_string(),
            chat_id: "chat1".to_string(),
            content: content.to_string(),
            timestamp: Utc::now(),
            media: vec![],
            metadata: Default::default(),
            session_key_override: None,
        }
    }

    #[test]
    fn test_merge_single() {
        let msg = make_msg("telegram:default", "hello");
        let merged = merge_messages(vec![msg.clone()]).unwrap();
        assert_eq!(merged.content, "hello");
    }

    #[test]
    fn test_merge_multiple() {
        let msgs = vec![
            make_msg("telegram:default", "part one"),
            make_msg("telegram:default", "part two"),
            make_msg("telegram:default", "part three"),
        ];
        let merged = merge_messages(msgs).unwrap();
        assert!(merged.content.contains("part one"));
        assert!(merged.content.contains("part two"));
        assert!(merged.content.contains("part three"));
        assert!(merged.content.contains(MERGE_SEPARATOR.trim()));
    }

    #[test]
    fn test_merge_empty() {
        assert!(merge_messages(vec![]).is_none());
    }

    #[tokio::test]
    async fn test_buffer_push_and_drain() {
        let buf = MergeBuffer::new();
        assert!(buf
            .push(make_msg("telegram:default", "msg1"))
            .await
            .is_empty());
        assert!(buf
            .push(make_msg("telegram:default", "msg2"))
            .await
            .is_empty());

        // Deadline hasn't passed yet — nothing ready.
        let ready = buf.drain_ready().await;
        assert!(ready.is_empty());

        // Sleep past the merge window.
        tokio::time::sleep(MERGE_WINDOW + Duration::from_millis(50)).await;
        let ready = buf.drain_ready().await;
        assert_eq!(ready.len(), 1);
        let merged = &ready[0];
        assert!(merged.content.contains("msg1"));
        assert!(merged.content.contains("msg2"));

        // Buffer should be empty now.
        let ready2 = buf.drain_ready().await;
        assert!(ready2.is_empty());
    }

    #[tokio::test]
    async fn oversized_session_batch_flushes_instead_of_growing() {
        let buf = MergeBuffer::new();
        for index in 0..MAX_MESSAGES_PER_SESSION {
            assert!(buf
                .push(make_msg("telegram:default", &format!("msg-{index}")))
                .await
                .is_empty());
        }
        let forced = buf.push(make_msg("telegram:default", "overflow")).await;
        assert_eq!(forced.len(), 1);
        assert!(forced[0].content.contains("msg-0"));
    }
}
