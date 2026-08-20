//! Wire-side adapter for the `agent_core::bus::event_pipeline_bridge` IoC
//! slots.
//!
//! This module registers a function pointer for every operation
//! `agent_core` needs on the live `EventStore` pipeline. Each adapter
//! resolves the Tauri-managed [`EventStoreState`] internally — that state is
//! a non-unregistrable `State<'_, ...>` so we can't pass it through the IoC
//! boundary; instead we pull it from the `AppHandle` inside each closure.
//!
//! Called once at startup via [`register`].

use chrono::Utc;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::commands::{
    cached_event_to_session_event, push_events_to_session, save_events_retry, schedule_notify,
    session_event_to_cached_event, update_spawning_tool_args_with_persist,
    update_tool_args_by_call_id_with_persist, EventStoreState, BULK_WRITE_MAX_RETRIES,
};
use super::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

use agent_core::bus::event_pipeline_bridge as bridge;
use core_types::session_event::ShellReplayState;
use core_types::tool_names::tool_call_event_id;

fn push_events_adapter(handle: &AppHandle, session_id: &str, events: Vec<SessionEvent>) {
    let state = handle.state::<EventStoreState>();
    push_events_to_session(handle, &state, session_id, events);
}

/// Build the canonical `tool-call-<call_id>` event for a shell whose session
/// has no frontend ingestion, from the Rust-authoritative replay manifest.
/// Returns `Ok(None)` when the manifest row does not exist (the handle is
/// genuinely unknown — the barrier should keep failing in that case).
fn synthesize_shell_tool_call_event(
    session_id: &str,
    call_id: &str,
) -> Result<Option<SessionEvent>, String> {
    let Some(meta) = agent_core::tools::impls::coding::exec::shell_replay::replay_command_meta(
        session_id, call_id,
    )?
    else {
        return Ok(None);
    };
    let chunk = super::ingestion::types::RawActivityChunk {
        chunk_id: Some(format!("tool-call-{call_id}")),
        session_id: Some(session_id.to_string()),
        action_type: Some("tool_call".to_string()),
        function: Some("run_shell".to_string()),
        args: Some(serde_json::json!({
            "command": meta.command,
            "cwd": meta.cwd,
        })),
        result: None,
        created_at: Some(meta.created_at),
        thread_id: None,
        process_id: None,
        call_id: Some(call_id.to_string()),
    };
    Ok(Some(super::ingestion::normalize_single(&chunk, session_id)))
}

fn schedule_notify_adapter(handle: &AppHandle, session_id: &str) {
    let state = handle.state::<EventStoreState>();
    schedule_notify(handle, &state, session_id);
}

fn update_spawning_tool_args_adapter(
    handle: &AppHandle,
    session_id: &str,
    function_names: &[&str],
    merge_args: Value,
) -> Option<String> {
    let state = handle.state::<EventStoreState>();
    update_spawning_tool_args_with_persist(handle, &state, session_id, function_names, merge_args)
}

fn update_tool_args_by_call_id_adapter(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    merge_args: Value,
) -> Option<String> {
    let state = handle.state::<EventStoreState>();
    update_tool_args_by_call_id_with_persist(handle, &state, session_id, call_id, merge_args)
}

