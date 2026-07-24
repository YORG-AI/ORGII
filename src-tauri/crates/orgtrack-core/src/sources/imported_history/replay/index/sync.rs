use super::source_identity::*;
use super::*;

pub(in crate::sources::imported_history::replay) fn sync_index(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
) -> Result<ReplaySyncResult, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let mut snapshot = source_snapshot(&resolved.path, source)?;
    let old_state = load_state(conn, source, &resolved.source_session_id)?;
    let qoder_probe = if source == ImportedHistorySourceId::Qoder {
        Some(qoder_sidecar::probe(&resolved.source_session_id)?)
    } else {
        None
    };
    let parser_version = source.descriptor().parser_version;
    // True unchanged fast path: metadata only. No file samples, parser rows,
    // normalization, EventStore upserts, or hidden I/O counters move.
    let now_ms = Utc::now().timestamp_millis();
    if old_state.as_ref().is_some_and(|state| {
        state.parser_version == parser_version
            && state.source_identity == snapshot.identity
            && state.indexed_size_bytes == snapshot.size_bytes
            && state.indexed_mtime_ns == snapshot.mtime_ns
            && qoder_probe.as_ref().is_none_or(|probe| {
                qoder_sidecar::cursor_signature(&state.driver_cursor_json).as_deref()
                    == Some(probe.signature.as_str())
            })
            && now_ms.saturating_sub(state.state_updated_at_ms) < 60_000
    }) {
        return Ok(ReplaySyncResult::default());
    }
    snapshot.sample_fingerprint = if is_physical_sqlite(source) {
        sqlite_physical_fingerprint(&resolved.path)?
    } else {
        sampled_file_fingerprint(&resolved.path, snapshot.size_bytes)?
    };
    if let Some(rejection_kind) = rejected_snapshot_kind(source) {
        if old_state.is_some()
            && rejected_snapshot_matches(
                conn,
                source,
                &resolved.source_session_id,
                parser_version,
                &snapshot,
                rejection_kind,
            )?
        {
            return Ok(not_ready_sync_result());
        }
    }
    let cursor_fingerprint = old_state.as_ref().and_then(|state| match source {
        ImportedHistorySourceId::CodexApp => {
            codex_jsonl::cursor_fingerprint(&state.driver_cursor_json)
        }
        source if is_shared_jsonl(source) => {
            jsonl_driver::cursor_fingerprint(&state.driver_cursor_json)
        }
        ImportedHistorySourceId::Cline => {
            whole_json_driver::cursor_fingerprint(&state.driver_cursor_json)
        }
        _ => None,
    });
    let lineage_matches = old_state.as_ref().is_none_or(|state| {
        if source == ImportedHistorySourceId::CodexApp {
            snapshot.size_bytes < state.indexed_size_bytes
                || codex_jsonl::cursor_matches_source(&resolved.path, &state.driver_cursor_json)
        } else if is_shared_jsonl(source) {
            (snapshot.size_bytes < state.indexed_size_bytes
                || jsonl_driver::cursor_matches_source(&resolved.path, &state.driver_cursor_json))
                && qoder_probe.as_ref().is_none_or(|probe| {
                    qoder_sidecar::cursor_lineage_matches(&state.driver_cursor_json, probe)
                })
        } else if source == ImportedHistorySourceId::CursorCli {
            structured_driver::cursor_lineage_matches(&resolved.path, &state.driver_cursor_json)
                .unwrap_or(false)
        } else {
            true
        }
    });
    let sqlite_schema_changed = if is_sqlite_replay(source) {
        let current = sqlite_driver::database_schema_version(&resolved.path)?;
        old_state.as_ref().is_some_and(|state| {
            sqlite_driver::cursor_schema_version(&state.driver_cursor_json)
                .is_some_and(|previous| previous != current)
        })
    } else if is_structured_sqlite(source) {
        let current = structured_driver::database_schema_version(&resolved.path)?;
        old_state.as_ref().is_some_and(|state| {
            structured_driver::cursor_schema_version(&state.driver_cursor_json)
                .is_some_and(|previous| previous != current)
        })
    } else {
        false
    };
    let generation_changed = old_state.as_ref().is_none_or(|state| {
        state.parser_version != parser_version
            || state.source_identity != snapshot.identity
            || sqlite_schema_changed
            || !lineage_matches
            || (source == ImportedHistorySourceId::Cline
                && (snapshot.size_bytes != state.indexed_size_bytes
                    || snapshot.mtime_ns != state.indexed_mtime_ns
                    || cursor_fingerprint.as_deref() != Some(snapshot.sample_fingerprint.as_str())))
            || (!is_physical_sqlite(source)
                && source != ImportedHistorySourceId::Cline
                && (snapshot.size_bytes < state.indexed_size_bytes
                    || (snapshot.size_bytes == state.indexed_size_bytes
                        && cursor_fingerprint.as_deref()
                            != Some(snapshot.sample_fingerprint.as_str()))))
    });

    if let Some(state) = old_state.as_ref() {
        if !is_physical_sqlite(source)
            && !generation_changed
            && state.indexed_size_bytes == snapshot.size_bytes
            && cursor_fingerprint.as_deref() == Some(snapshot.sample_fingerprint.as_str())
            && qoder_probe.as_ref().is_none_or(|probe| {
                qoder_sidecar::cursor_signature(&state.driver_cursor_json).as_deref()
                    == Some(probe.signature.as_str())
            })
        {
            conn.execute(
                "UPDATE imported_replay_state SET updated_at=?3
                 WHERE source=?1 AND source_session_id=?2 AND valid=1",
                params![
                    source.as_str(),
                    resolved.source_session_id,
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|err| format!("touch replay integrity watermark: {err}"))?;
            return Ok(ReplaySyncResult::default());
        }
    }

    let generation = if generation_changed {
        let base = make_generation(
            source,
            &resolved.source_session_id,
            parser_version,
            &snapshot,
        );
        qoder_probe.as_ref().map_or(base.clone(), |probe| {
            format!(
                "{base}-q{}",
                &probe.signature[..probe.signature.len().min(12)]
            )
        })
    } else {
        old_state
            .as_ref()
            .expect("unchanged generation has state")
            .generation
            .clone()
    };
    let previous_generation = old_state.as_ref().map(|state| state.generation.clone());
    let write_revision = if generation_changed {
        1
    } else {
        old_state
            .as_ref()
            .map_or(1, |state| state.revision.saturating_add(1))
    };
    conn.pragma_update(None, "cache_size", -REPLAY_INDEX_CACHE_KIB)
        .map_err(|err| format!("bound imported replay SQLite page cache: {err}"))?;
    // Reserve the SQLite writer before streaming/parsing the external source.
    // A deferred transaction can hold an old read snapshot for many seconds
    // and then fail with SQLITE_BUSY_SNAPSHOT on its first artifact/index
    // write if another startup writer committed in the meantime. IMMEDIATE
    // makes that contention wait at the transaction boundary instead.
    let tx = begin_replay_write_transaction(conn, "imported replay")?;
    let previous = (!generation_changed)
        .then_some(old_state.as_ref())
        .flatten();
    let outcome = match replay_driver_kind(source) {
        ReplayDriverKind::CodexJsonl => {
            let outcome = codex_jsonl::sync(
                &tx,
                session_id,
                &resolved.source_session_id,
                &resolved.path,
                &generation,
                write_revision,
                previous,
                &snapshot.sample_fingerprint,
            )?;
            debug_assert!(!outcome.changed || outcome.stats.upserted_events > 0);
            DriverSyncOutcome {
                stats: outcome.stats,
                driver_cursor_json: outcome.driver_cursor_json,
                indexed_size_bytes: outcome.indexed_size_bytes,
                total_events: outcome.total_events,
                total_turns: outcome.total_turns,
                removed_event_ids: Vec::new(),
            }
        }
        ReplayDriverKind::SharedJsonl => {
            let outcome = jsonl_driver::sync(
                &tx,
                source,
                session_id,
                &resolved.source_session_id,
                &resolved.path,
                &generation,
                write_revision,
                previous,
                &snapshot.sample_fingerprint,
            )?;
            debug_assert!(
                !outcome.changed
                    || outcome.stats.upserted_events > 0
                    || outcome.stats.removed_events > 0
            );
            DriverSyncOutcome {
                stats: outcome.stats,
                driver_cursor_json: outcome.driver_cursor_json,
                indexed_size_bytes: outcome.indexed_size_bytes,
                total_events: outcome.total_events,
                total_turns: outcome.total_turns,
                // Qoder stages compact tombstones directly in the same
                // transaction; other JSONL adapters are append/reset only.
                removed_event_ids: Vec::new(),
            }
        }
        ReplayDriverKind::Sqlite => {
            let outcome = sqlite_driver::sync(
                &tx,
                source,
                session_id,
                &resolved.source_session_id,
                &resolved.path,
                &generation,
                write_revision,
                previous,
            )?;
            debug_assert!(
                !outcome.changed
                    || outcome.stats.upserted_events > 0
                    || outcome.stats.removed_events > 0
            );
            DriverSyncOutcome {
                stats: outcome.stats,
                driver_cursor_json: outcome.driver_cursor_json,
                indexed_size_bytes: snapshot.size_bytes,
                total_events: outcome.total_events,
                total_turns: outcome.total_turns,
                removed_event_ids: outcome.removed_event_ids,
            }
        }
        ReplayDriverKind::StructuredSqlite => {
            let outcome = match structured_driver::sync(
                &tx,
                source,
                session_id,
                &resolved.source_session_id,
                &resolved.path,
                &generation,
                write_revision,
                previous,
            ) {
                Ok(outcome) => outcome,
                Err(error)
                    if old_state.is_some()
                        && error.starts_with(
                            "Cursor CLI replay lineage changed during synchronization",
                        ) =>
                {
                    drop(tx);
                    record_rejected_snapshot(
                        conn,
                        source,
                        &resolved.source_session_id,
                        parser_version,
                        &snapshot,
                        RejectedSnapshotKind::CursorCliLineageChanged,
                    )?;
                    return Ok(not_ready_sync_result());
                }
                Err(error) => return Err(error),
            };
            debug_assert!(
                !outcome.changed
                    || outcome.stats.upserted_events > 0
                    || outcome.stats.removed_events > 0
            );
            DriverSyncOutcome {
                stats: outcome.stats,
                driver_cursor_json: outcome.driver_cursor_json,
                indexed_size_bytes: snapshot.size_bytes,
                total_events: outcome.total_events,
                total_turns: outcome.total_turns,
                removed_event_ids: outcome.removed_event_ids,
            }
        }
        ReplayDriverKind::WholeJson => {
            let outcome = match whole_json_driver::sync(
                &tx,
                session_id,
                &resolved.source_session_id,
                &resolved.path,
                &generation,
                write_revision,
                previous,
                &snapshot.sample_fingerprint,
            ) {
                Ok(outcome) => outcome,
                Err(error)
                    if old_state.is_some() && error.starts_with("parse Cline replay source") =>
                {
                    drop(tx);
                    record_rejected_snapshot(
                        conn,
                        source,
                        &resolved.source_session_id,
                        parser_version,
                        &snapshot,
                        RejectedSnapshotKind::ClineInvalidDocument,
                    )?;
                    return Ok(not_ready_sync_result());
                }
                Err(error) => return Err(error),
            };
            DriverSyncOutcome {
                stats: outcome.stats,
                driver_cursor_json: outcome.driver_cursor_json,
                indexed_size_bytes: outcome.indexed_size_bytes,
                total_events: outcome.total_events,
                total_turns: outcome.total_turns,
                removed_event_ids: Vec::new(),
            }
        }
    };
    // A whole-document writer can replace the file while the streaming
    // visitor is running. Publish only when the exact snapshot parsed above
    // is still current; otherwise roll the transaction back and keep the
    // previous valid generation visible. This also avoids a separate 30 MiB
    // preflight parse on every complete rewrite.
    if source == ImportedHistorySourceId::Cline {
        let mut after_parse = source_snapshot(&resolved.path, source)?;
        after_parse.sample_fingerprint =
            sampled_file_fingerprint(&resolved.path, after_parse.size_bytes)?;
        if after_parse.identity != snapshot.identity
            || after_parse.size_bytes != snapshot.size_bytes
            || after_parse.mtime_ns != snapshot.mtime_ns
            || after_parse.sample_fingerprint != snapshot.sample_fingerprint
        {
            drop(tx);
            if old_state.is_some() {
                return Ok(ReplaySyncResult {
                    stats: ReplayStats {
                        not_ready: true,
                        ..ReplayStats::default()
                    },
                    generation_changed: false,
                });
            }
            return Err(
                "Cline replay source changed while it was being indexed; retry".to_string(),
            );
        }
    }
    let revision = if generation_changed {
        1
    } else {
        publish_change_log(
            &tx,
            source,
            &resolved.source_session_id,
            &generation,
            old_state.as_ref().map_or(0, |state| state.revision),
            write_revision,
            &outcome.removed_event_ids,
        )?
    };
    tx.execute(
        "INSERT INTO imported_replay_state (
            source, source_session_id, generation, revision, parser_version,
            source_identity, driver_cursor_json, indexed_size_bytes,
            indexed_mtime_ns, total_events, total_turns, valid, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12)
         ON CONFLICT(source, source_session_id) DO UPDATE SET
            generation=excluded.generation,
            revision=excluded.revision,
            parser_version=excluded.parser_version,
            source_identity=excluded.source_identity,
            driver_cursor_json=excluded.driver_cursor_json,
            indexed_size_bytes=excluded.indexed_size_bytes,
            indexed_mtime_ns=excluded.indexed_mtime_ns,
            total_events=excluded.total_events,
            total_turns=excluded.total_turns,
            valid=1,
            updated_at=excluded.updated_at",
        params![
            source.as_str(),
            resolved.source_session_id,
            generation,
            revision as i64,
            parser_version as i64,
            snapshot.identity,
            outcome.driver_cursor_json,
            outcome.indexed_size_bytes as i64,
            snapshot.mtime_ns,
            outcome.total_events as i64,
            outcome.total_turns as i64,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|err| format!("publish imported replay state: {err}"))?;
    clear_rejected_snapshot(&tx, source, &resolved.source_session_id)?;

    crate::sources::imported_history::catalog::publish_from_replay_tx(
        &tx,
        source,
        &resolved.source_session_id,
        &generation,
        outcome.total_events,
        generation_changed || outcome.stats.upserted_events > 0 || outcome.stats.removed_events > 0,
        snapshot.mtime_ns,
        &outcome.driver_cursor_json,
    )?;

    if generation_changed {
        if let Some(previous_generation) = previous_generation {
            if previous_generation != generation {
                tx.execute(
                    "DELETE FROM imported_replay_events
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced replay events: {err}"))?;
                tx.execute(
                    "DELETE FROM imported_replay_turns
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced replay turns: {err}"))?;
                // SQLite drivers keep compact hashes for ignored as well as
                // rendered rows; a replaced generation must retire both.
                tx.execute(
                    "DELETE FROM imported_replay_source_rows
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced replay source rows: {err}"))?;
                tx.execute(
                    "DELETE FROM imported_replay_changes
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced replay changes: {err}"))?;
                tx.execute(
                    "DELETE FROM imported_replay_structured_events
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced structured replay events: {err}"))?;
                tx.execute(
                    "DELETE FROM imported_replay_structured_rows
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced structured replay rows: {err}"))?;
                tx.execute(
                    "DELETE FROM imported_replay_payload_artifact_refs
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced replay payload artifact refs: {err}"))?;
                tx.execute(
                    "DELETE FROM imported_replay_payload_artifacts
                     WHERE source=?1 AND source_session_id=?2 AND generation=?3
                       AND NOT EXISTS(
                         SELECT 1 FROM imported_replay_shell_segments AS shell
                         WHERE shell.source=imported_replay_payload_artifacts.source
                           AND shell.source_session_id=imported_replay_payload_artifacts.source_session_id
                           AND shell.generation=imported_replay_payload_artifacts.generation
                           AND shell.content_hash=imported_replay_payload_artifacts.content_hash
                       )",
                    params![
                        source.as_str(),
                        resolved.source_session_id,
                        previous_generation
                    ],
                )
                .map_err(|err| format!("remove replaced replay payload artifacts: {err}"))?;
            }
        }
    }
    tx.commit()
        .map_err(|err| format!("commit imported replay index: {err}"))?;
    conn.execute_batch("PRAGMA shrink_memory")
        .map_err(|err| format!("release imported replay SQLite page cache: {err}"))?;
    Ok(ReplaySyncResult {
        stats: outcome.stats,
        generation_changed,
    })
}

pub(super) const fn rejected_snapshot_kind(
    source: ImportedHistorySourceId,
) -> Option<RejectedSnapshotKind> {
    match source {
        ImportedHistorySourceId::Cline => Some(RejectedSnapshotKind::ClineInvalidDocument),
        ImportedHistorySourceId::CursorCli => Some(RejectedSnapshotKind::CursorCliLineageChanged),
        _ => None,
    }
}

pub(super) fn not_ready_sync_result() -> ReplaySyncResult {
    ReplaySyncResult {
        stats: ReplayStats {
            not_ready: true,
            ..ReplayStats::default()
        },
        generation_changed: false,
    }
}

pub(super) fn rejected_snapshot_matches(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    parser_version: u32,
    snapshot: &SourcePhysicalSnapshot,
    rejection_kind: RejectedSnapshotKind,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM imported_replay_rejected_snapshots
             WHERE source=?1 AND source_session_id=?2 AND parser_version=?3
               AND source_identity=?4 AND source_size_bytes=?5
               AND source_mtime_ns=?6 AND sample_fingerprint=?7
               AND rejection_kind=?8
         )",
        params![
            source.as_str(),
            source_session_id,
            i64::from(parser_version),
            snapshot.identity,
            snapshot.size_bytes.min(i64::MAX as u64) as i64,
            snapshot.mtime_ns,
            snapshot.sample_fingerprint,
            rejection_kind.as_str(),
        ],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|err| format!("query rejected replay snapshot: {err}"))
}

pub(super) fn record_rejected_snapshot(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    parser_version: u32,
    snapshot: &SourcePhysicalSnapshot,
    rejection_kind: RejectedSnapshotKind,
) -> Result<(), String> {
    // The failed generation transaction has already rolled back. Publish the
    // physical rejection watermark in a separate short transaction so a crash
    // can never make it visible by partially overwriting the last valid state.
    let tx = begin_replay_write_transaction(conn, "rejected replay snapshot")?;
    tx.execute(
        "INSERT INTO imported_replay_rejected_snapshots(
             source,source_session_id,parser_version,source_identity,
             source_size_bytes,source_mtime_ns,sample_fingerprint,
             rejection_kind,rejected_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(source,source_session_id) DO UPDATE SET
             parser_version=excluded.parser_version,
             source_identity=excluded.source_identity,
             source_size_bytes=excluded.source_size_bytes,
             source_mtime_ns=excluded.source_mtime_ns,
             sample_fingerprint=excluded.sample_fingerprint,
             rejection_kind=excluded.rejection_kind,
             rejected_at=excluded.rejected_at",
        params![
            source.as_str(),
            source_session_id,
            i64::from(parser_version),
            snapshot.identity,
            snapshot.size_bytes.min(i64::MAX as u64) as i64,
            snapshot.mtime_ns,
            snapshot.sample_fingerprint,
            rejection_kind.as_str(),
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|err| format!("record rejected replay snapshot: {err}"))?;
    tx.commit()
        .map_err(|err| format!("commit rejected replay snapshot: {err}"))
}

pub(super) fn clear_rejected_snapshot(
    tx: &rusqlite::Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_rejected_snapshots
         WHERE source=?1 AND source_session_id=?2",
        params![source.as_str(), source_session_id],
    )
    .map(|_| ())
    .map_err(|err| format!("clear rejected replay snapshot: {err}"))
}

pub(super) fn publish_change_log(
    tx: &rusqlite::Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    base_revision: u64,
    temporary_revision: u64,
    removed_event_ids: &[String],
) -> Result<u64, String> {
    let base = base_revision.min(i64::MAX as u64) as i64;
    let temporary = temporary_revision.min(i64::MAX as u64) as i64;
    tx.execute(
        "INSERT INTO imported_replay_changes(
             source,source_session_id,generation,change_revision,event_id,change_kind,sequence
         )
         SELECT source,source_session_id,generation,
                ?1 + ROW_NUMBER() OVER (ORDER BY sequence,event_id),
                event_id,'upsert',sequence
         FROM imported_replay_events
         WHERE source=?2 AND source_session_id=?3 AND generation=?4
           AND event_revision=?5",
        params![
            base,
            source.as_str(),
            source_session_id,
            generation,
            temporary
        ],
    )
    .map_err(|err| format!("append replay upsert changes: {err}"))?;
    tx.execute(
        "UPDATE imported_replay_events AS event SET event_revision=(
             SELECT change_revision FROM imported_replay_changes AS change
             WHERE change.source=event.source
               AND change.source_session_id=event.source_session_id
               AND change.generation=event.generation
               AND change.event_id=event.event_id
               AND change.change_kind='upsert'
             ORDER BY change.change_revision DESC LIMIT 1
         ) WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND event_revision=?4",
        params![source.as_str(), source_session_id, generation, temporary],
    )
    .map_err(|err| format!("assign per-change replay revisions: {err}"))?;
    let upsert_count = tx
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_changes
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND change_revision>?4",
            params![source.as_str(), source_session_id, generation, base],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count replay upsert changes: {err}"))?
        .max(0) as u64;
    let mut revision = base_revision.saturating_add(upsert_count);
    for event_id in removed_event_ids {
        revision = revision.saturating_add(1);
        tx.execute(
            "INSERT INTO imported_replay_changes(
                 source,source_session_id,generation,change_revision,event_id,change_kind,sequence
             ) VALUES(?1,?2,?3,?4,?5,'remove',NULL)",
            params![
                source.as_str(),
                source_session_id,
                generation,
                revision.min(i64::MAX as u64) as i64,
                event_id
            ],
        )
        .map_err(|err| format!("append replay removal change: {err}"))?;
    }
    Ok(revision)
}
