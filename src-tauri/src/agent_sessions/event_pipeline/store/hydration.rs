//! Hydration and merge operations for `EventStore`.
//!
//! Covers bulk event loading (`set`, `set_round_window`), incremental appends,
//! and the two-phase merge path used during round-window pagination.

use std::collections::HashSet;

use super::helpers::{
    is_authoritative_transcript_message, is_turn_placeholder, loaded_turn_ids_from_events,
    placeholder_turn_id, reconcile_loaded_synthetic_transcript_placeholders, timeline_source_order,
};
use super::{
    active_shell_replays_for_session, capture_shell_replay_bookmarks, hydrate_shell_event_bounded,
    monotonic_shell_replay_state, preserve_first_insert_replay, EventStore,
};
use crate::agent_sessions::event_pipeline::store::HydrationMode;
use crate::agent_sessions::event_pipeline::types::{ActivityStatus, EventDisplayStatus};

impl EventStore {
    /// Replace all events (session load / clear).
    pub fn set(&mut self, events: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>) {
        self.set_with_hydration(events, HydrationMode::Full);
    }

    pub fn set_round_window(
        &mut self,
        events: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
    ) {
        // Never let an empty round window clobber a store that already holds
        // events. The window can resolve to zero events when the turn index is
        // mid-rebuild (e.g. switching into a session right after a long run);
        // overwriting here would publish an empty snapshot and render the chat
        // as "loaded + 0 events" until the user hits Reload.
        if events.is_empty() && !self.events.is_empty() {
            return;
        }
        self.set_with_hydration(events, HydrationMode::RoundWindow);
    }

    /// Replace an external replay window authoritatively, including with an
    /// empty window. Imported/managed CLI history has already committed its
    /// compact generation before delivery, so an empty canonical window means
    /// that the source is empty and must clear any prior external snapshot.
    ///
    /// Native SDE turn-index hydration keeps using `set_round_window`, whose
    /// empty-window guard protects an index that may still be rebuilding.
    pub fn set_external_replay_window(
        &mut self,
        events: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
    ) {
        self.set_with_hydration(events, HydrationMode::RoundWindow);
    }

    pub(super) fn set_with_hydration(
        &mut self,
        mut events: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
        hydration_mode: HydrationMode,
    ) {
        reconcile_loaded_synthetic_transcript_placeholders(&mut events);
        for event in &mut events {
            hydrate_shell_event_bounded(event);
        }
        self.events = events;
        self.hydration_mode = hydration_mode;
        self.cap_events();
        self.rebuild_indexes();
        self.version += 1;
        self.last_full_snapshot_version = 0;
        self.changed_ids.clear();
        self.removed_ids.clear();
    }

    /// Append events, deduplicating by ID.
    /// Auto-stamps repo context on events that don't already carry one.
    pub fn append(
        &mut self,
        new_events: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
    ) {
        if new_events.is_empty() {
            return;
        }
        self.mark_live_partial_if_windowed();
        let active = active_shell_replays_for_session(&new_events[0].session_id);
        let mut changed = false;
        for mut event in new_events {
            capture_shell_replay_bookmarks(&mut event, &active);
            if self.id_index.contains_key(&event.id) {
                continue;
            }
            self.stamp_repo(&mut event);
            if is_authoritative_transcript_message(&event) {
                self.remove_matching_synthetic_transcript_placeholders(&event);
            }
            let event_id = event.id.clone();
            let idx = self.events.len();
            self.insert_index_entries(&event, idx);
            self.events.push(event);
            self.mark_changed(event_id);
            changed = true;
        }
        if !changed {
            return;
        }
        self.cap_events();
        self.version += 1;
    }

    /// Merge incoming events into the store:
    /// - tool_result events are merged into their matching tool_call via call_id (O(1))
    /// - Existing IDs are updated in place
    /// - New IDs are appended
    ///
    /// When merging tool_result into tool_call:
    /// - Result is taken from tool_result
    /// - Args are preserved from original tool_call (start event has args, end has result)
    /// - Display status updated to Completed
    pub fn merge_events(
        &mut self,
        incoming: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
    ) {
        self.merge_events_with_hydration(incoming, true);
    }

    pub fn merge_round_window_events(
        &mut self,
        incoming: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
    ) {
        let loaded_turn_ids = loaded_turn_ids_from_events(&incoming);
        self.remove_turn_placeholders_for_turns(&loaded_turn_ids);
        self.merge_events_with_hydration(incoming, false);
        self.sort_round_window_events_by_timeline();
    }

