//! Single-event and batch event operations for `EventStore`.
//!
//! Covers get/update/upsert, streaming finalization, transcript dedup,
//! stream placeholder replacement, shell output stamping, and clear.

use std::collections::HashSet;

use super::helpers::{
    is_authoritative_transcript_message, is_completed_authoritative_stream_transcript,
    is_synthetic_transcript_placeholder, normalized_event_text,
    stream_placeholder_prefix_for_authoritative, transcript_message_key,
};
use super::EventStore;
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventSource, SessionEvent, SessionEventPatch,
};

impl EventStore {
    pub fn get_by_id(&self, id: &str) -> Option<&SessionEvent> {
        self.id_index.get(id).map(|&idx| &self.events[idx])
    }

    /// Update a single event by ID via a patch. O(1) lookup.
    pub fn update_by_id(&mut self, id: &str, patch: &SessionEventPatch) -> bool {
        if let Some(&idx) = self.id_index.get(id) {
            patch.apply_to(&mut self.events[idx]);
            self.mark_changed(id.to_string());
            self.version += 1;
            true
        } else {
            false
        }
    }

    /// Upsert: update existing event by ID, or append if not found.
    pub fn upsert(&mut self, mut event: SessionEvent) {
        self.mark_live_partial_if_windowed();
        self.stamp_repo(&mut event);
        if self.replace_matching_stream_placeholder(&mut event) {
            self.version += 1;
            return;
        }
        if self.replace_duplicate_stream_transcript_in_current_turn(&mut event) {
            self.version += 1;
            return;
        }

        if let Some(&idx) = self.id_index.get(&event.id) {
            if Self::would_downgrade_terminal_tool_call(&self.events[idx], &event) {
                return;
            }
            if let Some(ref old_cid) = self.events[idx].call_id {
                self.call_id_index.remove(old_cid);
            }
            if let Some(ref new_cid) = event.call_id {
                self.call_id_index.insert(new_cid.clone(), idx);
            }
            let event_id = event.id.clone();
            self.events[idx] = event;
            self.mark_changed(event_id);
        } else {
            if is_authoritative_transcript_message(&event) {
                self.remove_matching_synthetic_transcript_placeholders(&event);
            }
            let event_id = event.id.clone();
            let idx = self.events.len();
            self.insert_index_entries(&event, idx);
            self.events.push(event);
            self.mark_changed(event_id);
            self.cap_events();
        }
        self.version += 1;
    }

    /// Complete the last event with `display_status == Running`.
    ///
    /// Scans from the end for O(1) typical case. Returns the ID of the
    /// completed event, if any.
    ///
    /// **`AwaitingUser` events are intentionally skipped.** They represent
    /// interactive tool calls (`ask_user_questions`, etc.) blocking the
    /// agent turn for arbitrary user-input duration; only the explicit
    /// `agent:interaction_finalized` path (via `merge_events`) is allowed
    /// to transition them to `Completed`. Treating them as generic
    /// "running" events here was the cause of the AskQuestionCard
    /// disappearing the moment `agent:complete` arrived for the surrounding
    /// turn.
    pub fn complete_last_running(&mut self) -> Option<String> {
        for idx in (0..self.events.len()).rev() {
            if self.events[idx].display_status == EventDisplayStatus::Running {
                self.events[idx].display_status = EventDisplayStatus::Completed;
                let event_id = self.events[idx].id.clone();
                self.mark_changed(event_id.clone());
                self.version += 1;
                return Some(event_id);
            }
        }
        None
    }