fn update_shell_replay_by_call_id_adapter(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    replay: ShellReplayState,
    seed_bookmark: bool,
) -> Result<Option<String>, String> {
    let state = handle.state::<EventStoreState>();
    let (found_id, patched): (Option<String>, Vec<SessionEvent>) =
        state.with_store_mut(session_id, |store| {
            let found_id =
                store.update_shell_replay_by_call_id(call_id, replay.clone(), seed_bookmark);
            let patched = if found_id.is_some() {
                store
                    .events()
                    .iter()
                    .filter(|event| {
                        event.action_type == "tool_call"
                            && event.call_id.as_deref() == Some(call_id)
                    })
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            (found_id, patched)
        });

    let (found_id, patched) = if found_id.is_none() {
        // LRU/cold-store fallback: resolve only the Rust-authoritative exact
        // tool-call id. Never guess "last shell". Hydrate a temporary store
        // so the same monotonic/bookmark rules apply, then repopulate the live
        // cache and synchronously write the row back.
        let event_id = tool_call_event_id(call_id);
        let cold =
            session_persistence::get_event(session_id, &event_id).map_err(|err| err.to_string())?;
        let cold = match cold {
            Some(cached) => Some(cached_event_to_session_event(&cached)),
            // Headless fallback: the tool_call event is normally materialized
            // by frontend ingestion, so a session no window ever attached to
            // (debug/e2e endpoints) has neither a live-store nor a cold-store
            // row and the exact-event barrier would exhaust its retries and
            // refuse to start the shell. The replay manifest row (command,
            // cwd, created_at) is written by the Rust side strictly before
            // this publish, so synthesize the canonical event from it through
            // the SAME normalizer frontend ingestion uses. Collision-safe:
            // the store appends dedupe by id, so if a frontend attaches later
            // its ingestion of `tool-call-<call_id>` is a no-op.
            None => synthesize_shell_tool_call_event(session_id, call_id)?,
        };
        if let Some(event) = cold {
            if event.session_id == session_id
                && event.call_id.as_deref() == Some(call_id)
                && event.action_type == "tool_call"
            {
                let mut temporary = super::store::EventStore::new();
                temporary.set(vec![event]);
                let cold_id =
                    temporary.update_shell_replay_by_call_id(call_id, replay, seed_bookmark);
                let cold_patched: Vec<_> = temporary.events().to_vec();
                state.with_store_mut(session_id, |store| {
                    if store.event_count() == 0 {
                        store.set(cold_patched.clone());
                    } else {
                        store.merge_round_window_events(cold_patched.clone());
                    }
                });
                (cold_id, cold_patched)
            } else {
                (None, Vec::new())
            }
        } else {
            (None, Vec::new())
        }
    } else {
        (found_id, patched)
    };

    if !patched.is_empty() {
        schedule_notify(handle, &state, session_id);
        let cached: Vec<_> = patched.iter().map(session_event_to_cached_event).collect();
        // This bridge is part of the shell completion barrier: final replay
        // state must be durable before `agent:shell_process_exited` can fire.
        // Running-state calls use the same synchronous path for deterministic
        // ordering; they are already throttled by the writer (64 KiB/50 ms).
        save_events_retry(
            "update_shell_replay_by_call_id",
            session_id,
            &cached,
            BULK_WRITE_MAX_RETRIES,
        )?;
    }

    Ok(found_id)
}

fn complete_tool_call_by_call_id_adapter(
    handle: &AppHandle,
    session_id: &str,
    call_id: &str,
    success: bool,
) {
    let state = handle.state::<EventStoreState>();

    // In-memory: flip the still-running parent tool_call and collect it for
    // the SQLite write-through.
    let patched: Vec<SessionEvent> = state.with_store_mut(session_id, |store| {
        let ids = store.complete_tool_call_by_call_id(call_id, success);
        if ids.is_empty() {
            return Vec::new();
        }
        store
            .events()
            .iter()
            .filter(|event| ids.contains(&event.id))
            .cloned()
            .collect()
    });

    if !patched.is_empty() {
        schedule_notify(handle, &state, session_id);
        let cached: Vec<_> = patched.iter().map(session_event_to_cached_event).collect();
        let sid = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            let _ = save_events_retry(
                "complete_parent_tool_call",
                &sid,
                &cached,
                BULK_WRITE_MAX_RETRIES,
            );
        });
        return;
    }

    // Store not loaded (restart / GC path): patch SQLite directly so the next
    // es_load_from_cache hydrates a terminal event instead of a stuck spinner.
    // The Rust-authoritative tool_call row id is `tool-call-{call_id}`.
    let sid = session_id.to_string();
    let event_id = tool_call_event_id(call_id);
    tokio::task::spawn_blocking(move || {
        if let Ok(Some(cached)) = session_persistence::get_event(&sid, &event_id) {
            let mut event = cached_event_to_session_event(&cached);
            if event.display_status != EventDisplayStatus::Running {
                return;
            }
            event.display_status = if success {
                EventDisplayStatus::Completed
            } else {
                EventDisplayStatus::Failed
            };
            event.activity_status = ActivityStatus::Processed;
            event.recompute_extracted();
            let updated = session_event_to_cached_event(&event);
            let _ = save_events_retry(
                "complete_parent_tool_call_cold",
                &sid,
                &[updated],
                BULK_WRITE_MAX_RETRIES,
            );
        }
    });
}