    pub(super) fn merge_events_with_hydration(
        &mut self,
        incoming: Vec<crate::agent_sessions::event_pipeline::types::SessionEvent>,
        mark_live: bool,
    ) {
        if incoming.is_empty() {
            return;
        }
        if mark_live {
            self.mark_live_partial_if_windowed();
        }
        let active = mark_live.then(|| active_shell_replays_for_session(&incoming[0].session_id));
        let mut changed = false;
        for mut event in incoming {
            self.stamp_repo(&mut event);
            if let Some(active) = active.as_ref() {
                capture_shell_replay_bookmarks(&mut event, active);
            } else {
                hydrate_shell_event_bounded(&mut event);
            }
            if event.action_type == "tool_result" {
                if let Some(ref call_id) = event.call_id {
                    if let Some(&call_idx) = self.call_id_index.get(call_id) {
                        let target = &mut self.events[call_idx];
                        if target.action_type == "tool_call" {
                            // Merge result from tool_result event.
                            //
                            // Interactive tools (`ask_user_questions`, etc.)
                            // emit an early structured result (e.g.
                            // `{status, answers, content}`) via
                            // `agent:interaction_finalized`. A later generic
                            // `agent:tool_result` from `on_tool_result` only
                            // carries `{content, observation}`. A full replace
                            // would wipe the structured fields and leave the
                            // UI stuck on "waiting for your answer", so we
                            // merge keys when both sides are objects.
                            target.result =
                                match (std::mem::take(&mut target.result), event.result.clone()) {
                                    (
                                        serde_json::Value::Object(mut existing),
                                        serde_json::Value::Object(incoming),
                                    ) => {
                                        for (k, v) in incoming {
                                            existing.insert(k, v);
                                        }
                                        serde_json::Value::Object(existing)
                                    }
                                    (_, incoming) => incoming,
                                };
                            target.activity_status = ActivityStatus::Processed;
                            target.display_status = EventDisplayStatus::Completed;
                            if let Some(next) = event.shell_replay.take() {
                                target.shell_replay = Some(monotonic_shell_replay_state(
                                    target.shell_replay.as_ref(),
                                    next,
                                ));
                            }

                            // Preserve args from tool_call, but merge in any additional
                            // fields from tool_result's args (rare, but may contain metadata).
                            // Also remove streamOutput which is only for running state.
                            if let (
                                serde_json::Value::Object(ref mut target_args),
                                serde_json::Value::Object(ref result_args),
                            ) = (&mut target.args, &event.args)
                            {
                                // Add any new keys from result args (but target's existing keys win)
                                for (key, value) in result_args {
                                    if !target_args.contains_key(key) {
                                        target_args.insert(key.clone(), value.clone());
                                    }
                                }
                                target_args.remove("streamOutput");

                                // A blocking tool result means a foreground
                                // `running` status can no longer be active.
                                // A background shell is different: the tool
                                // deliberately returns before the process and
                                // its exact call-id lifecycle callback will
                                // later write `exited`/`killed`. Preserve that
                                // state instead of briefly lying that the
                                // process already ended.
                                if let Some(sps) = target_args.get("shellProcessStatus") {
                                    if sps.as_str() == Some("running") {
                                        target_args.insert(
                                            "shellProcessStatus".to_string(),
                                            serde_json::Value::String("exited".to_string()),
                                        );
                                    }
                                }
                            }

                            // Propagate file_path and command from tool_result if missing on target
                            if target.file_path.is_none() && event.file_path.is_some() {
                                target.file_path = event.file_path;
                            }
                            if target.command.is_none() && event.command.is_some() {
                                target.command = event.command;
                            }

                            // Refresh extracted so derived fields (resultContent,
                            // success, subagentSessionId, etc.) reflect the merged
                            // result immediately in the next snapshot.
                            target.recompute_extracted();
                            let target_id = target.id.clone();
                            self.mark_changed(target_id);

                            changed = true;
                            continue;
                        }
                    }
                }
            }

            if let Some(&idx) = self.id_index.get(&event.id) {
                if Self::would_downgrade_terminal_tool_call(&self.events[idx], &event) {
                    continue;
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
                changed = true;
            } else {
                if is_authoritative_transcript_message(&event) {
                    self.remove_matching_synthetic_transcript_placeholders(&event);
                }
                let event_id = event.id.clone();
                let idx = self.events.len();
                self.insert_index_entries(&event, idx);
                self.events.push(event);
                self.mark_changed(event_id);
                changed = true;
            }
        }
        if changed {
            self.cap_events();
            self.version += 1;
        }
    }

    pub(super) fn remove_turn_placeholders_for_turns(
        &mut self,
        turn_ids: &HashSet<String>,
    ) -> usize {
        if turn_ids.is_empty() {
            return 0;
        }
        let removed_ids: Vec<String> = self
            .events
            .iter()
            .filter(|event| {
                is_turn_placeholder(event)
                    && placeholder_turn_id(event).is_some_and(|turn_id| turn_ids.contains(turn_id))
            })
            .map(|event| event.id.clone())
            .collect();
        let removed = removed_ids.len();
        if removed > 0 {
            self.events.retain(|event| !removed_ids.contains(&event.id));
            for event_id in removed_ids {
                self.mark_removed(event_id);
            }
            self.rebuild_indexes();
            self.version += 1;
        }
        removed
    }

    pub(super) fn sort_round_window_events_by_timeline(&mut self) {
        self.events.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| {
                    timeline_source_order(&left.source).cmp(&timeline_source_order(&right.source))
                })
                .then_with(|| left.id.cmp(&right.id))
        });
        self.rebuild_indexes();
        // Incremental streaming order patches describe only changed ids.
        // A round-window merge may move untouched historical ids as well, so
        // the next notification must replace the normalized baseline once.
        self.last_full_snapshot_version = 0;
    }
}
