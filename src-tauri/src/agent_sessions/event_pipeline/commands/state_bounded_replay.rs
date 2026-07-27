//! Memory policy for external and managed CLI replay stores.
//!
//! Native SDE sessions never call these helpers. Keeping the policy beside,
//! rather than inside, the generic state registry makes that boundary visible.

use std::collections::HashSet;
#[cfg(test)]
use std::sync::atomic::Ordering;

use crate::agent_sessions::event_pipeline::session_providers;
use crate::agent_sessions::event_pipeline::types::{SessionEvent, SessionEventPatch};

use super::{external_replay, EventStoreState};

/// Generic writes used by managed/imported CLI sessions must obey the same
/// resident-memory budget as explicit external replay windows.
pub(super) const BOUNDED_REPLAY_STORE_MAX_BYTES: usize = 16 * 1024 * 1024;
/// A renderer-originated write must stay small. Larger bodies belong behind
/// replay/payload locators, not in the resident EventStore.
pub(super) const BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Exact compaction leaves headroom so same-ID streaming updates can be
/// accounted conservatively without rescanning the store for every token.
const BOUNDED_REPLAY_GENERIC_COMPACT_BYTES: usize = 14 * 1024 * 1024;

impl EventStoreState {
    /// Apply the external-replay-only per-store byte cap, publish its actual
    /// serialized footprint to the aggregate byte LRU, and remove idle stores
    /// evicted by that policy.
    pub fn cap_external_replay_store(
        &self,
        session_id: &str,
        max_bytes: usize,
    ) -> Result<usize, String> {
        self.cap_external_replay_store_inner(session_id, max_bytes, None)
    }

    /// Apply the external replay byte cap while pinning one foreground window.
    /// This is used only after an older-page merge so the returned page remains
    /// visible long enough for the renderer snapshot barrier to observe it.
    pub fn cap_external_replay_store_preserving_window(
        &self,
        session_id: &str,
        max_bytes: usize,
        window: &[SessionEvent],
    ) -> Result<usize, String> {
        let preserved_event_ids = window
            .iter()
            .map(|event| event.id.clone())
            .collect::<HashSet<_>>();
        self.cap_external_replay_store_inner(session_id, max_bytes, Some(&preserved_event_ids))
    }

    fn cap_external_replay_store_inner(
        &self,
        session_id: &str,
        max_bytes: usize,
        preserved_event_ids: Option<&HashSet<String>>,
    ) -> Result<usize, String> {
        // Match the EventStore write/switch lock order: manager -> stores.
        let (bytes, evicted) = {
            let mut manager = self
                .session_manager
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut stores = self
                .stores
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(store) = stores.get_mut(session_id) else {
                return Ok(0);
            };
            #[cfg(test)]
            self.bounded_replay_exact_cap_count
                .fetch_add(1, Ordering::Relaxed);
            let bytes = match preserved_event_ids {
                Some(preserved_event_ids) => {
                    store.cap_external_replay_bytes_preserving(max_bytes, preserved_event_ids)?
                }
                None => store.cap_external_replay_bytes(max_bytes)?,
            };
            let evicted = manager.update_estimated_bytes(session_id, bytes);
            (bytes, evicted)
        };
        self.remove_evicted_replay_stores(evicted);
        Ok(bytes)
    }

    fn remove_evicted_replay_stores(&self, evicted: Vec<String>) {
        if evicted.is_empty() {
            return;
        }
        let mut stores = self
            .stores
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for evicted_session_id in evicted {
            external_replay::release_session_runtime(&evicted_session_id);
            stores.remove(&evicted_session_id);
        }
    }

    /// Reject an input that cannot fit in an otherwise empty bounded store.
    pub(crate) fn validate_bounded_replay_input(
        &self,
        session_id: &str,
        events: &[SessionEvent],
    ) -> Result<usize, String> {
        if !session_providers::uses_bounded_replay(session_id) || events.is_empty() {
            return Ok(0);
        }
        let incoming_bytes = serde_json::to_vec(events)
            .map_err(|error| format!("serialize bounded replay write: {error}"))?
            .len();
        if incoming_bytes > BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES {
            return Err(format!(
                "bounded replay write for {session_id} exceeds the {} byte generic input budget; store large bodies behind a payload locator",
                BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
            ));
        }
        Ok(incoming_bytes)
    }