    /// Mark all in-flight streaming placeholders as finalized.
    ///
    /// TS-side delta accumulation creates placeholder events with
    /// `is_delta = Some(true)`. When the agent transitions from text
    /// streaming to tool execution, those placeholders must be flipped
    /// to `is_delta = Some(false)` **before** the tool_call event is
    /// pushed, so the `es:changed` snapshot already carries the correct
    /// state and the frontend never renders a stale `StreamingCursor`.
    pub fn finalize_streaming_events(&mut self) -> bool {
        let mut changed_ids = Vec::new();
        for event in &mut self.events {
            if event.is_delta == Some(true) {
                event.is_delta = Some(false);
                if event.display_status == EventDisplayStatus::Running {
                    event.display_status = EventDisplayStatus::Completed;
                }
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

    /// Batch-update multiple events by their IDs with the same patch.
    /// Returns the number of events updated.
    pub fn patch_by_ids(&mut self, ids: &[String], patch: &SessionEventPatch) -> usize {
        let mut count = 0;
        for id in ids {
            if let Some(&idx) = self.id_index.get(id) {
                patch.apply_to(&mut self.events[idx]);
                count += 1;
            }
        }
        if count > 0 {
            for id in ids {
                self.mark_changed(id.clone());
            }
            self.version += 1;
        }
        count
    }

    /// Keep only events that appear strictly before the event with the given ID.
    ///
    /// Finds the position of `event_id` in the ordered event list, then truncates
    /// everything from that position onward. If the ID is not found, the store is
    /// left unchanged and `false` is returned.
    ///
    /// Used by the "edit user message" flow to atomically splice the local event
    /// list without a round-trip get-then-set, eliminating the race where agent
    /// events could arrive between the TS-side read and write.
    pub fn truncate_before_id(&mut self, event_id: &str) -> bool {
        match self.id_index.get(event_id) {
            Some(&idx) => {
                let removed_ids: Vec<String> = self.events[idx..]
                    .iter()
                    .map(|event| event.id.clone())
                    .collect();
                self.events.truncate(idx);
                for removed_id in removed_ids {
                    self.mark_removed(removed_id);
                }
                self.rebuild_indexes();
                self.version += 1;
                true
            }
            None => false,
        }
    }

    /// Remove events whose IDs match a given prefix.
    /// Returns the number of events removed.
    pub fn remove_by_id_prefix(&mut self, prefix: &str) -> usize {
        let removed_ids: Vec<String> = self
            .events
            .iter()
            .filter(|event| event.id.starts_with(prefix))
            .map(|event| event.id.clone())
            .collect();
        let removed = removed_ids.len();
        if removed > 0 {
            self.events.retain(|e| !e.id.starts_with(prefix));
            for event_id in removed_ids {
                self.mark_removed(event_id);
            }
            self.rebuild_indexes();
            self.version += 1;
        }
        removed
    }

    /// Remove events by exact ids. Ids not present are ignored.
    /// Returns the number of events actually removed.
    pub fn remove_by_ids(&mut self, ids: &[String]) -> usize {
        let existing_ids: Vec<String> = self
            .events
            .iter()
            .filter(|event| ids.contains(&event.id))
            .map(|event| event.id.clone())
            .collect();
        self.remove_events_by_ids(existing_ids)
    }

    pub fn remove_synthetic_user_inputs(&mut self) -> usize {
        let removed_ids: Vec<String> = self
            .events
            .iter()
            .filter(|event| {
                event.source == EventSource::User && is_synthetic_transcript_placeholder(event)
            })
            .map(|event| event.id.clone())
            .collect();
        let removed = removed_ids.len();
        if removed > 0 {
            self.events.retain(|event| {
                !(event.source == EventSource::User && is_synthetic_transcript_placeholder(event))
            });
            for event_id in removed_ids {
                self.mark_removed(event_id);
            }
            self.rebuild_indexes();
            self.version += 1;
        }
        removed
    }

    /// Replace a single event by ID, and remove another by ID atomically.
    /// Used for stream finalization: remove the streaming placeholder, insert final event.
    pub fn replace_and_remove(
        &mut self,
        remove_id: Option<&str>,
        mut new_event: SessionEvent,
    ) -> bool {
        self.stamp_repo(&mut new_event);
        if let Some(rid) = remove_id {
            if let Some(&remove_idx) = self.id_index.get(rid) {
                let placeholder_created_at = self.events[remove_idx].created_at.clone();

                if let Some(existing_new_idx) = self.id_index.get(&new_event.id).copied() {
                    if existing_new_idx != remove_idx {
                        new_event.created_at = placeholder_created_at;
                        let removed_id = self.events[remove_idx].id.clone();
                        self.events.remove(remove_idx);
                        let target_idx = if existing_new_idx > remove_idx {
                            existing_new_idx - 1
                        } else {
                            existing_new_idx
                        };
                        let new_id = new_event.id.clone();
                        self.events[target_idx] = new_event;
                        self.mark_removed(removed_id);
                        self.mark_changed(new_id);
                        self.rebuild_indexes();
                        self.version += 1;
                        return true;
                    }
                }

                if let Some(ref old_cid) = self.events[remove_idx].call_id {
                    self.call_id_index.remove(old_cid);
                }
                new_event.created_at = placeholder_created_at;
                let new_id = new_event.id.clone();
                let removed_id = self.events[remove_idx].id.clone();
                self.events[remove_idx] = new_event;
                if removed_id != new_id {
                    self.mark_removed(removed_id);
                }
                self.mark_changed(new_id);
                self.rebuild_indexes();
                self.version += 1;
                return true;
            }
        }
        self.upsert(new_event);
        true
    }

    /// Find the last shell tool_call event (scanning from end, stopping at processed shell).
    /// Update its args with the given streamOutput content.
    pub fn update_last_shell_output(
        &mut self,
        stream_output: String,
        shell_tools: &[&str],
    ) -> Option<String> {
        for idx in (0..self.events.len()).rev() {
            if self.events[idx].activity_status == ActivityStatus::Processed
                && shell_tools.contains(&self.events[idx].function_name.as_str())
            {
                break;
            }
            if self.events[idx].action_type == "tool_call"
                && shell_tools.contains(&self.events[idx].function_name.as_str())
            {
                if let serde_json::Value::Object(ref mut args_map) = self.events[idx].args {
                    args_map.insert(
                        "streamOutput".to_string(),
                        serde_json::Value::String(stream_output),
                    );
                }
                let event_id = self.events[idx].id.clone();
                self.mark_changed(event_id.clone());
                self.version += 1;
                return Some(event_id);
            }
        }
        None
    }

    /// Find the last shell tool_call event and update its process info (pid, status, exit code, log path).
    /// Used by ShellProcessStarted/Backgrounded/Exited events to populate TerminalBlock UI.
    ///
    /// Matching logic:
    /// - For "running" status (process started): find the last unprocessed shell tool_call
    ///   that has not yet been stamped with a `shellPid`.
    /// - For "background"/"exited"/"killed" status: match by PID (the event may already
    ///   carry `shellPid` from an earlier `running` event, and may be Processed for exits).
    pub fn update_last_shell_process(
        &mut self,
        pid: u32,
        status: &str,
        exit_code: Option<i32>,
        log_path: Option<&str>,
        shell_tools: &[&str],
    ) -> Option<String> {
        let match_by_pid = matches!(status, "background" | "exited" | "killed");

        for idx in (0..self.events.len()).rev() {
            if self.events[idx].action_type != "tool_call"
                || !shell_tools.contains(&self.events[idx].function_name.as_str())
            {
                continue;
            }

            // For PID-bound updates (background, exit), match by PID — the event
            // already carries `shellPid` from the prior `running` update and may
            // already be Processed for exits.
            // For "running" updates, find the first unprocessed shell tool_call.
            if match_by_pid {
                let event_pid = self.events[idx]
                    .args
                    .get("shellPid")
                    .and_then(|v| v.as_u64())
                    .map(|p| p as u32);
                if event_pid != Some(pid) {
                    continue;
                }
            } else if self.events[idx].activity_status == ActivityStatus::Processed {
                break;
            }

            if let serde_json::Value::Object(ref mut args_map) = self.events[idx].args {
                args_map.insert(
                    "shellPid".to_string(),
                    serde_json::Value::Number(pid.into()),
                );
                args_map.insert(
                    "shellProcessStatus".to_string(),
                    serde_json::Value::String(status.to_string()),
                );
                if let Some(code) = exit_code {
                    args_map.insert(
                        "shellExitCode".to_string(),
                        serde_json::Value::Number(code.into()),
                    );
                }
                if let Some(path) = log_path {
                    args_map.insert(
                        "shellLogPath".to_string(),
                        serde_json::Value::String(path.to_string()),
                    );
                }
            }
            let event_id = self.events[idx].id.clone();
            self.mark_changed(event_id.clone());
            self.version += 1;
            return Some(event_id);
        }
        None
    }

    /// Update args on the last event matching a predicate (scanning from end).
    /// `merge_args` are shallow-merged into the event's existing `args` object.
    /// Returns the ID of the updated event, if found.
    pub fn update_last_matching_args<F>(
        &mut self,
        predicate: F,
        merge_args: serde_json::Value,
    ) -> Option<String>
    where
        F: Fn(&SessionEvent) -> bool,
    {
        for idx in (0..self.events.len()).rev() {
            if predicate(&self.events[idx]) {
                if let (
                    serde_json::Value::Object(ref mut existing),
                    serde_json::Value::Object(new),
                ) = (&mut self.events[idx].args, merge_args)
                {
                    for (key, value) in new {
                        existing.insert(key, value);
                    }
                }
                let event_id = self.events[idx].id.clone();
                self.mark_changed(event_id.clone());
                self.version += 1;
                return Some(event_id);
            }
        }
        None
    }

    /// Clear all events (e.g., session switch to empty).
    pub fn clear(&mut self) {
        let removed_ids: Vec<String> = self.events.iter().map(|event| event.id.clone()).collect();
        self.events.clear();
        self.id_index.clear();
        self.call_id_index.clear();
        for event_id in removed_ids {
            self.mark_removed(event_id);
        }
        self.version += 1;
    }

    // -------------------------------------------------------------------------
    // Private helpers used by multiple public ops
    // -------------------------------------------------------------------------

    /// Remove frontend-injected transcript placeholders after authoritative
    /// backend transcript events arrive.
    ///
    /// IDs and function names are not stable across providers. The stable
    /// distinction is provenance: synthetic placeholders carry a frontend-only
    /// marker, while backend parser/runtime events do not. Matching is scoped to
    /// transcript source and normalized message text so legitimate repeated
    /// authoritative messages are preserved.
    pub(super) fn remove_matching_synthetic_transcript_placeholders(
        &mut self,
        authoritative: &SessionEvent,
    ) -> usize {
        let Some(authoritative_key) = transcript_message_key(authoritative) else {
            return 0;
        };

        let removed_ids = self.matching_synthetic_transcript_placeholder_ids(&authoritative_key);
        self.remove_events_by_ids(removed_ids)
    }

    fn matching_synthetic_transcript_placeholder_ids(
        &self,
        authoritative_key: &(EventSource, String),
    ) -> Vec<String> {
        self.events
            .iter()
            .filter(|event| {
                is_synthetic_transcript_placeholder(event)
                    && transcript_message_key(event).as_ref() == Some(authoritative_key)
            })
            .map(|event| event.id.clone())
            .collect()
    }

    pub(super) fn remove_events_by_ids(&mut self, removed_ids: Vec<String>) -> usize {
        let removed = removed_ids.len();
        if removed == 0 {
            return 0;
        }

        let removed_id_set: HashSet<String> = removed_ids.iter().cloned().collect();
        self.events
            .retain(|event| !removed_id_set.contains(&event.id));
        for event_id in removed_ids {
            self.mark_removed(event_id);
        }
        self.rebuild_indexes();
        self.version += 1;
        removed
    }

    pub(super) fn replace_duplicate_stream_transcript_in_current_turn(
        &mut self,
        new_event: &mut SessionEvent,
    ) -> bool {
        if !is_completed_authoritative_stream_transcript(new_event) {
            return false;
        }
        let new_text = normalized_event_text(new_event);
        let current_turn_start = self
            .events
            .iter()
            .rposition(|event| event.source == EventSource::User)
            .map(|index| index + 1)
            .unwrap_or(0);
        let Some(existing_idx) = self.events[current_turn_start..]
            .iter()
            .position(|event| {
                is_completed_authoritative_stream_transcript(event)
                    && event.display_variant == new_event.display_variant
                    && normalized_event_text(event) == new_text
            })
            .map(|offset| current_turn_start + offset)
        else {
            return false;
        };

        let existing_created_at = self.events[existing_idx].created_at.clone();
        new_event.created_at = existing_created_at;
        if let Some(ref old_cid) = self.events[existing_idx].call_id {
            self.call_id_index.remove(old_cid);
        }
        if let Some(ref new_cid) = new_event.call_id {
            self.call_id_index.insert(new_cid.clone(), existing_idx);
        }
        let old_id = self.events[existing_idx].id.clone();
        let new_id = new_event.id.clone();
        self.events[existing_idx] = new_event.clone();
        if old_id != new_id {
            self.mark_removed(old_id);
        }
        self.mark_changed(new_id);
        self.rebuild_indexes();
        true
    }

    pub(super) fn replace_matching_stream_placeholder(
        &mut self,
        new_event: &mut SessionEvent,
    ) -> bool {
        let placeholder_prefix = match stream_placeholder_prefix_for_authoritative(&new_event.id) {
            Some(prefix) => prefix,
            None => return false,
        };
        let display_text = new_event.display_text.trim();
        if display_text.is_empty() {
            return false;
        }

        let placeholder_idx = self.events.iter().position(|event| {
            event.id.starts_with(placeholder_prefix)
                && event.display_text.trim() == display_text
                && event.action_type == new_event.action_type
        });
        let Some(idx) = placeholder_idx else {
            return false;
        };

        let placeholder_created_at = self.events[idx].created_at.clone();
        new_event.created_at = placeholder_created_at;

        if let Some(existing_new_idx) = self.id_index.get(&new_event.id).copied() {
            if existing_new_idx != idx {
                let removed_id = self.events[idx].id.clone();
                self.events.remove(idx);
                let target_idx = if existing_new_idx > idx {
                    existing_new_idx - 1
                } else {
                    existing_new_idx
                };
                let new_id = new_event.id.clone();
                self.events[target_idx] = new_event.clone();
                self.mark_removed(removed_id);
                self.mark_changed(new_id);
                self.rebuild_indexes();
                return true;
            }
        }

        if let Some(ref old_cid) = self.events[idx].call_id {
            self.call_id_index.remove(old_cid);
        }
        let new_id = new_event.id.clone();
        let old_id = self.events[idx].id.clone();
        self.events[idx] = new_event.clone();
        if old_id != new_id {
            self.mark_removed(old_id);
        }
        self.mark_changed(new_id);
        self.rebuild_indexes();
        true
    }

    pub(super) fn would_downgrade_terminal_tool_call(
        existing: &SessionEvent,
        incoming: &SessionEvent,
    ) -> bool {
        existing.action_type == "tool_call"
            && incoming.action_type == "tool_call"
            && matches!(
                existing.display_status,
                EventDisplayStatus::Completed | EventDisplayStatus::Failed
            )
            && matches!(
                incoming.display_status,
                EventDisplayStatus::Running
                    | EventDisplayStatus::Pending
                    | EventDisplayStatus::AwaitingUser
            )
    }
}
