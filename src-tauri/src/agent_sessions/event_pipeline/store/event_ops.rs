//! Single-event and batch event operations for `EventStore`.
//!
//! Covers get/update/upsert, streaming finalization, transcript dedup,
//! stream placeholder replacement, shell output stamping, and clear.

use std::collections::HashSet;

use super::helpers::{
    is_authoritative_transcript_message, is_completed_authoritative_stream_transcript,
    is_synthetic_transcript_placeholder, normalize_user_text, normalized_event_text,
    stream_placeholder_prefix_for_authoritative, transcript_message_key, transcript_text,
};
use super::{
    active_shell_replays_for_session, bound_shell_replay_state, capture_shell_replay_bookmarks,
    monotonic_shell_replay_state, preserve_first_insert_replay, sanitize_live_shell_event,
    EventStore,
};
use crate::agent_sessions::event_pipeline::types::{
    EventDisplayStatus, EventSource, SessionEvent, SessionEventPatch, ShellReplayState,
};

impl EventStore {
    pub fn get_by_id(&self, id: &str) -> Option<&SessionEvent> {
        self.id_index.get(id).map(|&idx| &self.events[idx])
    }

    /// Current insertion-order position for incremental snapshot ordering.
    pub fn event_position(&self, id: &str) -> Option<usize> {
        self.id_index.get(id).copied()
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
        let active = active_shell_replays_for_session(&event.session_id);
        capture_shell_replay_bookmarks(&mut event, &active);
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
            preserve_first_insert_replay(&self.events[idx], &mut event);
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

    /// With no scope, removes every synthetic placeholder (legacy behavior).
    /// A scope removes only placeholders that are echoed by one of the given
    /// user-message contents, or that predate `older_than` (a placeholder
    /// older than the newest real user turn can no longer receive an echo,
    /// e.g. skill-pill messages whose wire content differs from the pill) —
    /// a NEWER unmatched placeholder is a message whose echo has not arrived
    /// yet and must survive history merges carrying older real user turns.
    pub fn remove_synthetic_user_inputs(
        &mut self,
        scope: Option<(&[String], Option<&str>)>,
    ) -> usize {
        let scope = scope.map(|(contents, older_than)| {
            let targets: std::collections::HashSet<String> = contents
                .iter()
                .map(|content| normalize_user_text(content))
                .collect();
            (targets, older_than.map(str::to_string))
        });
        let should_remove = |event: &SessionEvent| -> bool {
            if event.source != EventSource::User || !is_synthetic_transcript_placeholder(event) {
                return false;
            }
            let Some((targets, older_than)) = &scope else {
                return true;
            };
            let content_matched = transcript_text(event)
                .map(|text| targets.contains(&normalize_user_text(&text)))
                .unwrap_or(false);
            let predates_newest_real = older_than.as_deref().is_some_and(|bound| {
                !event.created_at.is_empty() && event.created_at.as_str() < bound
            });
            content_matched || predates_newest_real
        };
        let removed_ids: Vec<String> = self
            .events
            .iter()
            .filter(|event| should_remove(event))
            .map(|event| event.id.clone())
            .collect();
        let removed = removed_ids.len();
        if removed > 0 {
            self.events.retain(|event| !should_remove(event));
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
        let active = active_shell_replays_for_session(&new_event.session_id);
        capture_shell_replay_bookmarks(&mut new_event, &active);
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
                        preserve_first_insert_replay(&self.events[target_idx], &mut new_event);
                        let new_id = new_event.id.clone();
                        self.events[target_idx] = new_event;
                        self.mark_removed(removed_id);
                        self.mark_changed(new_id);
                        self.rebuild_indexes();
                        self.version += 1;
                        return true;
                    }
                }

                preserve_first_insert_replay(&self.events[remove_idx], &mut new_event);
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

    /// Update the bounded mutable replay state by exact LLM call identity.
    ///
    /// The initial preflight callback may seed this call's immutable bookmark
    /// if it was not present when the shell row first entered the timeline.
    /// Later callbacks never overwrite any timeline bookmark. Duplicate
    /// tool-call siblings receive the same monotonic live state so hydration
    /// artifacts cannot show different terminal tails for one call.
    pub fn update_shell_replay_by_call_id(
        &mut self,
        call_id: &str,
        state: ShellReplayState,
        seed_bookmark: bool,
    ) -> Option<String> {
        if state.replay_ref.call_id != call_id {
            return None;
        }

        let seed_state = bound_shell_replay_state(state.clone());
        let preferred_id = self
            .call_id_index
            .get(call_id)
            .and_then(|idx| self.events.get(*idx))
            .filter(|event| event.session_id == state.replay_ref.session_id)
            .map(|event| event.id.clone());
        let mut found_id = None;
        let mut changed_ids = Vec::new();

        for event in &mut self.events {
            if event.action_type != "tool_call"
                || event.call_id.as_deref() != Some(call_id)
                || event.session_id != state.replay_ref.session_id
            {
                continue;
            }
            if found_id.is_none() {
                found_id = Some(event.id.clone());
            }

            let next = monotonic_shell_replay_state(event.shell_replay.as_ref(), state.clone());
            let mut changed = event.shell_replay.as_ref() != Some(&next);
            event.shell_replay = Some(next);

            if seed_bookmark {
                let bookmarks = event
                    .shell_replay_bookmarks
                    .get_or_insert_with(Default::default);
                if !bookmarks.contains_key(call_id) {
                    bookmarks.insert(call_id.to_string(), seed_state.clone());
                    changed = true;
                }
            }

            sanitize_live_shell_event(event);
            if changed {
                changed_ids.push(event.id.clone());
            }
        }

        if !changed_ids.is_empty() {
            for id in changed_ids {
                self.mark_changed(id);
            }
            self.version += 1;
        }

        preferred_id.or(found_id)
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
        preserve_first_insert_replay(&self.events[existing_idx], new_event);
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
                preserve_first_insert_replay(&self.events[target_idx], new_event);
                let new_id = new_event.id.clone();
                self.events[target_idx] = new_event.clone();
                self.mark_removed(removed_id);
                self.mark_changed(new_id);
                self.rebuild_indexes();
                return true;
            }
        }

        preserve_first_insert_replay(&self.events[idx], new_event);
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
