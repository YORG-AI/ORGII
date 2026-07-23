//! ORGII-owned compact replay index synchronization and bounded queries.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::Utc;
use core_types::activity::ActivityChunk;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};

use super::{
    codex_jsonl, jsonl_driver, payload_artifact, qoder_sidecar, sqlite_driver, structured_driver,
    whole_json_driver, ImportedHistorySourceId, ReplayChunkDelta, ReplayChunkScan,
    ReplayChunkWindow, ReplayCursor, ReplayIndexedChunk, ReplayLimits,
    ReplayPayloadArtifactLocator, ReplayPayloadDescriptor, ReplayPayloadRange, ReplayStats,
    ReplayTurnHeader, HARD_MAX_PAYLOAD_RANGE_BYTES,
};

/// Replay indexing can touch hundreds of MiB inside one atomic generation
/// transaction. The application-wide SQLite default permits a 64 MiB page
/// cache, which lets dirty replay-index pages alone exceed the #443 process
/// growth budget. This connection-local cap keeps the atomic transaction but
/// makes its resident cache explicitly byte-bounded.
const REPLAY_INDEX_CACHE_KIB: i64 = 16 * 1024;

#[derive(Debug, Clone)]
pub(super) struct ReplayIndexState {
    pub generation: String,
    pub revision: u64,
    pub parser_version: u32,
    pub source_identity: String,
    pub driver_cursor_json: String,
    pub indexed_size_bytes: u64,
    pub indexed_mtime_ns: i64,
    pub total_events: u64,
    pub total_turns: u64,
    pub state_updated_at_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ReplaySyncResult {
    pub stats: ReplayStats,
    pub generation_changed: bool,
}

#[derive(Debug)]
pub(super) struct ResolvedSource {
    pub(super) source_session_id: String,
    pub(super) path: PathBuf,
}

#[derive(Debug, Clone)]
struct SourceSnapshot {
    identity: String,
    size_bytes: u64,
    mtime_ns: i64,
    sample_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RejectedSnapshotKind {
    ClineInvalidDocument,
    CursorCliLineageChanged,
}

impl RejectedSnapshotKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ClineInvalidDocument => "cline_invalid_document",
            Self::CursorCliLineageChanged => "cursor_cli_lineage_changed",
        }
    }
}

struct DriverSyncOutcome {
    stats: ReplayStats,
    driver_cursor_json: String,
    indexed_size_bytes: u64,
    total_events: u64,
    total_turns: u64,
    removed_event_ids: Vec<String>,
}