    /// Preflight a partial update before it clones payload into target rows.
    pub(crate) fn validate_bounded_replay_patch(
        &self,
        session_id: &str,
        ids: &[String],
        patch: &SessionEventPatch,
    ) -> Result<(), String> {
        if !session_providers::uses_bounded_replay(session_id) || ids.is_empty() {
            return Ok(());
        }

        let patch_bytes = serde_json::to_vec(patch)
            .map_err(|error| format!("serialize bounded replay patch: {error}"))?
            .len();
        if patch_bytes > BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES {
            return Err(format!(
                "bounded replay patch for {session_id} exceeds the {} byte generic input budget",
                BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
            ));
        }
        let unique_ids = ids.iter().map(String::as_str).collect::<HashSet<_>>();
        self.with_store_opt(session_id, |store| {
            let target_count = unique_ids
                .iter()
                .filter(|id| store.get_by_id(id).is_some())
                .count();
            if patch_bytes.saturating_mul(target_count)
                > BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
            {
                return Err(format!(
                    "bounded replay patch for {session_id} exceeds the {} byte amplification budget across {target_count} events",
                    BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
                ));
            }

            for id in &unique_ids {
                let Some(existing) = store.get_by_id(id) else {
                    continue;
                };
                let mut projected = existing.clone();
                patch.apply_to(&mut projected);
                let projected_bytes = serde_json::to_vec(std::slice::from_ref(&projected))
                    .map_err(|error| format!("serialize projected bounded replay event: {error}"))?
                    .len();
                if projected_bytes > BOUNDED_REPLAY_GENERIC_COMPACT_BYTES {
                    return Err(format!(
                        "bounded replay patch would make event {id} exceed the {} byte compacted store budget",
                        BOUNDED_REPLAY_GENERIC_COMPACT_BYTES
                    ));
                }
            }
            Ok(())
        })
        .unwrap_or(Ok(()))
    }

    /// Bound the command that copies one JSON object into sibling tool rows.
    pub(crate) fn validate_bounded_replay_args_merge(
        &self,
        session_id: &str,
        function_names: &[&str],
        merge_args: &serde_json::Value,
    ) -> Result<(), String> {
        if !session_providers::uses_bounded_replay(session_id) {
            return Ok(());
        }
        let merge_bytes = serde_json::to_vec(merge_args)
            .map_err(|error| format!("serialize bounded replay args merge: {error}"))?
            .len();
        if merge_bytes > BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES {
            return Err(format!(
                "bounded replay args merge for {session_id} exceeds the {} byte generic input budget",
                BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
            ));
        }

        self.with_store_opt(session_id, |store| {
            let Some(primary_index) = store.find_last_spawning_tool(function_names) else {
                return Ok(());
            };
            let primary = &store.events()[primary_index];
            let target_count = primary.call_id.as_deref().map_or(1, |call_id| {
                store
                    .events()
                    .iter()
                    .filter(|event| {
                        event.action_type == "tool_call"
                            && event.call_id.as_deref() == Some(call_id)
                    })
                    .count()
            });
            if merge_bytes.saturating_mul(target_count)
                > BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
            {
                return Err(format!(
                    "bounded replay args merge for {session_id} exceeds the {} byte amplification budget across {target_count} events",
                    BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES
                ));
            }
            for event in store.events().iter().filter(|event| {
                event.id == primary.id
                    || primary.call_id.as_deref().is_some_and(|call_id| {
                        event.action_type == "tool_call"
                            && event.call_id.as_deref() == Some(call_id)
                    })
            }) {
                let existing_bytes = serde_json::to_vec(event)
                    .map_err(|error| format!("serialize bounded replay merge target: {error}"))?
                    .len();
                if existing_bytes.saturating_add(merge_bytes)
                    > BOUNDED_REPLAY_GENERIC_COMPACT_BYTES
                {
                    return Err(format!(
                        "bounded replay args merge would make event {} exceed the {} byte compacted store budget",
                        event.id, BOUNDED_REPLAY_GENERIC_COMPACT_BYTES
                    ));
                }
            }
            Ok(())
        })
        .unwrap_or(Ok(()))
    }

    /// Apply the byte cap and refresh accounting after a generic mutation.
    pub(crate) fn enforce_bounded_replay_store_policy(
        &self,
        session_id: &str,
    ) -> Result<(), String> {
        if !session_providers::uses_bounded_replay(session_id) {
            return Ok(());
        }
        self.cap_external_replay_store(session_id, BOUNDED_REPLAY_GENERIC_COMPACT_BYTES)?;
        Ok(())
    }

    /// Account a generic append/upsert/merge using a conservative upper bound.
    pub(crate) fn account_bounded_replay_write(
        &self,
        session_id: &str,
        incoming_upper_bound: usize,
    ) -> Result<(), String> {
        if !session_providers::uses_bounded_replay(session_id) {
            return Ok(());
        }
        let (estimated_bytes, evicted) = {
            let mut manager = self
                .session_manager
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            manager.add_estimated_bytes(session_id, incoming_upper_bound)
        };
        let current_was_evicted = evicted.iter().any(|evicted_id| evicted_id == session_id);
        self.remove_evicted_replay_stores(evicted);
        if !current_was_evicted && estimated_bytes > BOUNDED_REPLAY_STORE_MAX_BYTES {
            self.cap_external_replay_store(session_id, BOUNDED_REPLAY_GENERIC_COMPACT_BYTES)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn bounded_replay_exact_cap_count(&self) -> usize {
        self.bounded_replay_exact_cap_count.load(Ordering::Relaxed)
    }
}