fn finalize_streaming_adapter(handle: &AppHandle, session_id: &str) {
    let state = handle.state::<EventStoreState>();
    let changed = state.with_store_mut(session_id, |store| store.finalize_streaming_events());
    if changed {
        schedule_notify(handle, &state, session_id);
    }
}

fn set_session_streaming_adapter(handle: &AppHandle, session_id: &str, streaming: bool) {
    let state = handle.state::<EventStoreState>();
    state.with_store_mut(session_id, |store| {
        store.set_streaming(streaming);
    });
    if !streaming {
        schedule_notify(handle, &state, session_id);
    }
}

fn replace_streaming_event_adapter(
    handle: &AppHandle,
    session_id: &str,
    placeholder_id: &str,
    event: SessionEvent,
) {
    let state = handle.state::<EventStoreState>();
    let persistable =
        if super::commands::event_conversion::is_synthetic_persistence_artifact(&event) {
            None
        } else {
            Some(session_event_to_cached_event(&event))
        };
    state.with_store_mut(session_id, |store| {
        store.replace_and_remove(Some(placeholder_id), event);
    });
    schedule_notify(handle, &state, session_id);

    if let Some(cached) = persistable {
        let sid = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            let _ = save_events_retry(
                "replace_streaming_event",
                &sid,
                &[cached],
                BULK_WRITE_MAX_RETRIES,
            );
        });
    }
}

fn pin_session_adapter(handle: &AppHandle, session_id: &str) {
    let state = handle.state::<EventStoreState>();
    let mut mgr = state
        .session_manager
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    mgr.pin(session_id);
}

fn unpin_session_adapter(handle: &AppHandle, session_id: &str) {
    let state = handle.state::<EventStoreState>();
    let evicted = {
        let mut mgr = state
            .session_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        mgr.unpin(session_id)
    };
    if !evicted.is_empty() {
        let mut stores = state.stores.lock().unwrap_or_else(|e| e.into_inner());
        for sid in &evicted {
            stores.remove(sid);
        }
    }
}

fn evict_session_adapter(handle: &AppHandle, session_id: &str) {
    let state = handle.state::<EventStoreState>();
    {
        let mut manager = state
            .session_manager
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        manager.evict(session_id);
    }
    state
        .stores
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(session_id);
}

fn read_session_events_adapter(handle: &AppHandle, session_id: &str) -> Vec<SessionEvent> {
    let state = handle.state::<EventStoreState>();
    state
        .with_store_opt(session_id, |store| store.events().to_vec())
        .unwrap_or_default()
}

/// Backend-authoritative finalize for a plan revision's interactive events.
///
/// `resolve_pending` pushes a separate terminal `plan_approval` event, but
/// the ORIGINAL pending events — the `{revision}` pending card and the
/// `tool-call-{revision}` create_plan tool call — are persisted with
/// `displayStatus: awaiting_user` and were historically only patched by the
/// FE `handlePlanApprovalArchived` broadcast handler. A missed broadcast
/// (startup GC, app not focused) stranded them forever, permanently wedging
/// `usePlanningIndicator`. This adapter patches both the in-memory store and
/// SQLite so the backend no longer depends on the FE for convergence.
fn finalize_plan_revision_events_adapter(
    handle: &AppHandle,
    session_id: &str,
    plan_revision_id: &str,
) {
    let target_ids = [
        plan_revision_id.to_string(),
        tool_call_event_id(plan_revision_id),
    ];
    let state = handle.state::<EventStoreState>();

    // In-memory: flip any still-awaiting events and collect them for the
    // SQLite write-through.
    let patched: Vec<SessionEvent> = state.with_store_mut(session_id, |store| {
        let ids: Vec<String> = store
            .events()
            .iter()
            .filter(|event| {
                target_ids.contains(&event.id)
                    && event.display_status == EventDisplayStatus::AwaitingUser
            })
            .map(|event| event.id.clone())
            .collect();
        if ids.is_empty() {
            return Vec::new();
        }
        let patch = core_types::session_event::SessionEventPatch {
            display_status: Some(EventDisplayStatus::Completed),
            activity_status: Some(ActivityStatus::Processed),
            ..Default::default()
        };
        store.patch_by_ids(&ids, &patch);
        store
            .events()
            .iter()
            .filter(|event| ids.contains(&event.id))
            .cloned()
            .collect()
    });

    if !patched.is_empty() {
        schedule_notify(handle, &state, session_id);
        let cached: Vec<_> = patched.iter().map(session_event_to_cached_event).collect();
        let sid = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            let _ = save_events_retry(
                "finalize_plan_revision",
                &sid,
                &cached,
                BULK_WRITE_MAX_RETRIES,
            );
        });
        return;
    }

    // Store not loaded (restart / GC path): patch SQLite directly so the
    // next es_load_from_cache hydrates a completed event.
    let sid = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        for event_id in &target_ids {
            if let Ok(Some(cached)) = session_persistence::get_event(&sid, event_id) {
                let mut event = cached_event_to_session_event(&cached);
                if event.display_status != EventDisplayStatus::AwaitingUser {
                    continue;
                }
                event.display_status = EventDisplayStatus::Completed;
                event.activity_status = ActivityStatus::Processed;
                event.recompute_extracted();
                let updated = session_event_to_cached_event(&event);
                let _ = save_events_retry(
                    "finalize_plan_revision_cold",
                    &sid,
                    &[updated],
                    BULK_WRITE_MAX_RETRIES,
                );
            }
        }
    });
}

