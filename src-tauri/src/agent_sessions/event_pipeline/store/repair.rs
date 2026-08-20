//! Post-load repair and cancel operations for `EventStore`.
//!
//! These methods are called once after loading events from SQLite to reconcile
//! state that was lost when the Rust process restarted.

use std::collections::HashMap;

use super::EventStore;
use crate::agent_sessions::event_pipeline::types::EventDisplayStatus;

impl EventStore {
    /// Repair subagent linkage after a cache load.
    ///
    /// When a session is restored from SQLite it may contain two copies of the
    /// same `agent` tool_call: one with a JS-assigned id (no `subagentSessionId`)
    /// and one with a Rust-assigned `tool-call-{callId}` id (has the field).
    /// The stamp only went to the Rust copy; the JS copy still lacks it.
    ///
    /// This method finds every `agent` tool_call event that has a
    /// `subagentSessionId` in its args and propagates it to all other tool_call
    /// events sharing the same `call_id` that are missing it.  Call once after
    /// `set()` or `merge_events()` on cache-loaded data.
    pub fn repair_subagent_links(&mut self) -> bool {
        let mut link_by_call_id: HashMap<String, serde_json::Value> = HashMap::new();

        for event in &self.events {
            if event.action_type != "tool_call" {
                continue;
            }
            let Some(ref call_id) = event.call_id else {
                continue;
            };
            let Some(sid) = event
                .args
                .as_object()
                .and_then(|m| m.get("subagentSessionId"))
                .cloned()
            else {
                continue;
            };
            link_by_call_id.insert(call_id.clone(), sid);
        }

        if link_by_call_id.is_empty() {
            return false;
        }

        let mut changed_ids = Vec::new();
        for event in self.events.iter_mut() {
            if event.action_type != "tool_call" {
                continue;
            }
            let Some(ref call_id) = event.call_id else {
                continue;
            };
            let Some(sid) = link_by_call_id.get(call_id) else {
                continue;
            };
            let already_set = event
                .args
                .as_object()
                .and_then(|m| m.get("subagentSessionId"))
                .is_some();
            if already_set {
                continue;
            }
            if let serde_json::Value::Object(ref mut args_map) = event.args {
                args_map.insert("subagentSessionId".to_string(), sid.clone());
                event.recompute_extracted();
                changed_ids.push(event.id.clone());
            }
        }

        if changed_ids.is_empty() {
            return false;
        }
        for event_id in changed_ids {
            self.mark_changed(event_id);
        }
        self.version += 1;
        true
    }

    /// Cancel all orphan interactive tool calls that are still `AwaitingUser`.
    ///
    /// Called by `es_load_from_cache` after loading events from SQLite.  When
    /// the Rust process restarts the `QuestionManager` loses its in-memory state,
    /// so any `AwaitingUser` event whose session is no longer live is a zombie:
    /// the user can see the card but clicking it will fail because the backend
    /// has no corresponding pending entry to answer.
    ///
    /// Managed-CLI question events are stamped `Pending` (not `AwaitingUser`)
    /// by `infer_display_status`, so ask-question tool calls stuck in
    /// `Pending` are swept too.
    ///
    /// This method transitions those events directly to `Completed` and stamps
    /// a minimal `result` so `extractQuestionBatch` (FE) sees `displayStatus ==
    /// "completed"` and never renders a card for them.
    ///
    /// Returns the IDs of the cancelled events so callers can log / assert.
    pub fn cancel_orphan_interactive_events(&mut self) -> Vec<String> {
        use crate::agent_sessions::event_pipeline::ingestion::normalizer::is_ask_question_action;
        let mut cancelled = Vec::new();
        for event in self.events.iter_mut() {
            let is_orphan_question = event.display_status == EventDisplayStatus::AwaitingUser
                || (event.display_status == EventDisplayStatus::Pending
                    && is_ask_question_action(
                        &event.action_type,
                        &event.function_name,
                        &event.ui_canonical,
                        &event.args,
                    ));
            if is_orphan_question {
                event.display_status = EventDisplayStatus::Completed;
                // Stamp a minimal result so extractQuestionBatch treats it as
                // answered (it checks result.success and result.error; a plain
                // cancelled status string is sufficient to skip rendering).
                event.result = serde_json::json!({
                    "status": "cancelled",
                    "content": "Session restarted — question was cancelled.",
                    "observation": "Session restarted — question was cancelled.",
                });
                cancelled.push(event.id.clone());
            }
        }
        if !cancelled.is_empty() {
            for event_id in &cancelled {
                self.mark_changed(event_id.clone());
            }
            self.version += 1;
        }
        cancelled
    }
}
