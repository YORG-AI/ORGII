use super::*;

#[tauri::command]
pub async fn external_replay_open_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    // Reject invalid source/session pairs before they can consume a slot in
    // the bounded foreground request registry.
    let request_token =
        begin_validated_foreground_request(&source_id, &session_id, episode_id, true)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let watcher_app = app.clone();
    let watcher_source_id = source_id.clone();
    let watcher_session_id = session_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        // Register before reading the initial snapshot so an append/rewrite in
        // the indexing window cannot fall into a watcher-registration gap.
        // Generation is filled in after the bounded open commits. Re-check
        // the request immediately around acquisition: release can race this
        // blocking task before it starts, and stale A1 work must not recreate
        // a watcher after A→B→A has moved to a newer episode.
        if is_current_replay_request(&watcher_session_id, episode_id, request_token) {
            ensure_replay_watch(
                &watcher_app,
                &watcher_source_id,
                &watcher_session_id,
                episode_id,
                None,
            );
            if !is_current_replay_request(&watcher_session_id, episode_id, request_token) {
                release_replay_watch_if_stale_episode(&watcher_session_id, episode_id);
            }
        }
        let target = resolve_target(&source_id, &session_id)?;
        match target {
            ResolvedReplayTarget::Imported {
                source,
                imported_session_id,
            } => with_sessions_replay_writer("replay index", |conn| {
                replay::open_window(conn, source, &imported_session_id, requested_limits)
                    .map(ResolvedReplayWindow::Imported)
            }),
            ResolvedReplayTarget::CollaborationSnapshot => {
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_read_window_from_conn(
                    &conn,
                    &session_id,
                    None,
                    None,
                    None,
                    requested_limits,
                )
                .map(ResolvedReplayWindow::CollaborationSnapshot)
            }
            ResolvedReplayTarget::ManagedChunkStore => {
                managed_chunk_open_window(&session_id, requested_limits)
                    .map(ResolvedReplayWindow::ManagedChunks)
            }
            ResolvedReplayTarget::NotReady => Ok(ResolvedReplayWindow::NotReady),
        }
    })
    .await
    .map_err(|err| format!("join replay open task: {err}"))??;

    match window {
        ResolvedReplayWindow::NotReady => {
            let mut response = not_ready_window(&requested_source_id, &display_session_id);
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            Ok(response)
        }
        ResolvedReplayWindow::Imported(window) => {
            let mut response = normalize_window(window, &display_session_id);
            remap_cursor(
                &mut response.cursor,
                &requested_source_id,
                &display_session_id,
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            let generation = response.cursor.generation.clone();
            let revision = response.cursor.revision;
            persist_shell_replays_for_delivery(
                &requested_source_id,
                &display_session_id,
                &generation,
                revision,
                &mut response.events,
            )
            .await?;
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            // Canonical open is authoritative for external/managed history.
            // Keep a synthesized managed user bubble only until the native
            // transcript provides its real user row.
            let has_real_user = response
                .events
                .iter()
                .any(|event| event.source == EventSource::User);
            let synthetic = if has_real_user {
                None
            } else {
                state
                    .with_store_opt(&display_session_id, |store| {
                        store
                            .events()
                            .iter()
                            .find(|event| {
                                event.source == EventSource::User
                                    && event.id.contains("synthesized")
                            })
                            .cloned()
                    })
                    .flatten()
            };
            if let Some(synthetic) = synthetic {
                response.events.insert(0, synthetic);
            }
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            response.watcher_available = ensure_replay_watch(
                &app,
                &requested_source_id,
                &display_session_id,
                episode_id,
                Some(&response.cursor.generation),
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            // `false` is one byte larger than `true`; watcher attachment can
            // therefore never invalidate the already-checked wire budget.
            refresh_window_wire_bytes(&mut response)?;
            if !apply_foreground_window_if_current(
                &state,
                &display_session_id,
                episode_id,
                request_token,
                &response.events,
                ReplayWindowPublish::Replace,
            ) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            state.cap_external_replay_store(
                &display_session_id,
                super::super::BOUNDED_REPLAY_STORE_MAX_BYTES,
            )?;
            schedule_replay_cache_prune();
            schedule_notify(&app, &state, &display_session_id);
            Ok(response)
        }
        ResolvedReplayWindow::CollaborationSnapshot(mut response) => {
            remap_cursor(
                &mut response.cursor,
                &requested_source_id,
                &display_session_id,
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            let generation = response.cursor.generation.clone();
            let revision = response.cursor.revision;
            persist_shell_replays_for_delivery(
                &requested_source_id,
                &display_session_id,
                &generation,
                revision,
                &mut response.events,
            )
            .await?;
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            response.watcher_available = ensure_replay_watch(
                &app,
                &requested_source_id,
                &display_session_id,
                episode_id,
                Some(&response.cursor.generation),
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            refresh_window_wire_bytes(&mut response)?;
            if !apply_foreground_window_if_current(
                &state,
                &display_session_id,
                episode_id,
                request_token,
                &response.events,
                ReplayWindowPublish::Replace,
            ) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            state.cap_external_replay_store(
                &display_session_id,
                super::super::BOUNDED_REPLAY_STORE_MAX_BYTES,
            )?;
            schedule_replay_cache_prune();
            schedule_notify(&app, &state, &display_session_id);
            Ok(response)
        }
        ResolvedReplayWindow::ManagedChunks(window) => {
            let mut response = normalize_window(window, &display_session_id);
            remap_cursor(
                &mut response.cursor,
                &requested_source_id,
                &display_session_id,
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            let generation = response.cursor.generation.clone();
            let revision = response.cursor.revision;
            persist_shell_replays_for_delivery(
                &requested_source_id,
                &display_session_id,
                &generation,
                revision,
                &mut response.events,
            )
            .await?;
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                return Ok(response);
            }
            response.watcher_available = ensure_replay_watch(
                &app,
                &requested_source_id,
                &display_session_id,
                episode_id,
                Some(&response.cursor.generation),
            );
            if !is_current_replay_request(&display_session_id, episode_id, request_token) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            refresh_window_wire_bytes(&mut response)?;
            if !apply_foreground_window_if_current(
                &state,
                &display_session_id,
                episode_id,
                request_token,
                &response.events,
                ReplayWindowPublish::Replace,
            ) {
                release_replay_watch_if_stale_episode(&display_session_id, episode_id);
                return Ok(response);
            }
            state.cap_external_replay_store(
                &display_session_id,
                super::super::BOUNDED_REPLAY_STORE_MAX_BYTES,
            )?;
            schedule_replay_cache_prune();
            schedule_notify(&app, &state, &display_session_id);
            Ok(response)
        }
    }
}

#[tauri::command]
pub async fn external_replay_poll_delta(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    cursor: ReplayCursor,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayDelta, String> {
    validate_display_cursor(&source_id, &session_id, &cursor)?;
    let request_token =
        begin_validated_foreground_request(&source_id, &session_id, episode_id, false)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let delta =
        tokio::task::spawn_blocking(move || match resolve_target(&source_id, &session_id)? {
            ResolvedReplayTarget::Imported {
                source,
                imported_session_id,
            } => {
                let mut underlying_cursor = cursor;
                underlying_cursor.source_id = source.as_str().to_string();
                underlying_cursor.session_id = imported_session_id.clone();
                with_sessions_replay_writer("replay index", |conn| {
                    replay::poll_delta(
                        conn,
                        source,
                        &imported_session_id,
                        &underlying_cursor,
                        requested_limits,
                    )
                    .map(ResolvedReplayDelta::Imported)
                })
            }
            ResolvedReplayTarget::CollaborationSnapshot => {
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_poll_delta_from_conn(
                    &conn,
                    &session_id,
                    &cursor,
                    requested_limits,
                )
                .map(ResolvedReplayDelta::CollaborationSnapshot)
            }
            ResolvedReplayTarget::ManagedChunkStore => {
                managed_chunk_poll_delta(&session_id, &cursor, requested_limits)
                    .map(ResolvedReplayDelta::ManagedChunks)
            }
            ResolvedReplayTarget::NotReady => Ok(ResolvedReplayDelta::NotReady),
        })
        .await
        .map_err(|err| format!("join replay poll task: {err}"))??;

    if matches!(delta, ResolvedReplayDelta::NotReady) {
        let mut response = not_ready_delta(&requested_source_id, &display_session_id);
        finalize_delta_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }
    let mut response = match delta {
        ResolvedReplayDelta::Imported(delta) | ResolvedReplayDelta::ManagedChunks(delta) => {
            normalize_delta(delta, &display_session_id)
        }
        ResolvedReplayDelta::CollaborationSnapshot(delta) => delta,
        ResolvedReplayDelta::NotReady => unreachable!(),
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        return Ok(response);
    }
    let generation = response.cursor.generation.clone();
    let revision = response.cursor.revision;
    persist_shell_replays_for_delivery(
        &requested_source_id,
        &display_session_id,
        &generation,
        revision,
        &mut response.events,
    )
    .await?;
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        return Ok(response);
    }
    // Preflight with the largest possible stats and the longer `false`
    // watcher value. No EventStore mutation or cursor delivery happens if
    // the final normalized wire response exceeds the caller's hard budget.
    response.stats.upserted_events = response.events.len() as u64;
    response.stats.removed_events = response.removed_event_ids.len() as u64;
    finalize_delta_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        return Ok(response);
    }
    response.watcher_available = ensure_replay_watch(
        &app,
        &requested_source_id,
        &display_session_id,
        episode_id,
        Some(&response.cursor.generation),
    );
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        release_replay_watch_if_stale_episode(&display_session_id, episode_id);
        return Ok(response);
    }
    let Some(applied) = apply_foreground_delta_if_current(
        &state,
        &display_session_id,
        episode_id,
        request_token,
        &response,
    ) else {
        release_replay_watch_if_stale_episode(&display_session_id, episode_id);
        return Ok(response);
    };
    response.stats.upserted_events = applied.upserted;
    response.stats.removed_events = applied.removed;
    state.cap_external_replay_store(
        &display_session_id,
        super::super::BOUNDED_REPLAY_STORE_MAX_BYTES,
    )?;
    if applied.changed {
        schedule_notify(&app, &state, &display_session_id);
    }
    // Actual no-op filtering can only reduce the decimal stats width, and
    // `watcherAvailable=true` is shorter than the preflight `false` value.
    refresh_delta_wire_bytes(&mut response)?;
    if response.reset_required
        || response.stats.parsed_bytes > 0
        || response.stats.parsed_rows > 0
        || response.stats.upserted_events > 0
        || response.stats.removed_events > 0
    {
        schedule_replay_cache_prune();
    }
    Ok(response)
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub async fn external_replay_read_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    before_sequence: Option<i64>,
    turn_id: Option<String>,
    turn_index: Option<i64>,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    let locator_count = usize::from(before_sequence.is_some())
        + usize::from(turn_id.is_some())
        + usize::from(turn_index.is_some());
    if locator_count > 1 {
        return Err("beforeSequence, turnId and turnIndex are mutually exclusive".to_string());
    }
    let request_token =
        begin_validated_foreground_request(&source_id, &session_id, episode_id, false)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let window =
        tokio::task::spawn_blocking(move || match resolve_target(&source_id, &session_id)? {
            ResolvedReplayTarget::Imported {
                source,
                imported_session_id,
            } => with_sessions_replay_writer("replay index", |conn| {
                if let Some(turn_id) = turn_id.as_deref() {
                    replay::read_turn_window(
                        conn,
                        source,
                        &imported_session_id,
                        turn_id,
                        requested_limits,
                    )
                } else if let Some(turn_index) = turn_index {
                    replay::read_turn_window_at_index(
                        conn,
                        source,
                        &imported_session_id,
                        turn_index,
                        requested_limits,
                    )
                } else {
                    replay::read_window(
                        conn,
                        source,
                        &imported_session_id,
                        before_sequence,
                        requested_limits,
                    )
                }
                .map(ResolvedReplayWindow::Imported)
            }),
            ResolvedReplayTarget::CollaborationSnapshot => {
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_read_window_from_conn(
                    &conn,
                    &session_id,
                    before_sequence,
                    turn_id.as_deref(),
                    turn_index,
                    requested_limits,
                )
                .map(ResolvedReplayWindow::CollaborationSnapshot)
            }
            ResolvedReplayTarget::ManagedChunkStore => managed_chunk_read_window(
                &session_id,
                before_sequence,
                turn_id.as_deref(),
                turn_index,
                requested_limits,
            )
            .map(ResolvedReplayWindow::ManagedChunks),
            ResolvedReplayTarget::NotReady => Ok(ResolvedReplayWindow::NotReady),
        })
        .await
        .map_err(|err| format!("join replay window task: {err}"))??;
    if matches!(window, ResolvedReplayWindow::NotReady) {
        let mut response = not_ready_window(&requested_source_id, &display_session_id);
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }
    let mut response = match window {
        ResolvedReplayWindow::Imported(window) | ResolvedReplayWindow::ManagedChunks(window) => {
            normalize_window(window, &display_session_id)
        }
        ResolvedReplayWindow::CollaborationSnapshot(window) => window,
        ResolvedReplayWindow::NotReady => unreachable!(),
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        return Ok(response);
    }
    let generation = response.cursor.generation.clone();
    let revision = response.cursor.revision;
    persist_shell_replays_for_delivery(
        &requested_source_id,
        &display_session_id,
        &generation,
        revision,
        &mut response.events,
    )
    .await?;
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        return Ok(response);
    }
    response.watcher_available = external_replay_watcher::is_available(&display_session_id);
    finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !is_current_replay_request(&display_session_id, episode_id, request_token) {
        return Ok(response);
    }
    if !apply_foreground_window_if_current(
        &state,
        &display_session_id,
        episode_id,
        request_token,
        &response.events,
        ReplayWindowPublish::Merge,
    ) {
        return Ok(response);
    }
    state.cap_external_replay_store(
        &display_session_id,
        super::super::BOUNDED_REPLAY_STORE_MAX_BYTES,
    )?;
    if !response.events.is_empty() {
        schedule_notify(&app, &state, &display_session_id);
    }
    schedule_replay_cache_prune();
    Ok(response)
}