fn persist_events_adapter(
    label: &'static str,
    session_id: &str,
    events: &[SessionEvent],
    max_retries: u32,
) {
    let cached: Vec<_> = events.iter().map(session_event_to_cached_event).collect();
    let _ = save_events_retry(label, session_id, &cached, max_retries);
}

fn persist_events_async_adapter(
    label: &'static str,
    session_id: String,
    events: Vec<SessionEvent>,
    max_retries: u32,
) {
    tokio::task::spawn_blocking(move || {
        let cached: Vec<_> = events.iter().map(session_event_to_cached_event).collect();
        let _ = save_events_retry(label, &session_id, &cached, max_retries);
    });
}

#[allow(clippy::too_many_arguments)]
// This adapter implements the persistence callback signature consumed by
// agent-core, so its event fields must stay aligned with that boundary.
fn persist_user_message_event_adapter(
    handle: &AppHandle,
    session_id: &str,
    message_id: &str,
    content: &str,
    display_text: Option<&str>,
    images: Option<&[String]>,
    source: bridge::PersistedUserMessageSource,
    turn_intent_id: &str,
) -> Result<(), String> {
    let mut result = serde_json::json!({
        "type": "user",
        "message": { "content": content, "role": "user" },
        "backendPersisted": true,
        "messageId": message_id,
    });
    if let Some(images) = images.filter(|images| !images.is_empty()) {
        if let Some(obj) = result.as_object_mut() {
            obj.insert("images".to_string(), serde_json::json!(images));
        }
    }
    if !turn_intent_id.is_empty() {
        if let Some(obj) = result.as_object_mut() {
            obj.insert(
                "turnIntentId".to_string(),
                serde_json::json!(turn_intent_id),
            );
        }
    }
    if source.is_agent_org_inbox_transcript() {
        if let Some(obj) = result.as_object_mut() {
            obj.insert(
                "agentOrgInboxTranscript".to_string(),
                serde_json::json!(true),
            );
        }
    }

    let args = if source.is_agent_org_inbox_transcript() {
        serde_json::json!({ "agentOrgInboxTranscript": true })
    } else {
        serde_json::json!({})
    };

    // Use the pill-format display_text when provided so that editing a
    // historical message re-populates the pill rather than the expanded YAML.
    // Fall back to content when display_text is absent (backward compat).
    let effective_display_text = display_text
        .filter(|s| !s.is_empty())
        .unwrap_or(content)
        .to_string();

    let created_at = if source.is_agent_org_inbox_transcript() {
        agent_core::session::persistence::message_created_at(session_id, message_id)
            .map_err(|err| {
                format!(
                    "load durable Agent Org inbox transcript timestamp for {message_id} failed: {err}"
                )
            })?
            .ok_or_else(|| {
                format!(
                    "durable Agent Org inbox transcript {message_id} disappeared before event persistence"
                )
            })?
    } else {
        Utc::now().to_rfc3339()
    };

    let mut event = SessionEvent {
        id: format!("user-message-{message_id}"),
        chunk_id: Some(format!("user-message-{message_id}")),
        session_id: session_id.to_string(),
        created_at,
        function_name: "user_message".to_string(),
        ui_canonical: "user_message".to_string(),
        action_type: "raw".to_string(),
        args,
        result,
        source: EventSource::User,
        display_text: effective_display_text,
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
    };
    event.recompute_extracted();

    let cached = session_event_to_cached_event(&event);
    // Persist first. If SQLite fails, callers must not invoke the provider or
    // acknowledge source Inbox rows; the next retry can ensure this same
    // stable event without duplicating the transcript message.
    save_events_retry(
        "persist_user_message_event",
        session_id,
        &[cached],
        BULK_WRITE_MAX_RETRIES,
    )?;
    let state = handle.state::<EventStoreState>();
    state.with_store_mut(session_id, |store| store.merge_events(vec![event]));
    schedule_notify(handle, &state, session_id);
    Ok(())
}

