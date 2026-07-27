use super::*;

pub(super) fn open_foreground_imported_window(
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let limits = replay_storage_limits_with_normalization_headroom(limits);
    // A visible open is authoritative: synchronize the provider before
    // returning the newest compact window. Use an independent connection so
    // this does not queue behind the process-wide multi-provider catalog
    // mutex; SQLite's IMMEDIATE transaction remains the cross-process writer
    // boundary.
    with_foreground_replay_connection("replay index open", |conn| {
        replay::open_window(conn, source, session_id, limits)
    })
}

pub(super) fn read_foreground_imported_window(
    source: ImportedHistorySourceId,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let limits = replay_storage_limits_with_normalization_headroom(limits);
    let cached = {
        let mut conn = database::db::get_connection()
            .map_err(|error| format!("open cached replay page DB: {error}"))?;
        if let Some(turn_id) = turn_id {
            replay::read_cached_turn_window(&mut conn, source, session_id, turn_id, limits)
        } else if let Some(turn_index) = turn_index {
            replay::read_cached_turn_window_at_index(
                &mut conn, source, session_id, turn_index, limits,
            )
        } else {
            replay::read_cached_window(&conn, source, session_id, before_sequence, limits)
        }?
    };
    if let Some(window) = cached {
        return Ok(window);
    }
    with_sessions_replay_writer("replay index", |conn| {
        if let Some(turn_id) = turn_id {
            replay::read_turn_window(conn, source, session_id, turn_id, limits)
        } else if let Some(turn_index) = turn_index {
            replay::read_turn_window_at_index(conn, source, session_id, turn_index, limits)
        } else {
            replay::read_window(conn, source, session_id, before_sequence, limits)
        }
    })
}

pub(super) fn load_replay_query_window(
    source_id: &str,
    session_id: &str,
    before_sequence: Option<i64>,
    turn_id: Option<&str>,
    turn_index: Option<i64>,
    limits: ReplayLimits,
) -> Result<ResolvedReplayWindow, String> {
    let locator_count = usize::from(before_sequence.is_some())
        + usize::from(turn_id.is_some())
        + usize::from(turn_index.is_some());
    if locator_count > 1 {
        return Err("beforeSequence, turnId and turnIndex are mutually exclusive".to_string());
    }
    match resolve_secondary_consumer_target(source_id, session_id)? {
        ResolvedReplayTarget::Imported {
            source,
            imported_session_id,
        } => with_sessions_replay_writer("replay query index", |conn| {
            let limits = replay_storage_limits_with_normalization_headroom(limits);
            if let Some(turn_id) = turn_id {
                replay::read_turn_window(conn, source, &imported_session_id, turn_id, limits)
            } else if let Some(turn_index) = turn_index {
                replay::read_turn_window_at_index(
                    conn,
                    source,
                    &imported_session_id,
                    turn_index,
                    limits,
                )
            } else {
                replay::read_window(conn, source, &imported_session_id, before_sequence, limits)
            }
            .map(ResolvedReplayWindow::Imported)
        }),
        ResolvedReplayTarget::CollaborationSnapshot => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open collaboration replay query DB: {err}"))?;
            collaboration_snapshot_read_window_from_conn(
                &conn,
                session_id,
                before_sequence,
                turn_id,
                turn_index,
                limits,
            )
            .map(ResolvedReplayWindow::CollaborationSnapshot)
        }
        ResolvedReplayTarget::ManagedChunkStore => managed_chunk_read_window(
            session_id,
            before_sequence,
            turn_id,
            turn_index,
            replay_storage_limits_with_normalization_headroom(limits),
        )
        .map(ResolvedReplayWindow::ManagedChunks),
        ResolvedReplayTarget::NotReady => Ok(ResolvedReplayWindow::NotReady),
    }
}

pub(super) fn resolve_target(
    source_id: &str,
    session_id: &str,
) -> Result<ResolvedReplayTarget, String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID {
            return Err(format!(
                "Collaboration snapshot replay requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID}"
            ));
        }
        validate_collaboration_snapshot_session_id(session_id)?;
        return Ok(ResolvedReplayTarget::CollaborationSnapshot);
    }
    if session_id.starts_with("cliagent-") {
        let session = crate::agent_sessions::cli::persistence::get_session(session_id)
            .map_err(|err| format!("load managed CLI replay target: {err}"))?
            .ok_or_else(|| format!("Managed CLI session not found: {session_id}"))?;
        if session.transcript_source
            == crate::agent_sessions::cli::native_transcript::TRANSCRIPT_SOURCE_NATIVE
        {
            let Some((binding, cli_session_id)) =
                crate::agent_sessions::cli::native_transcript::native_store_key_for_managed_session(
                    session_id,
                )
            else {
                return Ok(ResolvedReplayTarget::NotReady);
            };
            if source_id != MANAGED_CLI_REPLAY_TARGET_ID && source_id != binding.source {
                return Err(format!(
                    "Managed replay source mismatch: requested {source_id}, bound {}",
                    binding.source
                ));
            }
            return Ok(ResolvedReplayTarget::Imported {
                source: ImportedHistorySourceId::parse(binding.source)?,
                imported_session_id: binding.imported_session_id(&cli_session_id),
            });
        }
        if source_id != MANAGED_CLI_REPLAY_TARGET_ID {
            return Err(format!(
                "Readerless managed CLI sessions require sourceId={MANAGED_CLI_REPLAY_TARGET_ID}"
            ));
        }
        return Ok(ResolvedReplayTarget::ManagedChunkStore);
    }

    let source = ImportedHistorySourceId::parse(source_id)?;
    source.validate_session_id(session_id)?;
    Ok(ResolvedReplayTarget::Imported {
        source,
        imported_session_id: session_id.to_string(),
    })
}