pub(super) fn sync_index(
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
    let tx = conn
        .transaction()
        .map_err(|err| format!("start imported replay transaction: {err}"))?;
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

    super::super::catalog::publish_from_replay_tx(
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

const fn rejected_snapshot_kind(source: ImportedHistorySourceId) -> Option<RejectedSnapshotKind> {
    match source {
        ImportedHistorySourceId::Cline => Some(RejectedSnapshotKind::ClineInvalidDocument),
        ImportedHistorySourceId::CursorCli => Some(RejectedSnapshotKind::CursorCliLineageChanged),
        _ => None,
    }
}

fn not_ready_sync_result() -> ReplaySyncResult {
    ReplaySyncResult {
        stats: ReplayStats {
            not_ready: true,
            ..ReplayStats::default()
        },
        generation_changed: false,
    }
}

fn rejected_snapshot_matches(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    parser_version: u32,
    snapshot: &SourceSnapshot,
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

fn record_rejected_snapshot(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    parser_version: u32,
    snapshot: &SourceSnapshot,
    rejection_kind: RejectedSnapshotKind,
) -> Result<(), String> {
    // The failed generation transaction has already rolled back. Publish the
    // physical rejection watermark in a separate short transaction so a crash
    // can never make it visible by partially overwriting the last valid state.
    let tx = conn
        .transaction()
        .map_err(|err| format!("start rejected replay snapshot transaction: {err}"))?;
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

fn clear_rejected_snapshot(
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

fn publish_change_log(
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

pub(super) fn read_recent_window(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    read_window_before(conn, source, session_id, None, limits)
}

pub(super) fn read_window_before(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    before_sequence: Option<i64>,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let ceiling = before_sequence.unwrap_or(i64::MAX);
    let newest_turn = conn
        .query_row(
            "SELECT MAX(turn_index) FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND sequence < ?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                ceiling
            ],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| format!("resolve replay window turn: {err}"))?
        .unwrap_or(0);
    let oldest_turn = newest_turn.saturating_sub(limits.max_turns.saturating_sub(1) as i64);
    let mut chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "turn_index >= ?4 AND turn_index <= ?5 AND sequence < ?6",
        &[oldest_turn, newest_turn, ceiling],
        limits,
        QueryDirection::NewestFirst,
    )?;
    chunks.reverse();
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let min_sequence = chunks.first().map_or(-1, |chunk| chunk.sequence);
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let has_older = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND sequence < ?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                min_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query older replay events: {err}"))?
        != 0;
    let turn_headers = read_turn_headers(
        conn,
        source,
        &resolved.source_session_id,
        &state.generation,
        oldest_turn,
        newest_turn,
    )?;
    Ok(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        chunks,
        turn_headers,
        total_turn_count: state.total_turns,
        total_event_count: state.total_events,
        has_older,
        stats: ReplayStats {
            ipc_bytes: ipc_bytes as u64,
            ..ReplayStats::default()
        },
    })
}

pub(super) fn read_window_for_turn(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    turn_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let turn_index = conn
        .query_row(
            "SELECT turn_index FROM imported_replay_turns
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND turn_id=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                turn_id
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("query replay turn {turn_id}: {err}"))?
        .ok_or_else(|| format!("Replay turn is no longer available: {turn_id}"))?;
    read_window_for_turn_index(conn, source, session_id, turn_index, limits)
}

pub(super) fn read_window_for_turn_index(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    requested_turn_index: i64,
    limits: ReplayLimits,
) -> Result<ReplayChunkWindow, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let turn = conn
        .query_row(
            "SELECT turn_id,turn_index,start_sequence,end_sequence,started_at,ended_at,event_count
             FROM imported_replay_turns WHERE source=?1 AND source_session_id=?2
               AND generation=?3 AND turn_index=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                requested_turn_index
            ],
            |row| {
                Ok(ReplayTurnHeader {
                    turn_id: row.get(0)?,
                    turn_index: row.get(1)?,
                    start_sequence: row.get(2)?,
                    end_sequence: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    event_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .optional()
        .map_err(|err| format!("query replay turn index {requested_turn_index}: {err}"))?
        .ok_or_else(|| {
            format!("Replay turn index is no longer available: {requested_turn_index}")
        })?;
    let hydrate_stats = hydrate_turn_if_needed(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state,
        &turn,
    )?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after turn hydration".to_string())?;
    let chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "turn_index=?4",
        &[turn.turn_index],
        limits,
        QueryDirection::OldestFirst,
    )?;
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let has_older = turn.turn_index > 0;
    Ok(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        chunks,
        turn_headers: vec![turn],
        total_turn_count: state.total_turns,
        total_event_count: state.total_events,
        has_older,
        stats: ReplayStats {
            ipc_bytes: ipc_bytes as u64,
            ..hydrate_stats
        },
    })
}

pub(super) fn hydrate_turn_if_needed(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    state: &ReplayIndexState,
    turn: &ReplayTurnHeader,
) -> Result<ReplayStats, String> {
    if !matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return Ok(ReplayStats::default());
    }
    let indexed_count = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_source_rows WHERE source=?1
               AND source_session_id=?2 AND generation=?3
               AND source_order>=?4 AND source_order<=?5",
            params![
                source.as_str(),
                source_session_id,
                state.generation,
                turn.start_sequence,
                turn.end_sequence.unwrap_or(turn.start_sequence)
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count indexed replay turn: {err}"))?
        .max(0) as u64;
    if indexed_count >= turn.event_count {
        return Ok(ReplayStats::default());
    }
    let resolved = resolve_source(conn, source, display_session_id)?;
    let write_revision = state.revision.saturating_add(1);
    let tx = conn
        .transaction()
        .map_err(|err| format!("start lazy replay turn transaction: {err}"))?;
    let stats = sqlite_driver::hydrate_kv_turn(
        &tx,
        source,
        display_session_id,
        source_session_id,
        &resolved.path,
        &state.generation,
        write_revision,
        turn.start_sequence,
        turn.end_sequence.unwrap_or(turn.start_sequence),
    )?;
    if stats.upserted_events > 0 {
        let revision = publish_change_log(
            &tx,
            source,
            source_session_id,
            &state.generation,
            state.revision,
            write_revision,
            &[],
        )?;
        tx.execute(
            "UPDATE imported_replay_state SET revision=?1,updated_at=?2
             WHERE source=?3 AND source_session_id=?4 AND generation=?5",
            params![
                revision.min(i64::MAX as u64) as i64,
                Utc::now().to_rfc3339(),
                source.as_str(),
                source_session_id,
                state.generation
            ],
        )
        .map_err(|err| format!("publish lazy replay turn revision: {err}"))?;
    }
    tx.commit()
        .map_err(|err| format!("commit lazy replay turn: {err}"))?;
    Ok(stats)
}

pub(super) fn read_scan_after(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    after_sequence: i64,
    limits: ReplayLimits,
    sync: ReplaySyncResult,
) -> Result<ReplayChunkScan, String> {
    if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        return read_lazy_kv_scan_after(conn, source, session_id, after_sequence, limits, sync);
    }
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "sequence > ?4",
        &[after_sequence],
        limits,
        QueryDirection::OldestFirst,
    )?;
    let through_sequence = chunks.last().map_or(after_sequence, |chunk| chunk.sequence);
    let has_more = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND sequence > ?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                through_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query remaining replay events: {err}"))?
        != 0;
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let mut stats = sync.stats;
    stats.ipc_bytes = ipc_bytes as u64;
    Ok(ReplayChunkScan {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        chunks,
        has_more,
        stats,
    })
}

/// Cursor/Windsurf cold indexes intentionally materialize only the newest
/// turn body. A source-neutral forward scan must therefore hydrate exactly the
/// next logical turn before reading it; querying all indexed events directly
/// would jump across the unmaterialized prefix and silently truncate exports.
fn read_lazy_kv_scan_after(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    after_sequence: i64,
    limits: ReplayLimits,
    sync: ReplaySyncResult,
) -> Result<ReplayChunkScan, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let turn = conn
        .query_row(
            "SELECT turn_id,turn_index,start_sequence,end_sequence,started_at,ended_at,event_count
             FROM imported_replay_turns
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND COALESCE(end_sequence,start_sequence)>?4
             ORDER BY turn_index ASC LIMIT 1",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                after_sequence
            ],
            |row| {
                Ok(ReplayTurnHeader {
                    turn_id: row.get(0)?,
                    turn_index: row.get(1)?,
                    start_sequence: row.get(2)?,
                    end_sequence: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    event_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .optional()
        .map_err(|err| format!("resolve next lazy replay scan turn: {err}"))?;

    let Some(turn) = turn else {
        return Ok(ReplayChunkScan {
            cursor: ReplayCursor {
                source_id: source.as_str().to_string(),
                session_id: session_id.to_string(),
                generation: state.generation,
                revision: state.revision,
                through_sequence: after_sequence,
            },
            chunks: Vec::new(),
            has_more: false,
            stats: sync.stats,
        });
    };

    let hydrate_stats = hydrate_turn_if_needed(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state,
        &turn,
    )?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after scan hydration".to_string())?;
    let chunks = read_chunks(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        "turn_index=?4 AND sequence>?5",
        &[turn.turn_index, after_sequence],
        limits,
        QueryDirection::OldestFirst,
    )?;
    let last_chunk_sequence = chunks.last().map(|chunk| chunk.sequence);
    let mut through_sequence = last_chunk_sequence.unwrap_or(after_sequence);
    let has_indexed_more_in_turn = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_events
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND turn_index=?4 AND sequence>?5
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                turn.turn_index,
                through_sequence
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query remaining lazy replay turn events: {err}"))?
        != 0;
    // A source row may intentionally normalize to no visible event. Once all
    // indexed events in this turn are consumed, advance over those positions
    // so the next call can reach the following turn without looping.
    if !has_indexed_more_in_turn {
        through_sequence = through_sequence.max(
            turn.end_sequence
                .unwrap_or(turn.start_sequence)
                .max(turn.start_sequence),
        );
    }
    let has_later_turn = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM imported_replay_turns
                WHERE source=?1 AND source_session_id=?2 AND generation=?3
                  AND turn_index>?4
             )",
            params![
                source.as_str(),
                resolved.source_session_id,
                state.generation,
                turn.turn_index
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("query later lazy replay turns: {err}"))?
        != 0;
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>();
    let mut stats = sync.stats;
    merge_stats(&mut stats, hydrate_stats);
    stats.ipc_bytes = ipc_bytes as u64;
    Ok(ReplayChunkScan {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: state.revision,
            through_sequence,
        },
        chunks,
        has_more: has_indexed_more_in_turn || has_later_turn,
        stats,
    })
}

fn merge_stats(target: &mut ReplayStats, extra: ReplayStats) {
    target.parsed_bytes = target.parsed_bytes.saturating_add(extra.parsed_bytes);
    target.parsed_rows = target.parsed_rows.saturating_add(extra.parsed_rows);
    target.normalized_events = target
        .normalized_events
        .saturating_add(extra.normalized_events);
    target.upserted_events = target.upserted_events.saturating_add(extra.upserted_events);
    target.removed_events = target.removed_events.saturating_add(extra.removed_events);
    target.ipc_bytes = target.ipc_bytes.saturating_add(extra.ipc_bytes);
    target.not_ready |= extra.not_ready;
}

pub(super) fn read_delta(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    cursor: &ReplayCursor,
    limits: ReplayLimits,
    sync: ReplaySyncResult,
) -> Result<ReplayChunkDelta, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let state = load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    if cursor.generation != state.generation {
        let mut replacement = read_recent_window(conn, source, session_id, limits)?;
        replacement.stats.parsed_bytes = sync.stats.parsed_bytes;
        replacement.stats.parsed_rows = sync.stats.parsed_rows;
        replacement.stats.normalized_events = sync.stats.normalized_events;
        replacement.stats.upserted_events = sync.stats.upserted_events;
        return Ok(ReplayChunkDelta {
            cursor: replacement.cursor,
            chunks: replacement.chunks,
            removed_event_ids: Vec::new(),
            reset_required: true,
            stats: replacement.stats,
        });
    }
    let (chunks, removed_event_ids, through_revision) = read_changes(
        conn,
        source,
        session_id,
        &resolved.source_session_id,
        &state.generation,
        limits,
        cursor.revision,
    )?;
    let through_sequence = chunks
        .iter()
        .map(|chunk| chunk.sequence)
        .max()
        .map_or(cursor.through_sequence, |sequence| {
            cursor.through_sequence.max(sequence)
        });
    let ipc_bytes = chunks
        .iter()
        .map(serialized_indexed_chunk_bytes)
        .sum::<usize>()
        .saturating_add(
            removed_event_ids
                .iter()
                .map(|event_id| serde_json::to_vec(event_id).map_or(0, |bytes| bytes.len()))
                .sum::<usize>(),
        );
    let mut stats = sync.stats;
    stats.ipc_bytes = ipc_bytes as u64;
    Ok(ReplayChunkDelta {
        cursor: ReplayCursor {
            source_id: source.as_str().to_string(),
            session_id: session_id.to_string(),
            generation: state.generation,
            revision: through_revision,
            through_sequence,
        },
        chunks,
        removed_event_ids,
        reset_required: sync.generation_changed,
        stats,
    })
}