/// One-shot startup repair: finalize historically stranded `awaiting_user`
/// `create_plan` events that no longer have a matching pending-plan row.
///
/// Before the backend-authoritative finalize existed, an archive whose FE
/// broadcast was missed left the plan's tool-call event stuck in
/// `awaiting_user` forever, wedging the session's planning indicator. This
/// scan converges all such historical strands once; new resolutions are
/// covered by `finalize_plan_revision_events_adapter`.
pub fn repair_stranded_plan_events() {
    let pending_revisions: std::collections::HashSet<String> =
        match agent_core::interaction::plan_approval::pending_revision_ids() {
            Ok(ids) => ids.into_iter().collect(),
            Err(err) => {
                tracing::warn!("[plan-repair] failed to list pending plan rows: {err}");
                return;
            }
        };

    let stranded = match session_persistence::find_awaiting_user_events_by_function("create_plan") {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("[plan-repair] scan failed: {err}");
            return;
        }
    };

    let mut repaired = 0usize;
    for cached in stranded {
        let mut event = cached_event_to_session_event(&cached);
        if event.display_status != EventDisplayStatus::AwaitingUser {
            continue;
        }
        // Events belonging to a live pending plan stay awaiting — only
        // strands without a backing row are repaired.
        let revision = event
            .id
            .strip_prefix("tool-call-")
            .unwrap_or(&event.id)
            .to_string();
        if pending_revisions.contains(&revision) {
            continue;
        }
        event.display_status = EventDisplayStatus::Completed;
        event.activity_status = ActivityStatus::Processed;
        event.recompute_extracted();
        let updated = session_event_to_cached_event(&event);
        let session_id = event.session_id.clone();
        if save_events_retry(
            "plan_repair",
            &session_id,
            &[updated],
            BULK_WRITE_MAX_RETRIES,
        )
        .is_ok()
        {
            repaired += 1;
        }
    }

    if repaired > 0 {
        tracing::info!("[plan-repair] finalized {repaired} stranded create_plan event(s)");
    }
}

fn remove_events_by_ids_adapter(handle: &AppHandle, session_id: &str, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    let state = handle.state::<EventStoreState>();
    let removed = state.with_store_mut(session_id, |store| store.remove_by_ids(&ids));
    if removed > 0 {
        schedule_notify(handle, &state, session_id);
    }

    // SQLite write-through: the segments were persisted by push_events, so
    // they must be retracted from disk too or a reload resurrects them.
    let sid = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        for event_id in &ids {
            if let Err(err) = session_persistence::delete_event(&sid, event_id) {
                tracing::warn!(
                    "[event-pipeline] remove_events_by_ids: failed to delete {} from SQLite: {}",
                    event_id,
                    err
                );
            }
        }
    });
}

/// Register every IoC slot exposed by `agent_core::bus::event_pipeline_bridge`.
/// Called once from `app::run` at startup.
pub fn register() {
    bridge::register(
        push_events_adapter,
        schedule_notify_adapter,
        update_spawning_tool_args_adapter,
        update_tool_args_by_call_id_adapter,
        update_shell_replay_by_call_id_adapter,
        complete_tool_call_by_call_id_adapter,
        finalize_streaming_adapter,
        set_session_streaming_adapter,
        replace_streaming_event_adapter,
        remove_events_by_ids_adapter,
        pin_session_adapter,
        unpin_session_adapter,
        evict_session_adapter,
        read_session_events_adapter,
        finalize_plan_revision_events_adapter,
        persist_events_adapter,
        persist_events_async_adapter,
        persist_user_message_event_adapter,
    );
}