/// Side-effect-free bounded replay query for hover cards, export previews,
/// raw transcript virtualization and other read-only consumers. It may advance
/// the persistent compact source index, but it never acquires a foreground
/// watcher, touches EventStore, schedules `es:changed`, or participates in a
/// delivery request token.
#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub async fn external_replay_query_window(
    source_id: String,
    session_id: String,
    before_sequence: Option<i64>,
    turn_id: Option<String>,
    turn_index: Option<i64>,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        load_replay_query_window(
            &source_id,
            &session_id,
            before_sequence,
            turn_id.as_deref(),
            turn_index,
            requested_limits,
        )
    })
    .await
    .map_err(|err| format!("join pure replay query task: {err}"))??;

    let mut response = match window {
        ResolvedReplayWindow::Imported(window) | ResolvedReplayWindow::ManagedChunks(window) => {
            normalize_window(window, &display_session_id)
        }
        ResolvedReplayWindow::CollaborationSnapshot(window) => window,
        ResolvedReplayWindow::NotReady => {
            not_ready_window(&requested_source_id, &display_session_id)
        }
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );
    finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !response.stats.not_ready {
        schedule_replay_cache_prune();
    }
    Ok(response)
}

/// Prewarm one bounded external-history window and publish it directly into
/// EventStore. Source parsing, normalization, Shell replay persistence and the
/// authoritative replace all remain in Rust; the renderer receives the window
/// only once and never sends its `SessionEvent[]` back over IPC.
///
/// Prewarm episodes are deliberately independent from foreground watcher
/// episodes. A session switch/close clears both registries, while a newer
/// prewarm episode invalidates any late completion from an earlier A visit.
#[tauri::command]
pub async fn external_replay_prewarm_window(
    app: AppHandle,
    state: State<'_, EventStoreState>,
    source_id: String,
    session_id: String,
    episode_id: u64,
    limits: Option<ReplayLimits>,
) -> Result<ExternalReplayWindow, String> {
    // This cheap identity check runs before registering an episode, so a
    // native SDE session can neither call replay nor leave retained guard
    // state, even if a caller spoofs an external source id.
    let request_token = begin_validated_prewarm_request(&source_id, &session_id, episode_id)?;
    let requested_limits = limits.unwrap_or_default().bounded();
    let display_session_id = session_id.clone();
    let requested_source_id = source_id.clone();
    let window = tokio::task::spawn_blocking(move || {
        load_replay_query_window(&source_id, &session_id, None, None, None, requested_limits)
    })
    .await
    .map_err(|err| format!("join replay prewarm task: {err}"))??;

    let mut response = match window {
        ResolvedReplayWindow::Imported(window) | ResolvedReplayWindow::ManagedChunks(window) => {
            normalize_window(window, &display_session_id)
        }
        ResolvedReplayWindow::CollaborationSnapshot(window) => window,
        ResolvedReplayWindow::NotReady => {
            not_ready_window(&requested_source_id, &display_session_id)
        }
    };
    remap_cursor(
        &mut response.cursor,
        &requested_source_id,
        &display_session_id,
    );

    if response.stats.not_ready {
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }
    if !is_current_prewarm_request(&display_session_id, episode_id, request_token) {
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }

    let generation = response.cursor.generation.clone();
    let revision = response.cursor.revision;
    persist_shell_replays_for_delivery(
        &requested_source_id,
        &display_session_id,
        &generation,
        revision,
        &mut response.events,
    )
    .await?;
    if !is_current_prewarm_request(&display_session_id, episode_id, request_token) {
        finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
        return Ok(response);
    }

    // Prewarming is demand-driven and never owns a foreground watcher.
    response.watcher_available = false;
    finalize_window_wire_budget(&mut response, requested_limits.max_ipc_bytes)?;
    if !apply_prewarm_window_if_current(
        &state,
        &display_session_id,
        episode_id,
        request_token,
        &response.events,
    ) {
        return Ok(response);
    }
    state.cap_external_replay_store(
        &display_session_id,
        super::super::BOUNDED_REPLAY_STORE_MAX_BYTES,
    )?;
    if is_current_prewarm_request(&display_session_id, episode_id, request_token) {
        schedule_notify(&app, &state, &display_session_id);
    }
    schedule_replay_cache_prune();
    Ok(response)
}

pub(super) fn validate_query_apply_version(
    expected_generation: &str,
    expected_revision: u64,
    current_generation: &str,
    current_revision: u64,
) -> Result<(), String> {
    if current_generation != expected_generation || current_revision != expected_revision {
        return Err(format!(
            "stale external replay query {expected_generation}@{expected_revision}; current compact index is {current_generation}@{current_revision}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn external_replay_release(
    source_id: String,
    session_id: String,
    episode_id: u64,
) -> Result<(), String> {
    // Validate identity so an accidental native-SDE call cannot release an
    // unrelated external foreground lease with a colliding session id.
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID {
            return Err(format!(
                "collaboration snapshot replay release requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID}"
            ));
        }
        validate_collaboration_snapshot_session_id(&session_id)?;
    } else if session_id.starts_with("cliagent-") {
        if source_id != MANAGED_CLI_REPLAY_TARGET_ID {
            return Err(format!(
                "managed replay release requires sourceId={MANAGED_CLI_REPLAY_TARGET_ID}"
            ));
        }
    } else {
        let source = ImportedHistorySourceId::parse(&source_id)?;
        source.validate_session_id(&session_id)?;
    }
    release_session_runtime_if_episode(&session_id, episode_id);
    Ok(())
}