fn read_changes(
    conn: &Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    limits: ReplayLimits,
    after_revision: u64,
) -> Result<(Vec<ReplayIndexedChunk>, Vec<String>, u64), String> {
    let mut stmt = conn
        .prepare(
            "SELECT event.sequence,event.event_id,event.turn_index,event.action_type,
                    event.function_name,event.created_at,event.args_preview_json,
                    event.result_preview_json,event.thread_id,event.process_id,
                    event.payloads_json,change.change_revision,change.change_kind,
                    change.event_id
             FROM imported_replay_changes AS change
             LEFT JOIN imported_replay_events AS event
               ON event.source=change.source
              AND event.source_session_id=change.source_session_id
              AND event.generation=change.generation
              AND event.event_id=change.event_id
             WHERE change.source=?1 AND change.source_session_id=?2
               AND change.generation=?3 AND change.change_revision>?4
             ORDER BY change.change_revision ASC LIMIT ?5",
        )
        .map_err(|err| format!("prepare replay change batch: {err}"))?;
    let mut rows = stmt
        .query(params![
            source.as_str(),
            source_session_id,
            generation,
            after_revision.min(i64::MAX as u64) as i64,
            limits.max_events as i64
        ])
        .map_err(|err| format!("query replay change batch: {err}"))?;
    let mut chunks = Vec::new();
    let mut removed = Vec::new();
    let mut ipc_bytes = 0_usize;
    let mut through_revision = after_revision;
    let mut included_turns = HashSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read replay change row: {err}"))?
    {
        let revision = row.get::<_, i64>(11).map_err(|err| err.to_string())?.max(0) as u64;
        let kind: String = row.get(12).map_err(|err| err.to_string())?;
        if kind == "remove" {
            let event_id = row.get::<_, String>(13).map_err(|err| err.to_string())?;
            let next_bytes = serde_json::to_vec(&event_id).map_or(0, |bytes| bytes.len());
            if ipc_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
                if removed.is_empty() && chunks.is_empty() {
                    return Err(format!(
                        "Replay removal {event_id} exceeds the {} byte compact delta budget",
                        limits.max_ipc_bytes
                    ));
                }
                break;
            }
            ipc_bytes = ipc_bytes.saturating_add(next_bytes);
            removed.push(event_id);
            through_revision = revision;
            continue;
        }
        // A lagging consumer may encounter an upsert whose event was removed
        // by a later, not-yet-consumed change. The later tombstone is the
        // authoritative final state; advance past this obsolete snapshot.
        if row
            .get::<_, Option<i64>>(0)
            .map_err(|err| err.to_string())?
            .is_none()
        {
            through_revision = revision;
            continue;
        }
        let turn_index = row.get::<_, i64>(2).map_err(|err| err.to_string())?;
        if !included_turns.contains(&turn_index) && included_turns.len() >= limits.max_turns {
            break;
        }
        let chunk = decode_indexed_chunk(row, display_session_id)?;
        let next_bytes = serialized_indexed_chunk_bytes(&chunk);
        if ipc_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            if removed.is_empty() && chunks.is_empty() {
                return Err(format!(
                    "Replay event {} exceeds the {} byte compact delta budget",
                    chunk.chunk.chunk_id, limits.max_ipc_bytes
                ));
            }
            break;
        }
        ipc_bytes = ipc_bytes.saturating_add(next_bytes);
        included_turns.insert(turn_index);
        chunks.push(chunk);
        through_revision = revision;
    }
    Ok((chunks, removed, through_revision))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn read_payload_range(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let payloads_json = conn
        .query_row(
            "SELECT payloads_json FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                generation,
                event_id
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("query replay payload locator: {err}"))?
        .ok_or_else(|| "Replay event/generation is no longer available".to_string())?;
    if let Some(range) = read_payload_artifact_range(
        conn,
        source,
        &resolved.source_session_id,
        generation,
        event_id,
        field_path,
        offset,
        max_bytes,
    )? {
        return Ok(range);
    }
    read_provider_payload_range(
        source,
        &resolved.path,
        &payloads_json,
        event_id,
        field_path,
        offset,
        max_bytes,
    )
}