/// Validate only identities admitted to the primary bounded-replay registry.
/// This intentionally excludes snapshot-backed native `agentsession-*` forks,
/// whose compact index is available solely to read-only secondary consumers.
pub(super) fn validate_primary_replay_target_identity(
    source_id: &str,
    session_id: &str,
) -> Result<(), String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID {
            return Err(format!(
                "Collaboration snapshot replay requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID}"
            ));
        }
        return validate_collaboration_snapshot_session_id(session_id);
    }
    if session_id.starts_with("cliagent-") {
        return (source_id == MANAGED_CLI_REPLAY_TARGET_ID)
            .then_some(())
            .ok_or_else(|| {
                format!("Managed prewarm requires sourceId={MANAGED_CLI_REPLAY_TARGET_ID}")
            });
    }
    let source = ImportedHistorySourceId::parse(source_id)?;
    source.validate_session_id(session_id)
}

/// Resolve only the read-only/background consumers that are allowed to reuse
/// a Cloud fork's inherited snapshot index. Foreground open/poll/read/release
/// continue to call `resolve_target`, so a native Agent session can never
/// enter replay execution or acquire a replay watcher through this path.
pub(super) fn resolve_secondary_consumer_target(
    source_id: &str,
    session_id: &str,
) -> Result<ResolvedReplayTarget, String> {
    if session_id.starts_with(COLLABORATION_SNAPSHOT_FORK_PREFIX) {
        if source_id != COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID {
            return Err(format!(
                "Snapshot-backed native fork secondary replay requires sourceId={COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID}"
            ));
        }
        if session_id.len() <= COLLABORATION_SNAPSHOT_FORK_PREFIX.len()
            || session_id.contains(['/', '\\'])
        {
            return Err("Invalid snapshot-backed native fork session id".to_string());
        }
        return Ok(ResolvedReplayTarget::CollaborationSnapshot);
    }
    resolve_target(source_id, session_id)
}

pub(super) fn ensure_replay_watch(
    app: &AppHandle,
    source_id: &str,
    session_id: &str,
    episode_id: u64,
    generation: Option<&str>,
) -> bool {
    match resolve_replay_watch_paths(source_id, session_id) {
        Ok(paths) => acquire_replay_watch_set(
            paths,
            |path| {
                external_replay_watcher::acquire(
                    app, source_id, session_id, episode_id, generation, path,
                )
            },
            || external_replay_watcher::release_session_if_episode(session_id, episode_id),
        ),
        Err(error) => {
            // Watchers are an optimization. A failed lookup must preserve the
            // typed `watcherAvailable=false` polling fallback, not fail replay.
            external_replay_watcher::release_session_if_episode(session_id, episode_id);
            log::debug!("[external-replay] watcher paths unavailable: {error}");
            false
        }
    }
}

pub(super) fn acquire_replay_watch_set(
    mut paths: Vec<PathBuf>,
    mut acquire: impl FnMut(&PathBuf) -> bool,
    release: impl FnOnce(),
) -> bool {
    paths.sort();
    paths.dedup();
    if paths.is_empty() || !paths.iter().all(&mut acquire) {
        // All-or-nothing: advertising a healthy primary watcher while a
        // storage-specific sidecar is unwatched would suppress the renderer's
        // visible 5-second fallback and hide changes for up to 60 seconds.
        release();
        return false;
    }
    true
}

pub(super) fn resolve_replay_watch_paths(
    source_id: &str,
    session_id: &str,
) -> Result<Vec<PathBuf>, String> {
    match resolve_target(source_id, session_id)? {
        ResolvedReplayTarget::Imported {
            source,
            imported_session_id,
        } => {
            let conn = database::db::get_connection()
                .map_err(|error| format!("open replay watcher index DB: {error}"))?;
            replay::watch_paths(&conn, source, &imported_session_id)
        }
        ResolvedReplayTarget::CollaborationSnapshot => Ok(vec![database::db::get_db_path()]),
        ResolvedReplayTarget::ManagedChunkStore => Ok(vec![database::db::get_db_path()]),
        ResolvedReplayTarget::NotReady => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod replay_watch_set_tests {
    use super::*;

    #[test]
    fn multi_path_acquire_deduplicates_and_succeeds_only_when_every_path_is_watched() {
        let calls = std::cell::RefCell::new(Vec::new());
        let released = std::cell::Cell::new(false);
        let ok = acquire_replay_watch_set(
            vec![
                PathBuf::from("/tmp/qoder-transcript"),
                PathBuf::from("/tmp/qoder-logs"),
                PathBuf::from("/tmp/qoder-logs"),
            ],
            |path| {
                calls.borrow_mut().push(path.clone());
                true
            },
            || released.set(true),
        );
        assert!(ok);
        assert_eq!(calls.borrow().len(), 2);
        assert!(!released.get());
    }

    #[test]
    fn partial_multi_path_failure_releases_the_session_and_forces_poll_fallback() {
        let calls = std::cell::Cell::new(0_usize);
        let released = std::cell::Cell::new(false);
        let ok = acquire_replay_watch_set(
            vec![PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b")],
            |_| {
                let next = calls.get().saturating_add(1);
                calls.set(next);
                next == 1
            },
            || released.set(true),
        );
        assert!(!ok);
        assert_eq!(calls.get(), 2);
        assert!(released.get());
    }
}