#[allow(clippy::too_many_arguments)]
fn read_provider_payload_range(
    source: ImportedHistorySourceId,
    source_path: &Path,
    payloads_json: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    match replay_driver_kind(source) {
        ReplayDriverKind::CodexJsonl => codex_jsonl::read_payload(
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::SharedJsonl => jsonl_driver::read_payload(
            source,
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::Sqlite => sqlite_driver::read_payload(
            source,
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::StructuredSqlite => structured_driver::read_payload(
            source,
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::WholeJson => whole_json_driver::read_payload(
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
    }
}

/// Materialize one direct provider locator into the same immutable replay
/// artifact table used by adapters that decode payloads while indexing.
#[allow(clippy::too_many_arguments)]
pub(super) fn materialize_payload_artifact(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
) -> Result<ReplayPayloadArtifactLocator, String> {
    let resolved = resolve_source(tx, source, session_id)?;
    let payloads_json = tx
        .query_row(
            "SELECT payloads_json FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                generation,
                event_id
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("query replay payload for materialization: {error}"))?
        .ok_or_else(|| "Replay event/generation is no longer available".to_string())?;
    let descriptor = serde_json::from_str::<Vec<ReplayPayloadDescriptor>>(&payloads_json)
        .map_err(|error| format!("decode replay payload locator: {error}"))?
        .into_iter()
        .find(|descriptor| descriptor.field_path == field_path)
        .ok_or_else(|| format!("No deferred replay payload for {field_path}"))?;

    if let Some((content_hash, total_bytes)) = tx
        .query_row(
            "SELECT ref.content_hash, LENGTH(artifact.payload)
             FROM imported_replay_payload_artifact_refs AS ref
             JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=ref.source
              AND artifact.source_session_id=ref.source_session_id
              AND artifact.generation=ref.generation
              AND artifact.content_hash=ref.content_hash
             WHERE ref.source=?1 AND ref.source_session_id=?2 AND ref.generation=?3
               AND ref.event_id=?4 AND ref.field_path=?5",
            params![
                source.as_str(),
                resolved.source_session_id,
                generation,
                event_id,
                field_path
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("locate replay payload artifact: {error}"))?
    {
        return Ok(ReplayPayloadArtifactLocator {
            source_id: source.as_str().to_string(),
            source_session_id: resolved.source_session_id,
            generation: generation.to_string(),
            content_hash,
            total_bytes: total_bytes.max(0) as u64,
        });
    }
    if descriptor.source_key.is_none() && descriptor.spans.is_empty() {
        return Err(format!(
            "Replay payload artifact for {event_id}/{field_path} is missing and has no direct provider locator"
        ));
    }

    let total_bytes = descriptor.total_bytes;
    let content_hash = payload_artifact::store_streamed(
        tx,
        source,
        &resolved.source_session_id,
        generation,
        event_id,
        field_path,
        total_bytes,
        |writer| {
            let mut offset = 0_u64;
            while offset < total_bytes {
                let range = read_provider_payload_range(
                    source,
                    &resolved.path,
                    &payloads_json,
                    event_id,
                    field_path,
                    offset,
                    HARD_MAX_PAYLOAD_RANGE_BYTES,
                )?;
                if range.offset != offset || range.next_offset <= offset {
                    return Err(format!(
                        "Replay payload materialization made no exact progress at byte {offset}: returned {}..{}",
                        range.offset, range.next_offset
                    ));
                }
                if range.total_bytes != total_bytes {
                    return Err(format!(
                        "Replay payload changed during materialization: expected {total_bytes} bytes, found {}",
                        range.total_bytes
                    ));
                }
                writer
                    .write_all(range.text.as_bytes())
                    .map_err(|error| format!("write replay payload artifact page: {error}"))?;
                offset = range.next_offset;
            }
            Ok(())
        },
    )?;
    Ok(ReplayPayloadArtifactLocator {
        source_id: source.as_str().to_string(),
        source_session_id: resolved.source_session_id,
        generation: generation.to_string(),
        content_hash,
        total_bytes,
    })
}

#[allow(clippy::too_many_arguments)]
fn read_payload_artifact_range(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<Option<ReplayPayloadRange>, String> {
    let offset_i64 = offset.min(i64::MAX as u64) as i64;
    let read_bytes = max_bytes.saturating_add(4).min(i64::MAX as usize) as i64;
    let row = conn
        .query_row(
            "SELECT LENGTH(artifact.payload), SUBSTR(artifact.payload, ?6 + 1, ?7)
             FROM imported_replay_payload_artifact_refs AS ref
             JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=ref.source
              AND artifact.source_session_id=ref.source_session_id
              AND artifact.generation=ref.generation
              AND artifact.content_hash=ref.content_hash
             WHERE ref.source=?1 AND ref.source_session_id=?2 AND ref.generation=?3
               AND ref.event_id=?4 AND ref.field_path=?5",
            params![
                source.as_str(),
                source_session_id,
                generation,
                event_id,
                field_path,
                offset_i64,
                read_bytes
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u64,
                    row.get::<_, Vec<u8>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("read replay payload artifact: {err}"))?;
    let Some((total_bytes, bytes)) = row else {
        return Ok(None);
    };
    if offset >= total_bytes {
        return Ok(Some(ReplayPayloadRange {
            event_id: event_id.to_string(),
            field_path: field_path.to_string(),
            offset: total_bytes,
            next_offset: total_bytes,
            eof: true,
            total_bytes,
            text: String::new(),
        }));
    }
    let mut start = 0_usize;
    while start < bytes.len() && bytes[start] & 0b1100_0000 == 0b1000_0000 {
        start += 1;
    }
    let mut end = start.saturating_add(max_bytes).min(bytes.len());
    while end > start && std::str::from_utf8(&bytes[start..end]).is_err() {
        end -= 1;
    }
    // Avoid an empty, non-EOF page when the caller's byte budget is smaller
    // than the next UTF-8 scalar. The public hard cap still bounds this to at
    // most three extra bytes.
    if end == start && start < bytes.len() && max_bytes > 0 {
        end = (start + 1..=bytes.len())
            .find(|candidate| std::str::from_utf8(&bytes[start..*candidate]).is_ok())
            .unwrap_or(bytes.len());
    }
    let text = std::str::from_utf8(&bytes[start..end])
        .map_err(|err| format!("decode replay payload artifact UTF-8: {err}"))?
        .to_string();
    let actual_offset = offset.saturating_add(start as u64);
    let next_offset = actual_offset.saturating_add((end - start) as u64);
    Ok(Some(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: actual_offset,
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayDriverKind {
    CodexJsonl,
    SharedJsonl,
    Sqlite,
    StructuredSqlite,
    WholeJson,
}

/// Exhaustive storage-driver routing for every built-in source. Adding a new
/// [`ImportedHistorySourceId`] without choosing a replay driver is a compile
/// error; synchronization and range reads cannot drift onto different paths.
const fn replay_driver_kind(source: ImportedHistorySourceId) -> ReplayDriverKind {
    match source {
        ImportedHistorySourceId::CodexApp => ReplayDriverKind::CodexJsonl,
        ImportedHistorySourceId::ClaudeCode
        | ImportedHistorySourceId::WorkBuddy
        | ImportedHistorySourceId::Trae
        | ImportedHistorySourceId::Qoder
        | ImportedHistorySourceId::Omp
        | ImportedHistorySourceId::QoderCli => ReplayDriverKind::SharedJsonl,
        ImportedHistorySourceId::OpenCode
        | ImportedHistorySourceId::MimoCode
        | ImportedHistorySourceId::ZCode
        | ImportedHistorySourceId::CursorIde
        | ImportedHistorySourceId::Windsurf => ReplayDriverKind::Sqlite,
        ImportedHistorySourceId::CursorCli | ImportedHistorySourceId::Warp => {
            ReplayDriverKind::StructuredSqlite
        }
        ImportedHistorySourceId::Cline => ReplayDriverKind::WholeJson,
    }
}

fn is_shared_jsonl(source: ImportedHistorySourceId) -> bool {
    replay_driver_kind(source) == ReplayDriverKind::SharedJsonl
}

fn is_sqlite_replay(source: ImportedHistorySourceId) -> bool {
    replay_driver_kind(source) == ReplayDriverKind::Sqlite
}

fn is_structured_sqlite(source: ImportedHistorySourceId) -> bool {
    replay_driver_kind(source) == ReplayDriverKind::StructuredSqlite
}

fn is_physical_sqlite(source: ImportedHistorySourceId) -> bool {
    is_sqlite_replay(source) || is_structured_sqlite(source)
}

pub(super) fn resolve_source(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
) -> Result<ResolvedSource, String> {
    let requested_key = source.source_session_id(session_id)?;
    conn.query_row(
        "SELECT source_session_id, source_path
         FROM imported_history_session_cache
         WHERE source=?1
           AND (source_session_id=?2 OR source_session_id LIKE '%-' || ?2)
         ORDER BY CASE WHEN source_session_id=?2 THEN 0 ELSE 1 END,
                  updated_at_ms DESC
         LIMIT 1",
        params![source.as_str(), requested_key],
        |row| {
            Ok(ResolvedSource {
                source_session_id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
            })
        },
    )
    .optional()
    .map_err(|err| format!("resolve replay source path: {err}"))?
    .ok_or_else(|| {
        format!(
            "Imported replay source is not indexed yet: {} {session_id}",
            source.as_str()
        )
    })
}

pub(super) fn load_state(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
) -> Result<Option<ReplayIndexState>, String> {
    conn.query_row(
        "SELECT source_session_id, generation, revision, parser_version,
                source_identity, driver_cursor_json, indexed_size_bytes,
                indexed_mtime_ns, total_events, total_turns, updated_at
         FROM imported_replay_state
         WHERE source=?1 AND source_session_id=?2 AND valid=1",
        params![source.as_str(), source_session_id],
        |row| {
            Ok(ReplayIndexState {
                generation: row.get(1)?,
                revision: row.get::<_, i64>(2)?.max(0) as u64,
                parser_version: row.get::<_, i64>(3)?.max(0) as u32,
                source_identity: row.get(4)?,
                driver_cursor_json: row.get(5)?,
                indexed_size_bytes: row.get::<_, i64>(6)?.max(0) as u64,
                indexed_mtime_ns: row.get(7)?,
                total_events: row.get::<_, i64>(8)?.max(0) as u64,
                total_turns: row.get::<_, i64>(9)?.max(0) as u64,
                state_updated_at_ms: row
                    .get::<_, String>(10)?
                    .parse::<chrono::DateTime<Utc>>()
                    .map(|timestamp| timestamp.timestamp_millis())
                    .unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(|err| format!("load imported replay state: {err}"))
}

fn source_snapshot(path: &Path, source: ImportedHistorySourceId) -> Result<SourceSnapshot, String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("stat replay source {}: {err}", path.display()))?;
    let mut size_bytes = metadata.len();
    let mut mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64)
        .unwrap_or_default();
    if is_physical_sqlite(source) {
        // WAL contains committed logical changes. SHM is a transient lock and
        // reader coordination file; including it makes our own SQLite reads
        // look like source mutations and self-trigger replay scans.
        let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        if let Ok(wal_metadata) = fs::metadata(wal) {
            size_bytes = size_bytes.saturating_add(wal_metadata.len());
            let wal_mtime = wal_metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| {
                    duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64
                })
                .unwrap_or_default();
            mtime_ns = mtime_ns.max(wal_mtime);
        }
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}",
            canonical.display(),
            metadata.dev(),
            metadata.ino()
        )
    };
    #[cfg(not(unix))]
    let identity = canonical.to_string_lossy().to_string();
    Ok(SourceSnapshot {
        identity,
        size_bytes,
        mtime_ns,
        sample_fingerprint: String::new(),
    })
}

fn sqlite_physical_fingerprint(path: &Path) -> Result<String, String> {
    let mut hash = Fnv64::default();
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.to_string_lossy())),
    ] {
        hash.update(candidate.to_string_lossy().as_bytes());
        match fs::metadata(&candidate) {
            Ok(metadata) => {
                hash.update(&metadata.len().to_le_bytes());
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| {
                        duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64
                    })
                    .unwrap_or_default();
                hash.update(&modified.to_le_bytes());
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => hash.update(b"missing"),
            Err(err) => {
                return Err(format!(
                    "stat replay SQLite sidecar {}: {err}",
                    candidate.display()
                ))
            }
        }
    }
    Ok(hash.finish_hex())
}

fn sampled_file_fingerprint(path: &Path, size: u64) -> Result<String, String> {
    #[cfg(test)]
    FILE_SAMPLE_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    const SAMPLE: usize = 4096;
    let mut file = fs::File::open(path)
        .map_err(|err| format!("open replay source sample {}: {err}", path.display()))?;
    let mut hash = Fnv64::default();
    hash.update(&size.to_le_bytes());
    for offset in [
        0,
        size.saturating_sub(SAMPLE as u64) / 2,
        size.saturating_sub(SAMPLE as u64),
    ] {
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| format!("seek replay source sample: {err}"))?;
        let mut buffer = vec![0_u8; SAMPLE.min(size.saturating_sub(offset) as usize)];
        file.read_exact(&mut buffer)
            .map_err(|err| format!("read replay source sample: {err}"))?;
        hash.update(&offset.to_le_bytes());
        hash.update(&buffer);
    }
    Ok(hash.finish_hex())
}

#[cfg(test)]
std::thread_local! {
    static FILE_SAMPLE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn take_file_sample_count() -> usize {
    FILE_SAMPLE_COUNT.with(|count| count.replace(0))
}

fn make_generation(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    parser_version: u32,
    snapshot: &SourceSnapshot,
) -> String {
    let mut hash = Fnv64::default();
    hash.update(source.as_str().as_bytes());
    hash.update(source_session_id.as_bytes());
    hash.update(&parser_version.to_le_bytes());
    hash.update(snapshot.identity.as_bytes());
    hash.update(&snapshot.size_bytes.to_le_bytes());
    hash.update(&snapshot.mtime_ns.to_le_bytes());
    hash.update(snapshot.sample_fingerprint.as_bytes());
    format!("r{parser_version}-{}", hash.finish_hex())
}

#[derive(Clone, Copy)]
enum QueryDirection {
    NewestFirst,
    OldestFirst,
}

#[allow(clippy::too_many_arguments)]
fn read_chunks(
    conn: &Connection,
    source: ImportedHistorySourceId,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    predicate: &str,
    extra_values: &[i64],
    limits: ReplayLimits,
    direction: QueryDirection,
) -> Result<Vec<ReplayIndexedChunk>, String> {
    let order = match direction {
        QueryDirection::NewestFirst => "DESC",
        QueryDirection::OldestFirst => "ASC",
    };
    let sql = format!(
        "SELECT sequence, event_id, turn_index, action_type, function_name,
                created_at, args_preview_json, result_preview_json,
                thread_id, process_id, payloads_json
         FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND {predicate}
         ORDER BY sequence {order} LIMIT {}",
        limits.max_events
    );
    let mut values = vec![
        rusqlite::types::Value::Text(source.as_str().to_string()),
        rusqlite::types::Value::Text(source_session_id.to_string()),
        rusqlite::types::Value::Text(generation.to_string()),
    ];
    values.extend(
        extra_values
            .iter()
            .copied()
            .map(rusqlite::types::Value::Integer),
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("prepare bounded replay query: {err}"))?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(values))
        .map_err(|err| format!("query bounded replay rows: {err}"))?;
    let mut chunks = Vec::new();
    let mut ipc_bytes = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read bounded replay row: {err}"))?
    {
        let chunk = decode_indexed_chunk(row, display_session_id)?;
        let next_bytes = serialized_indexed_chunk_bytes(&chunk);
        if ipc_bytes.saturating_add(next_bytes) > limits.max_ipc_bytes {
            if chunks.is_empty() {
                return Err(format!(
                    "Replay event {} exceeds the {} byte compact window budget",
                    chunk.chunk.chunk_id, limits.max_ipc_bytes
                ));
            }
            break;
        }
        ipc_bytes = ipc_bytes.saturating_add(next_bytes);
        chunks.push(chunk);
    }
    Ok(chunks)
}

fn decode_indexed_chunk(
    row: &Row<'_>,
    display_session_id: &str,
) -> Result<ReplayIndexedChunk, String> {
    let args_json: String = row.get(6).map_err(|err| err.to_string())?;
    let result_json: String = row.get(7).map_err(|err| err.to_string())?;
    let payloads_json: String = row.get(10).map_err(|err| err.to_string())?;
    Ok(ReplayIndexedChunk {
        sequence: row.get(0).map_err(|err| err.to_string())?,
        turn_index: row.get(2).map_err(|err| err.to_string())?,
        chunk: ActivityChunk {
            chunk_id: row.get(1).map_err(|err| err.to_string())?,
            session_id: display_session_id.to_string(),
            action_type: row.get(3).map_err(|err| err.to_string())?,
            function: row.get(4).map_err(|err| err.to_string())?,
            args: serde_json::from_str(&args_json)
                .map_err(|err| format!("decode replay args preview: {err}"))?,
            result: serde_json::from_str(&result_json)
                .map_err(|err| format!("decode replay result preview: {err}"))?,
            created_at: row.get(5).map_err(|err| err.to_string())?,
            thread_id: row.get(8).map_err(|err| err.to_string())?,
            process_id: row.get(9).map_err(|err| err.to_string())?,
            broadcast_only: false,
        },
        payloads: serde_json::from_str::<Vec<ReplayPayloadDescriptor>>(&payloads_json)
            .map_err(|err| format!("decode replay payload locators: {err}"))?,
    })
}

fn read_turn_headers(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    oldest_turn: i64,
    newest_turn: i64,
) -> Result<Vec<ReplayTurnHeader>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT turn_id, turn_index, start_sequence, end_sequence,
                    started_at, ended_at, event_count
             FROM imported_replay_turns
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND turn_index BETWEEN ?4 AND ?5
             ORDER BY turn_index ASC",
        )
        .map_err(|err| format!("prepare replay turn headers: {err}"))?;
    let rows = stmt
        .query_map(
            params![
                source.as_str(),
                source_session_id,
                generation,
                oldest_turn,
                newest_turn
            ],
            |row| {
                Ok(ReplayTurnHeader {
                    turn_id: row.get(0)?,
                    turn_index: row.get(1)?,
                    start_sequence: row.get(2)?,
                    end_sequence: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    event_count: row.get::<_, i64>(6)?.max(0) as u64,
                })
            },
        )
        .map_err(|err| format!("query replay turn headers: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read replay turn header: {err}"))
}

fn serialized_indexed_chunk_bytes(chunk: &ReplayIndexedChunk) -> usize {
    // Payload descriptors cross the Rust/JS boundary after normalization too;
    // omitting them here let descriptor-heavy events bypass maxIpcBytes.
    serde_json::to_vec(&chunk.chunk)
        .map_or(0, |bytes| bytes.len())
        .saturating_add(serde_json::to_vec(&chunk.payloads).map_or(0, |bytes| bytes.len()))
}

#[derive(Default)]
struct Fnv64(u64);

impl Fnv64 {
    fn update(&mut self, bytes: &[u8]) {
        if self.0 == 0 {
            self.0 = 0xcbf29ce484222325;
        }
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish_hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_source_has_one_matching_exhaustive_storage_driver() {
        use super::super::ReplayStorageFamily;

        for source in ImportedHistorySourceId::ALL {
            let family = source.descriptor().storage_family;
            let compatible = match replay_driver_kind(source) {
                ReplayDriverKind::CodexJsonl | ReplayDriverKind::SharedJsonl => {
                    family == ReplayStorageFamily::JsonLines
                }
                ReplayDriverKind::Sqlite => matches!(
                    family,
                    ReplayStorageFamily::SqliteWal | ReplayStorageFamily::SqliteKeyValue
                ),
                ReplayDriverKind::StructuredSqlite => matches!(
                    family,
                    ReplayStorageFamily::SqliteManifestBlob | ReplayStorageFamily::SqliteTaskBlob
                ),
                ReplayDriverKind::WholeJson => family == ReplayStorageFamily::WholeJson,
            };
            assert!(
                compatible,
                "{} declares {family:?} but routes through {:?}",
                source.as_str(),
                replay_driver_kind(source)
            );
        }
    }

    fn replay_schema() -> Connection {
        use crate::store::sqlite::SqliteRecordStore;

        let conn = Connection::open_in_memory().expect("replay schema");
        SqliteRecordStore::init_tables(&conn).expect("initialize replay schema");
        SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("initialize replay source-cache schema");
        conn
    }

    #[test]
    fn cursor_cli_lineage_rejection_watermark_matches_only_the_same_snapshot() {
        let mut conn = replay_schema();
        let source = ImportedHistorySourceId::CursorCli;
        let parser_version = source.descriptor().parser_version;
        let snapshot = SourceSnapshot {
            identity: "/tmp/cursor-state.vscdb:1:2".to_string(),
            size_bytes: 42_000,
            mtime_ns: 1_700_000_000_000_000_000,
            sample_fingerprint: "db-and-wal-sample-a".to_string(),
        };
        conn.execute(
            "INSERT INTO imported_replay_state(
                 source,source_session_id,generation,revision,parser_version,
                 source_identity,driver_cursor_json,indexed_size_bytes,
                 indexed_mtime_ns,total_events,total_turns,valid,updated_at
             ) VALUES('cursor_cli','cursor-1','valid-generation',7,?1,
                      'old-identity','{}',10,20,3,1,1,?2)",
            params![i64::from(parser_version), Utc::now().to_rfc3339()],
        )
        .expect("seed last valid Cursor CLI generation");

        record_rejected_snapshot(
            &mut conn,
            source,
            "cursor-1",
            parser_version,
            &snapshot,
            RejectedSnapshotKind::CursorCliLineageChanged,
        )
        .expect("record Cursor CLI lineage rejection");

        for _ in 0..20 {
            assert!(rejected_snapshot_matches(
                &conn,
                source,
                "cursor-1",
                parser_version,
                &snapshot,
                RejectedSnapshotKind::CursorCliLineageChanged,
            )
            .expect("match unchanged Cursor CLI rejected snapshot"));
        }
        let valid = load_state(&conn, source, "cursor-1")
            .expect("load last valid Cursor CLI state")
            .expect("last valid Cursor CLI state remains visible");
        assert_eq!(valid.generation, "valid-generation");
        assert_eq!(valid.revision, 7);

        let mut changed = snapshot.clone();
        changed.sample_fingerprint = "db-and-wal-sample-b".to_string();
        assert!(!rejected_snapshot_matches(
            &conn,
            source,
            "cursor-1",
            parser_version,
            &changed,
            RejectedSnapshotKind::CursorCliLineageChanged,
        )
        .expect("changed Cursor CLI snapshot is retryable"));

        let tx = conn
            .transaction()
            .expect("start successful Cursor CLI publish transaction");
        clear_rejected_snapshot(&tx, source, "cursor-1")
            .expect("clear successful Cursor CLI rejection");
        tx.commit()
            .expect("commit successful Cursor CLI rejection clear");
        assert!(!rejected_snapshot_matches(
            &conn,
            source,
            "cursor-1",
            parser_version,
            &snapshot,
            RejectedSnapshotKind::CursorCliLineageChanged,
        )
        .expect("cleared Cursor CLI snapshot is retryable"));
    }

    #[test]
    fn fingerprint_reads_a_bounded_sample() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "orgii-replay-fingerprint-{}.jsonl",
            std::process::id()
        ));
        std::fs::write(&path, vec![b'x'; 32 * 1024]).expect("fixture");
        let first = sampled_file_fingerprint(&path, 32 * 1024).expect("fingerprint");
        let mut bytes = std::fs::read(&path).expect("read fixture");
        bytes[16 * 1024] = b'y';
        std::fs::write(&path, bytes).expect("rewrite fixture");
        let second = sampled_file_fingerprint(&path, 32 * 1024).expect("fingerprint");
        let _ = std::fs::remove_file(path);
        assert_ne!(first, second);
    }

    #[test]
    fn sqlite_logical_snapshot_ignores_shm_but_tracks_wal() {
        let path = std::env::temp_dir().join(format!(
            "orgii-replay-sqlite-snapshot-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        let shm = PathBuf::from(format!("{}-shm", path.to_string_lossy()));
        std::fs::write(&path, b"database").expect("main fixture");
        std::fs::write(&wal, b"committed-wal").expect("WAL fixture");
        std::fs::write(&shm, b"reader-lock-a").expect("SHM fixture");

        let before = source_snapshot(&path, ImportedHistorySourceId::OpenCode)
            .expect("snapshot before SHM churn");
        let before_fingerprint =
            sqlite_physical_fingerprint(&path).expect("fingerprint before SHM churn");
        std::fs::write(&shm, b"reader-lock-b-with-different-size")
            .expect("simulate SHM lock churn");
        let after_shm = source_snapshot(&path, ImportedHistorySourceId::OpenCode)
            .expect("snapshot after SHM churn");
        let after_shm_fingerprint =
            sqlite_physical_fingerprint(&path).expect("fingerprint after SHM churn");
        assert_eq!(before.identity, after_shm.identity);
        assert_eq!(before.size_bytes, after_shm.size_bytes);
        assert_eq!(before.mtime_ns, after_shm.mtime_ns);
        assert_eq!(before_fingerprint, after_shm_fingerprint);

        std::fs::write(&wal, b"committed-wal-with-new-logical-row")
            .expect("simulate committed WAL change");
        let after_wal = source_snapshot(&path, ImportedHistorySourceId::OpenCode)
            .expect("snapshot after WAL change");
        let after_wal_fingerprint =
            sqlite_physical_fingerprint(&path).expect("fingerprint after WAL change");
        assert_ne!(after_shm.size_bytes, after_wal.size_bytes);
        assert_ne!(after_shm_fingerprint, after_wal_fingerprint);

        let _ = std::fs::remove_file(shm);
        let _ = std::fs::remove_file(wal);
        let _ = std::fs::remove_file(path);
    }
}
