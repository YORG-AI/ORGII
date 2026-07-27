//! Delta-sync pipeline: discover changed conversations from Cursor's index and
//! materialize the changed few into normalized cache rows.

#[cfg(test)]
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::sources::imported_history::{
    cache as source_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_CURSOR_IDE},
};

use super::*;

pub(super) const CURSOR_STORAGE_MISSING_IDENTITY: &str = "state-vscdb:missing";
pub(super) const NO_INDEX_DATABASE_IDENTITY_FIELD: &str = "noIndexDatabaseIdentity";
pub(super) const NO_INDEX_ACTIVITY_SIGNATURE_FIELD: &str = "noIndexActivitySignature";
pub(super) const INDEX_BLOB_VALIDATION_FIELD: &str = "indexBlobValidation";
pub(super) const NO_INDEX_VALIDATION_BATCH_SIZE: usize = 64;

#[cfg(test)]
thread_local! {
    static CURSOR_CONTENT_PROBE_COUNT: Cell<usize> = const { Cell::new(0) };
    static CURSOR_CONTENT_PROBED_IDS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub(super) fn reset_cursor_content_probe_count() {
    CURSOR_CONTENT_PROBE_COUNT.set(0);
    CURSOR_CONTENT_PROBED_IDS.with(|ids| ids.borrow_mut().clear());
}

#[cfg(test)]
pub(super) fn cursor_content_probe_count() -> usize {
    CURSOR_CONTENT_PROBE_COUNT.get()
}

#[cfg(test)]
pub(super) fn cursor_content_probed_ids() -> Vec<String> {
    CURSOR_CONTENT_PROBED_IDS.with(|ids| ids.borrow().clone())
}

enum CursorComposerLoad {
    Present(Box<RawComposerData>),
    Missing,
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CursorStorageSnapshot {
    pub(super) database_identity: String,
    pub(super) activity_signature: String,
}

/// Refresh the Cursor metadata cache from `conversation-search.db`.
///
/// A cheap indexed read yields per-session change signatures (`updated_at` +
/// `root_fingerprint`) without parsing any conversation blob, so only
/// genuinely-changed sessions are re-read — the same incremental model the
/// file-based sources use, and no per-restart scan of the multi-GB `state.vscdb`.
///
/// Older Cursor builds do not have the optional conversation index. In that
/// case we do not discover by scanning `state.vscdb`; we only point-check
/// already-cached rows that need the current listability migration.
pub(super) fn delta_sync(cache_conn: &mut Connection) -> Result<(), String> {
    let cursor_path = match cursor_db_path_state() {
        CursorDbPathState::Present(path) => path,
        CursorDbPathState::Missing => {
            return demote_definitively_missing_cursor_database(cache_conn)
        }
        CursorDbPathState::Unknown => return Ok(()),
    };
    let storage_snapshot = match cursor_storage_snapshot(&cursor_path) {
        Ok(snapshot) => snapshot,
        // Metadata/TCC failures are indeterminate. Do not hide or stamp
        // anything on evidence we could not read.
        Err(_) => return Ok(()),
    };
    let Some(cursor_conn) = open_cursor_db() else {
        // An existing path that cannot be opened is indeterminate (TCC,
        // SQLITE_BUSY, permissions, or a replacement in progress). Keep the
        // last known projection and leave validation markers untouched.
        return Ok(());
    };
    let index_conn = match open_cursor_conversation_index_db_state() {
        CursorConversationIndexDbState::Present(connection) => Some(connection),
        CursorConversationIndexDbState::Missing => None,
        CursorConversationIndexDbState::Unknown => return Ok(()),
    };
    let source_path = cursor_path.to_string_lossy().to_string();
    delta_sync_from_connections(
        cache_conn,
        index_conn.as_ref(),
        Some(&cursor_conn),
        &source_path,
        Some(&storage_snapshot),
    )
}

pub(super) fn delta_sync_from_connections(
    cache_conn: &mut Connection,
    index_conn: Option<&Connection>,
    cursor_conn: Option<&Connection>,
    source_path: &str,
    storage_snapshot: Option<&CursorStorageSnapshot>,
) -> Result<(), String> {
    // `Missing` is handled by `delta_sync` before this helper. `None` here
    // therefore means the source exists but its read-only connection could
    // not be established, which is not evidence that any cached row vanished.
    if cursor_conn.is_none() {
        return Ok(());
    }
    let Some(index_conn) = index_conn else {
        return repair_cached_listability_without_index(cache_conn, cursor_conn, storage_snapshot);
    };
    let discovered = match discover_from_index(index_conn) {
        Ok(discovered) => discovered,
        // A transiently unreadable/foreign optional index is not authoritative
        // evidence that Cursor deleted every session. It is also not the same
        // as a definitively absent optional index, so do not silently fall back
        // to a different discovery mode or stamp validation success.
        Err(_) => return Ok(()),
    };

    let signatures = discovered
        .iter()
        .map(|row| row.signature(source_path))
        .collect::<Vec<_>>();
    let live_parent_ids = source_cache::live_ids_from_signatures(&signatures);
    let live_parent_id_set = live_parent_ids.iter().cloned().collect::<HashSet<_>>();
    let cached_child_ids_by_parent = cached_cursor_child_ids_by_parent(cache_conn)?;
    let changed = source_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_CURSOR_IDE,
        &discovered,
        |row| row.signature(source_path),
    )?;
    let changed_parent_ids = changed
        .iter()
        .map(|row| row.id.clone())
        .collect::<HashSet<_>>();
    let cached_blob_states = cached_cursor_index_blob_states(cache_conn)?;
    let mut authoritative_changed_parent_ids = HashSet::new();
    let mut live_ids = live_parent_ids;
    let mut inputs = Vec::new();

    for row in &discovered {
        let index_signature = index_blob_validation_signature(row, source_path);
        let missing_signature = missing_index_blob_validation_signature(
            &index_signature,
            storage_snapshot.map(|snapshot| snapshot.activity_signature.as_str()),
        );
        let cached_blob_state = cached_blob_states.get(&row.id);
        let database_identity = storage_snapshot
            .map(|snapshot| snapshot.database_identity.as_str())
            .unwrap_or_default();
        if cached_blob_state
            .is_some_and(|state| state.validated_missing(&missing_signature, database_identity))
        {
            // The index and physical state DB are unchanged since this shell
            // was hidden. Do not point-read the same missing blob again.
            continue;
        }
        let changed = changed_parent_ids.contains(&row.id);
        if !changed
            && cached_blob_state
                .is_some_and(|state| state.validated_present(&index_signature, database_identity))
        {
            continue;
        }
        let mut built = build_inputs_from_index(cursor_conn, row, source_path)?;
        match built.composer_availability {
            CursorComposerAvailability::Available => {}
            CursorComposerAvailability::MissingOrMalformed => {
                if let Some(state) = cached_blob_state {
                    stamp_cursor_index_blob_validation(
                        cache_conn,
                        &row.id,
                        &state.source_metadata_json,
                        &CursorIndexBlobValidation {
                            signature: missing_signature,
                            // Reaching this branch means the index, state DB,
                            // and point-read all succeeded, but the referenced
                            // composer is definitively absent or malformed.
                            // Keep the compact terminal marker so an unchanged
                            // refresh performs zero content reads; physical DB
                            // activity changes the signature and retries.
                            misses: 2,
                            database_identity: storage_snapshot
                                .map(|snapshot| snapshot.database_identity.clone())
                                .unwrap_or_default(),
                        },
                        true,
                    )?;
                } else {
                    // A newly indexed row whose blob is already absent would
                    // otherwise be re-probed forever because no cache
                    // signature exists. Persist one compact, non-listable
                    // tombstone; an index or physical-activity change makes it
                    // retryable, while an unchanged refresh performs zero
                    // content reads.
                    built.inputs.push(index_missing_tombstone(
                        row,
                        source_path,
                        &CursorIndexBlobValidation {
                            signature: missing_signature,
                            misses: 2,
                            database_identity: database_identity.to_string(),
                        },
                    ));
                }
            }
            CursorComposerAvailability::TemporarilyUnavailable => {}
        }
        if built.composer_availability == CursorComposerAvailability::Available {
            if let Some(root_input) = built.inputs.first_mut() {
                attach_cursor_index_blob_validation(
                    root_input,
                    &CursorIndexBlobValidation {
                        signature: index_signature,
                        misses: 0,
                        database_identity: storage_snapshot
                            .map(|snapshot| snapshot.database_identity.clone())
                            .unwrap_or_default(),
                    },
                );
            }
        }
        if built.child_list_authoritative {
            authoritative_changed_parent_ids.insert(row.id.clone());
        }
        live_ids.extend(built.live_child_ids);
        inputs.extend(built.inputs);
    }

    // Unchanged parents retain their cached children without touching the large
    // composer blobs. If a changed parent's blob was temporarily unavailable,
    // retain its previous children too instead of pruning good cache rows.
    for (parent_id, child_ids) in cached_child_ids_by_parent {
        if !live_parent_id_set.contains(&parent_id) {
            continue;
        }
        let changed_with_authoritative_children = changed_parent_ids.contains(&parent_id)
            && authoritative_changed_parent_ids.contains(&parent_id);
        if !changed_with_authoritative_children {
            live_ids.extend(child_ids);
        }
    }

    source_cache::sync_source_cache_from_conn(cache_conn, SOURCE_CURSOR_IDE, live_ids, inputs)?;
    Ok(())
}

#[derive(Debug)]
struct CachedCursorIndexBlobState {
    source_metadata_json: String,
    validation: Option<CursorIndexBlobValidation>,
}

fn index_blob_validation_signature(row: &CursorIndexRow, source_path: &str) -> String {
    let signature = row.signature(source_path);
    serde_json::json!([
        signature.source_mtime_ms,
        signature.source_size_bytes,
        signature.source_fingerprint,
        signature.parser_version
    ])
    .to_string()
}

fn missing_index_blob_validation_signature(
    index_signature: &str,
    storage_signature: Option<&str>,
) -> String {
    serde_json::json!([index_signature, storage_signature.unwrap_or_default()]).to_string()
}

impl CachedCursorIndexBlobState {
    fn validated_present(&self, index_signature: &str, database_identity: &str) -> bool {
        self.validation.as_ref().is_some_and(|validation| {
            validation.misses == 0
                && validation.signature == index_signature
                && validation.database_identity == database_identity
        })
    }

    fn validated_missing(&self, missing_signature: &str, database_identity: &str) -> bool {
        self.validation.as_ref().is_some_and(|validation| {
            validation.misses >= 2
                && validation.signature == missing_signature
                && validation.database_identity == database_identity
        })
    }
}

fn index_missing_tombstone(
    row: &CursorIndexRow,
    source_path: &str,
    validation: &CursorIndexBlobValidation,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: row.id.clone(),
        session_id: canonical_session_id(&row.id),
        source_path: source_path.to_string(),
        source_record_key: format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{}", row.id),
        source_mtime_ms: row.updated_at_ms,
        source_size_bytes: row.is_archived as i64,
        source_fingerprint: row.root_fingerprint.clone(),
        parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        name: preferred_cursor_title(&row.id, "", &row.title, None),
        created_at_ms: row.updated_at_ms,
        updated_at_ms: row.updated_at_ms,
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: None,
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: false,
        source_metadata_json: Some(merged_cursor_validation_metadata(
            "",
            None,
            Some(validation),
        )),
        parent_session_id: None,
    }
}

fn cached_cursor_index_blob_states(
    cache_conn: &Connection,
) -> Result<HashMap<String, CachedCursorIndexBlobState>, String> {
    let mut statement = cache_conn
        .prepare(
            "SELECT source_session_id,source_metadata_json
             FROM imported_history_session_cache
             WHERE source=?1 AND COALESCE(parent_session_id, '')=''",
        )
        .map_err(|err| format!("Failed to prepare Cursor index-blob state query: {err}"))?;
    let rows = statement
        .query_map([SOURCE_CURSOR_IDE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("Failed to query Cursor index-blob states: {err}"))?;
    let mut states = HashMap::new();
    for row in rows {
        let (source_session_id, source_metadata_json) =
            row.map_err(|err| format!("Failed to read Cursor index-blob state: {err}"))?;
        let validation = serde_json::from_str::<serde_json::Value>(&source_metadata_json)
            .ok()
            .and_then(|value| value.get(INDEX_BLOB_VALIDATION_FIELD).cloned())
            .and_then(|value| serde_json::from_value::<CursorIndexBlobValidation>(value).ok());
        states.insert(
            source_session_id,
            CachedCursorIndexBlobState {
                source_metadata_json,
                validation,
            },
        );
    }
    Ok(states)
}

fn attach_cursor_index_blob_validation(
    input: &mut ImportedHistoryCacheInput,
    validation: &CursorIndexBlobValidation,
) {
    input.source_metadata_json = Some(merged_cursor_validation_metadata(
        input.source_metadata_json.as_deref().unwrap_or_default(),
        None,
        Some(validation),
    ));
}

fn stamp_cursor_index_blob_validation(
    cache_conn: &Connection,
    source_session_id: &str,
    source_metadata_json: &str,
    validation: &CursorIndexBlobValidation,
    hide: bool,
) -> Result<(), String> {
    let metadata = merged_cursor_validation_metadata(source_metadata_json, None, Some(validation));
    cache_conn
        .execute(
            "UPDATE imported_history_session_cache
             SET source_metadata_json=?3,
                 listable=CASE WHEN ?4 != 0 THEN 0 ELSE listable END,
                 updated_at=?5
             WHERE source=?1 AND source_session_id=?2
               AND COALESCE(parent_session_id, '')=''",
            params![
                SOURCE_CURSOR_IDE,
                source_session_id,
                metadata,
                i64::from(hide),
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to stamp Cursor index-blob validation: {err}"))
}

#[derive(Debug)]
struct CachedCursorParent {
    source_session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    source_metadata_json: String,
}

/// Split stable replacement identity from normal SQLite activity.
///
/// The main file's device/inode pair changes when Cursor replaces its state
/// database, while main/WAL mtime+size changes during ordinary writes. SHM is
/// excluded because our own reads can modify it.
fn cursor_storage_snapshot(path: &Path) -> Result<CursorStorageSnapshot, String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("Failed to read Cursor state database metadata: {err}"))?;
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(unix)]
    let database_identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}",
            canonical.display(),
            metadata.dev(),
            metadata.ino()
        )
    };
    #[cfg(not(unix))]
    let database_identity = {
        // Windows does not expose Unix device/inode metadata through the
        // portable API, but file creation time is stable across normal SQLite
        // writes and changes when the database file is replaced.
        let created_ns = metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        format!("{}:{created_ns}", canonical.display())
    };
    let main_mtime_ns = metadata_mtime_ns(&metadata);
    let wal_path = std::path::PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    let wal_signature = match fs::metadata(wal_path) {
        Ok(wal) => format!("wal:{}:{}", wal.len(), metadata_mtime_ns(&wal)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => "wal:-".to_string(),
        Err(err) => {
            return Err(format!(
                "Failed to read Cursor WAL metadata for activity watermark: {err}"
            ))
        }
    };
    Ok(CursorStorageSnapshot {
        database_identity,
        activity_signature: format!("main:{}:{main_mtime_ns}|{wal_signature}", metadata.len()),
    })
}

fn metadata_mtime_ns(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as i64)
        .unwrap_or_default()
}

/// Migrate only known cached roots when Cursor has no conversation index.
///
/// This intentionally does not enumerate `composerData:%`: that table can be
/// multi-GB. Each candidate performs one composer primary-key lookup plus
/// exact lookups for declared headers and one indexed range over that
/// composer's bubbles. A missing/malformed composer is definitive for the
/// current physical DB generation: preserve its cached metadata, hide it, and
/// stamp that generation so unchanged refreshes perform zero repeated probes.
/// Query errors remain indeterminate and are retried one bounded point-read on
/// a later refresh.
fn repair_cached_listability_without_index(
    cache_conn: &mut Connection,
    cursor_conn: Option<&Connection>,
    storage_snapshot: Option<&CursorStorageSnapshot>,
) -> Result<(), String> {
    let Some(storage_snapshot) = storage_snapshot else {
        return Ok(());
    };
    let Some(cursor_conn) = cursor_conn else {
        // The path exists but a read-only connection could not be opened
        // (typically a transient lock). Preserve the last known projection and
        // do not stamp success, so the next refresh gets one bounded retry.
        return Ok(());
    };
    queue_legacy_no_index_validation(cache_conn)?;
    demote_no_index_rows_from_replaced_database(cache_conn, storage_snapshot)?;
    let cached = cached_cursor_parents_needing_validation(cache_conn, storage_snapshot)?;
    for cached in cached {
        let raw = match load_composer_raw(cursor_conn, &cached.source_session_id) {
            Ok(CursorComposerLoad::Present(raw)) => raw,
            Ok(CursorComposerLoad::Missing | CursorComposerLoad::Malformed) => {
                demote_cached_cursor_parent(cache_conn, &cached, storage_snapshot)?;
                continue;
            }
            Err(_) => {
                rotate_indeterminate_validation_candidate(cache_conn, &cached.source_session_id)?;
                continue;
            }
        };
        let user_bubbles =
            match probe_replayable_user_bubbles(cursor_conn, &cached.source_session_id, &raw) {
                Ok(value) => value,
                Err(_) => {
                    rotate_indeterminate_validation_candidate(
                        cache_conn,
                        &cached.source_session_id,
                    )?;
                    continue;
                }
            };
        let Ok(mut input) = cache_input_from_raw(
            cursor_conn,
            &cached.source_session_id,
            &cached.source_path,
            &cached.source_record_key,
            cached.source_mtime_ms,
            cached.source_size_bytes,
            &cached.source_fingerprint,
            &raw,
            None,
            Some(storage_snapshot),
        ) else {
            rotate_indeterminate_validation_candidate(cache_conn, &cached.source_session_id)?;
            continue;
        };
        input.created_at_ms = if input.created_at_ms > 0 {
            input.created_at_ms
        } else {
            cached.created_at_ms
        };
        input.updated_at_ms = input.updated_at_ms.max(cached.updated_at_ms);
        input.name = preferred_cursor_title(
            &cached.source_session_id,
            &raw.name,
            &cached.name,
            user_bubbles.first_user_preview.as_deref(),
        );
        input.listable = user_bubbles.has_user_bubble;
        source_cache::upsert_imported_session_cache_from_conn(
            cache_conn,
            std::slice::from_ref(&input),
        )?;
    }
    Ok(())
}

/// Move an indeterminate point-read to the back of the bounded retry queue.
///
/// This updates only cache-maintenance bookkeeping, not parser/listability
/// state or a validation-success watermark. Without it, 64 consistently
/// unreadable rows could occupy every batch and starve all later hidden rows.
fn rotate_indeterminate_validation_candidate(
    cache_conn: &Connection,
    source_session_id: &str,
) -> Result<(), String> {
    cache_conn
        .execute(
            "UPDATE imported_history_session_cache
             SET updated_at=?3
             WHERE source=?1 AND source_session_id=?2
               AND COALESCE(parent_session_id, '')=''",
            params![
                SOURCE_CURSOR_IDE,
                source_session_id,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to rotate Cursor validation retry: {err}"))
}

fn demote_cached_cursor_parent(
    cache_conn: &mut Connection,
    cached: &CachedCursorParent,
    storage_snapshot: &CursorStorageSnapshot,
) -> Result<(), String> {
    let metadata = merged_cursor_validation_metadata(
        &cached.source_metadata_json,
        Some(storage_snapshot),
        None,
    );
    cache_conn
        .execute(
            "UPDATE imported_history_session_cache
             SET listable=0, parser_version=?3, source_metadata_json=?4,
                 updated_at=?5
             WHERE source=?1 AND source_session_id=?2
               AND COALESCE(parent_session_id, '')=''",
            params![
                SOURCE_CURSOR_IDE,
                cached.source_session_id,
                CURSOR_IDE_METADATA_PARSER_VERSION,
                metadata,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to hide invalid Cursor shell: {err}"))
}

fn merged_cursor_validation_metadata(
    existing: &str,
    storage_snapshot: Option<&CursorStorageSnapshot>,
    index_blob_validation: Option<&CursorIndexBlobValidation>,
) -> String {
    let mut object = serde_json::from_str::<serde_json::Value>(existing)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(snapshot) = storage_snapshot {
        object.insert(
            NO_INDEX_DATABASE_IDENTITY_FIELD.to_string(),
            serde_json::Value::String(snapshot.database_identity.clone()),
        );
        object.insert(
            NO_INDEX_ACTIVITY_SIGNATURE_FIELD.to_string(),
            serde_json::Value::String(snapshot.activity_signature.clone()),
        );
    }
    if let Some(validation) = index_blob_validation {
        object.insert(
            INDEX_BLOB_VALIDATION_FIELD.to_string(),
            serde_json::to_value(validation).unwrap_or(serde_json::Value::Null),
        );
    } else {
        object.remove(INDEX_BLOB_VALIDATION_FIELD);
    }
    serde_json::Value::Object(object).to_string()
}

fn cached_cursor_parents_needing_validation(
    cache_conn: &Connection,
    storage_snapshot: &CursorStorageSnapshot,
) -> Result<Vec<CachedCursorParent>, String> {
    let mut stmt = cache_conn
        .prepare(
            "SELECT source_session_id,source_path,source_record_key,
                    source_mtime_ms,source_size_bytes,source_fingerprint,
                    name,created_at_ms,updated_at_ms,source_metadata_json
             FROM imported_history_session_cache
             WHERE source=?1
               AND COALESCE(parent_session_id, '')=''
               AND (
                    parser_version < ?2
                    OR (
                        listable=0
                        AND (
                            CASE WHEN json_valid(source_metadata_json)
                                 THEN COALESCE(json_extract(
                                     source_metadata_json,
                                     '$.noIndexDatabaseIdentity'
                                 ), '')
                                 ELSE '' END != ?3
                            OR CASE WHEN json_valid(source_metadata_json)
                                    THEN COALESCE(json_extract(
                                        source_metadata_json,
                                        '$.noIndexActivitySignature'
                                    ), '')
                                    ELSE '' END != ?4
                        )
                    )
               )
             ORDER BY CASE WHEN parser_version < ?2 THEN 0 ELSE 1 END,
                      updated_at ASC, source_session_id ASC
             LIMIT ?5",
        )
        .map_err(|err| format!("Failed to prepare cached Cursor validation query: {err}"))?;
    let rows = stmt
        .query_map(
            params![
                SOURCE_CURSOR_IDE,
                CURSOR_IDE_METADATA_PARSER_VERSION,
                storage_snapshot.database_identity,
                storage_snapshot.activity_signature,
                NO_INDEX_VALIDATION_BATCH_SIZE as i64,
            ],
            |row| {
                Ok(CachedCursorParent {
                    source_session_id: row.get(0)?,
                    source_path: row.get(1)?,
                    source_record_key: row.get(2)?,
                    source_mtime_ms: row.get(3)?,
                    source_size_bytes: row.get(4)?,
                    source_fingerprint: row.get(5)?,
                    name: row.get(6)?,
                    created_at_ms: row.get(7)?,
                    updated_at_ms: row.get(8)?,
                    source_metadata_json: row.get(9)?,
                })
            },
        )
        .map_err(|err| format!("Failed to query cached Cursor validation rows: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("Failed to read cached Cursor row: {err}"))?);
    }
    Ok(out)
}

fn queue_legacy_no_index_validation(cache_conn: &Connection) -> Result<(), String> {
    cache_conn
        .execute(
            "UPDATE imported_history_session_cache
             SET parser_version=?2
             WHERE source=?1
               AND COALESCE(parent_session_id, '')=''
               AND listable=1
               AND parser_version>=?3
               AND json_valid(source_metadata_json)
               AND json_extract(source_metadata_json,
                                '$.noIndexValidationSignature') IS NOT NULL
               AND json_extract(source_metadata_json,
                                '$.noIndexDatabaseIdentity') IS NULL",
            params![
                SOURCE_CURSOR_IDE,
                CURSOR_IDE_METADATA_PARSER_VERSION - 1,
                CURSOR_IDE_METADATA_PARSER_VERSION,
            ],
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to queue legacy Cursor validation watermark: {err}"))
}

fn demote_no_index_rows_from_replaced_database(
    cache_conn: &Connection,
    storage_snapshot: &CursorStorageSnapshot,
) -> Result<(), String> {
    cache_conn
        .execute(
            "UPDATE imported_history_session_cache
             SET listable=0,
                 source_metadata_json=json_set(
                    CASE WHEN json_valid(source_metadata_json)
                         THEN source_metadata_json ELSE '{}' END,
                    '$.noIndexDatabaseIdentity', ?2,
                    '$.noIndexActivitySignature', ''
                 ),
                 updated_at=?3
             WHERE source=?1
               AND COALESCE(parent_session_id, '')=''
               AND CASE WHEN json_valid(source_metadata_json)
                        THEN COALESCE(json_extract(
                            source_metadata_json,
                            '$.noIndexDatabaseIdentity'
                        ), '')
                        ELSE '' END NOT IN ('', ?2)",
            params![
                SOURCE_CURSOR_IDE,
                storage_snapshot.database_identity,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to hide Cursor rows after DB replacement: {err}"))
}

pub(super) fn demote_definitively_missing_cursor_database(
    cache_conn: &Connection,
) -> Result<(), String> {
    cache_conn
        .execute(
            "UPDATE imported_history_session_cache
             SET listable=0, parser_version=?2,
                 source_metadata_json=json_set(
                    CASE WHEN json_valid(source_metadata_json)
                         THEN source_metadata_json ELSE '{}' END,
                    '$.noIndexDatabaseIdentity', ?3,
                    '$.noIndexActivitySignature', ''
                 ),
                 updated_at=?4
             WHERE source=?1 AND COALESCE(parent_session_id, '')=''",
            params![
                SOURCE_CURSOR_IDE,
                CURSOR_IDE_METADATA_PARSER_VERSION,
                CURSOR_STORAGE_MISSING_IDENTITY,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map(|_| ())
        .map_err(|err| format!("Failed to hide Cursor rows for missing database: {err}"))
}

fn cached_cursor_child_ids_by_parent(
    cache_conn: &Connection,
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = cache_conn
        .prepare(
            "SELECT source_session_id, parent_session_id
             FROM imported_history_session_cache
             WHERE source = ?1 AND parent_session_id != ''",
        )
        .map_err(|err| format!("Failed to prepare cached Cursor child query: {err}"))?;
    let rows = stmt
        .query_map([SOURCE_CURSOR_IDE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("Failed to query cached Cursor children: {err}"))?;

    let mut child_ids_by_parent = HashMap::<String, Vec<String>>::new();
    for row in rows {
        let (child_id, parent_session_id) =
            row.map_err(|err| format!("Failed to read cached Cursor child row: {err}"))?;
        let Some(parent_id) = parent_session_id.strip_prefix(CURSORIDE_SESSION_PREFIX) else {
            continue;
        };
        child_ids_by_parent
            .entry(parent_id.to_string())
            .or_default()
            .push(child_id);
    }
    Ok(child_ids_by_parent)
}

pub(super) fn discover_from_index(index_conn: &Connection) -> Result<Vec<CursorIndexRow>, String> {
    let mut stmt = index_conn
        .prepare(CONVERSATION_INDEX_QUERY)
        .map_err(|err| format!("Failed to prepare Cursor conversation index query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CursorIndexRow {
                id: row.get::<_, String>(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                updated_at_ms: row.get::<_, i64>(2)?,
                is_archived: row.get::<_, i64>(3)? != 0,
                root_fingerprint: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to read Cursor conversation index: {err}"))?;

    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(|err| format!("Failed to read Cursor index row: {err}"))?;
        if !row.id.is_empty() {
            out.push(row);
        }
    }
    Ok(out)
}

/// Build a cache row for a changed index conversation. Point-looks-up its
/// `composerData` in `state.vscdb` for rich metadata and confirms that the
/// session has replayable user content. If the blob is temporarily absent, no
/// replacement input is emitted, so an existing valid cache row stays intact.
pub(super) fn build_inputs_from_index(
    cursor_conn: Option<&Connection>,
    row: &CursorIndexRow,
    source_path: &str,
) -> Result<CursorParentBuild, String> {
    let record_key = format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{}", row.id);
    if let Some(cursor_conn) = cursor_conn {
        let raw = match load_composer_raw(cursor_conn, &row.id) {
            Ok(CursorComposerLoad::Present(raw)) => Some(raw),
            Ok(CursorComposerLoad::Missing | CursorComposerLoad::Malformed) => None,
            Err(_) => {
                return Ok(CursorParentBuild {
                    inputs: Vec::new(),
                    live_child_ids: Vec::new(),
                    child_list_authoritative: false,
                    composer_availability: CursorComposerAvailability::TemporarilyUnavailable,
                })
            }
        };
        if let Some(raw) = raw {
            let user_bubbles = match probe_replayable_user_bubbles(cursor_conn, &row.id, &raw) {
                Ok(value) => value,
                Err(_) => {
                    return Ok(CursorParentBuild {
                        inputs: Vec::new(),
                        live_child_ids: Vec::new(),
                        child_list_authoritative: false,
                        composer_availability: CursorComposerAvailability::TemporarilyUnavailable,
                    })
                }
            };
            let mut input = match cache_input_from_raw(
                cursor_conn,
                &row.id,
                source_path,
                &record_key,
                row.updated_at_ms,
                row.is_archived as i64,
                &row.root_fingerprint,
                &raw,
                None,
                None,
            ) {
                Ok(input) => input,
                Err(_) => {
                    return Ok(CursorParentBuild {
                        inputs: Vec::new(),
                        live_child_ids: Vec::new(),
                        child_list_authoritative: false,
                        composer_availability: CursorComposerAvailability::TemporarilyUnavailable,
                    })
                }
            };
            input.name = preferred_cursor_title(
                &row.id,
                &raw.name,
                &row.title,
                user_bubbles.first_user_preview.as_deref(),
            );
            input.listable = user_bubbles.has_user_bubble;
            // Sort/display recency comes from the index's authoritative
            // `updated_at`, not the composer's possibly-stale last-bubble time.
            if row.updated_at_ms > 0 {
                input.updated_at_ms = row.updated_at_ms;
            }
            let mut seen_child_ids = HashSet::new();
            let live_child_ids = raw
                .subagent_composer_ids
                .iter()
                .map(|id| id.trim())
                .filter(|id| !id.is_empty() && *id != row.id)
                .filter(|id| seen_child_ids.insert((*id).to_string()))
                .map(str::to_string)
                .collect::<Vec<_>>();
            let mut inputs = Vec::with_capacity(live_child_ids.len() + 1);
            inputs.push(input);
            for child_id in &live_child_ids {
                let child_raw = match load_composer_raw(cursor_conn, child_id)? {
                    CursorComposerLoad::Present(raw) => raw,
                    CursorComposerLoad::Missing | CursorComposerLoad::Malformed => continue,
                };
                let child_parent_id = child_raw
                    .subagent_info
                    .as_ref()
                    .map(|info| info.parent_composer_id.trim())
                    .filter(|parent_id| !parent_id.is_empty())
                    .unwrap_or(&row.id);
                let child_record_key =
                    format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{child_id}");
                let child_source_mtime = child_raw
                    .created_at
                    .max(child_raw.last_updated_at)
                    .max(row.updated_at_ms);
                inputs.push(cache_input_from_raw(
                    cursor_conn,
                    child_id,
                    source_path,
                    &child_record_key,
                    child_source_mtime,
                    0,
                    &format!("parent:{child_parent_id}"),
                    &child_raw,
                    Some(child_parent_id),
                    None,
                )?);
            }
            return Ok(CursorParentBuild {
                inputs,
                live_child_ids,
                child_list_authoritative: true,
                composer_availability: CursorComposerAvailability::Available,
            });
        }
        return Ok(CursorParentBuild {
            inputs: Vec::new(),
            live_child_ids: Vec::new(),
            child_list_authoritative: false,
            composer_availability: CursorComposerAvailability::MissingOrMalformed,
        });
    }
    // The conversation index can be written before its composer blob. Do not
    // create an index-only visible shell, and do not overwrite a previously
    // valid cached row during that transient window. The still-live parent id
    // retained by the caller prevents pruning; absence from the cache makes a
    // newly-discovered row retry on the next refresh.
    Ok(CursorParentBuild {
        inputs: Vec::new(),
        live_child_ids: Vec::new(),
        child_list_authoritative: false,
        composer_availability: CursorComposerAvailability::TemporarilyUnavailable,
    })
}

/// Point-lookup + parse a single `composerData:<id>` row (fast; primary key).
fn load_composer_raw(cursor_conn: &Connection, id: &str) -> Result<CursorComposerLoad, String> {
    #[cfg(test)]
    {
        CURSOR_CONTENT_PROBE_COUNT.set(CURSOR_CONTENT_PROBE_COUNT.get() + 1);
        CURSOR_CONTENT_PROBED_IDS.with(|ids| ids.borrow_mut().push(id.to_string()));
    }

    let key = format!("{COMPOSER_KEY_PREFIX}{id}");
    let value: Option<String> = cursor_conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Cursor composer {id}: {err}"))?;
    let Some(value) = value else {
        return Ok(CursorComposerLoad::Missing);
    };
    // Malformed JSON is stable source content for this physical generation,
    // unlike a SQLite read error. Callers may hide/stamp it while keeping
    // SQLITE_BUSY/LOCKED and other query failures retryable.
    match serde_json::from_str(&value) {
        Ok(raw) => Ok(CursorComposerLoad::Present(Box::new(raw))),
        Err(_) => Ok(CursorComposerLoad::Malformed),
    }
}

/// Confirm real user content separately from deriving an optional title
/// preview.
///
/// Header point-lookups preserve Cursor's canonical conversation order. A
/// final composer-key-range probe recovers real bubbles omitted from stale
/// `fullConversationHeadersOnly` metadata without scanning `cursorDiskKV`.
fn probe_replayable_user_bubbles(
    cursor_conn: &Connection,
    composer_id: &str,
    raw: &RawComposerData,
) -> Result<super::helpers::CursorUserBubbleProbe, String> {
    let mut stmt = cursor_conn
        .prepare("SELECT value FROM cursorDiskKV WHERE key=?1")
        .map_err(|err| format!("Failed to prepare Cursor user-bubble lookup: {err}"))?;
    let mut probe = super::helpers::CursorUserBubbleProbe::default();
    for header in &raw.full_conversation_headers_only {
        if header.bubble_id.trim().is_empty() {
            continue;
        }
        // Newer Cursor versions put the type in the header. A zero/missing
        // type is still checked because older composer blobs only typed the
        // bubble value.
        if header.bubble_type != 0 && header.bubble_type != 1 {
            continue;
        }
        let key = format!("{BUBBLE_KEY_PREFIX}{composer_id}:{}", header.bubble_id);
        let value = stmt
            .query_row([key], |row| row.get::<_, Option<String>>(0))
            .optional()
            .map_err(|err| format!("Failed to read Cursor user bubble: {err}"))?
            .flatten();
        let Some(value) = value else {
            continue;
        };
        let Ok(bubble) = serde_json::from_str::<super::super::models::RawBubble>(&value) else {
            continue;
        };
        let bubble_type = if bubble.bubble_type != 0 {
            bubble.bubble_type
        } else {
            header.bubble_type
        };
        if bubble_type != 1 {
            continue;
        }
        probe.has_user_bubble = true;
        let preview = super::helpers::preview_text(&bubble.text);
        if !preview.is_empty() {
            probe.first_user_preview = Some(preview);
            return Ok(probe);
        }
    }
    let indexed = super::helpers::probe_indexed_cursor_user_bubbles(cursor_conn, composer_id)?;
    probe.has_user_bubble |= indexed.has_user_bubble;
    if probe.first_user_preview.is_none() {
        probe.first_user_preview = indexed.first_user_preview;
    }
    Ok(probe)
}

pub(super) fn preferred_cursor_title(
    composer_id: &str,
    composer_title: &str,
    fallback_title: &str,
    first_user_text: Option<&str>,
) -> String {
    if !is_cursor_placeholder_title(composer_title, composer_id) {
        return composer_title.trim().to_string();
    }
    if !is_cursor_placeholder_title(fallback_title, composer_id) {
        return fallback_title.trim().to_string();
    }
    first_user_text.unwrap_or_default().to_string()
}

fn is_cursor_placeholder_title(title: &str, composer_id: &str) -> bool {
    let title = title.trim();
    if title.is_empty() {
        return true;
    }
    let normalized = title.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "new agent"
            | "new chat"
            | "untitled"
            | "untitled cursor session"
            | "cursor session"
            | "composer"
    ) {
        return true;
    }
    if looks_like_uuid(&normalized) {
        return true;
    }
    let composer_id = composer_id.trim().to_ascii_lowercase();
    normalized == composer_id
        || normalized == format!("{CURSORIDE_SESSION_PREFIX}{composer_id}").to_ascii_lowercase()
        || normalized == format!("{COMPOSER_KEY_PREFIX}{composer_id}").to_ascii_lowercase()
        || normalized
            == format!("{SOURCE_RECORD_KEY_PREFIX}{COMPOSER_KEY_PREFIX}{composer_id}")
                .to_ascii_lowercase()
}

fn looks_like_uuid(value: &str) -> bool {
    let segments = value.split('-').collect::<Vec<_>>();
    segments.len() == 5
        && segments
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(segment, expected_len)| {
                segment.len() == expected_len
                    && segment.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

/// Normalize a parsed `composerData` blob into a cache row.
#[allow(clippy::too_many_arguments)]
fn cache_input_from_raw(
    cursor_conn: &Connection,
    id: &str,
    source_path: &str,
    source_record_key: &str,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: &str,
    raw: &RawComposerData,
    parent_source_session_id: Option<&str>,
    storage_snapshot: Option<&CursorStorageSnapshot>,
) -> Result<ImportedHistoryCacheInput, String> {
    let model = raw
        .model_config
        .as_ref()
        .map(|config| config.model_name.trim())
        .filter(|model_name| !model_name.is_empty())
        .map(str::to_string);
    let last_active_at = cursor_last_active_at(cursor_conn, raw)?;
    // Git + touched-file metadata straight from the composer blob (these used to
    // be computed lazily on hover; now they ride in the row like every other
    // source).
    let workspace = super::helpers::cursor_workspace_metadata_from_parts(
        &raw.tracked_git_repos,
        raw.workspace_identifier.as_ref(),
    );
    let touched_files = super::helpers::cursor_touched_files_from_states(&raw.original_file_states);
    let metadata = CursorCacheMetadata {
        status: raw.status.clone(),
        is_agentic: raw.is_agentic,
        mode: raw.unified_mode.clone(),
        no_index_database_identity: storage_snapshot
            .map(|snapshot| snapshot.database_identity.clone()),
        no_index_activity_signature: storage_snapshot
            .map(|snapshot| snapshot.activity_signature.clone()),
        index_blob_validation: None,
    };
    let source_metadata_json = serde_json::to_string(&metadata)
        .map_err(|err| format!("Failed to encode Cursor metadata cache payload: {err}"))?;

    let parent_session_id = parent_source_session_id
        .map(str::trim)
        .filter(|parent_id| !parent_id.is_empty() && *parent_id != id)
        .map(|parent_id| format!("{CURSORIDE_SESSION_PREFIX}{parent_id}"));
    Ok(ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: id.to_string(),
        session_id: super::canonical_session_id(id),
        source_path: source_path.to_string(),
        source_record_key: source_record_key.to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: source_fingerprint.to_string(),
        parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        name: raw.name.clone(),
        created_at_ms: raw.created_at,
        updated_at_ms: last_active_at,
        model,
        input_tokens: raw.context_tokens_used as i64,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: workspace.repo_path,
        branch: workspace.branch,
        impact: ImportedHistoryImpactStats {
            files_changed: raw.files_changed_count,
            lines_added: raw.total_lines_added,
            lines_removed: raw.total_lines_removed,
            touched_files,
        },
        // Child rows are fetched through `es_get_child_sessions`, not through
        // root-session pagination or analytics lists.
        listable: parent_session_id.is_none(),
        source_metadata_json: Some(source_metadata_json),
        parent_session_id,
    })
}

fn cursor_last_active_at(cursor_conn: &Connection, raw: &RawComposerData) -> Result<i64, String> {
    let mut last_active_at = raw.created_at.max(raw.last_updated_at);
    if let Some(last_header) = raw
        .full_conversation_headers_only
        .last()
        .filter(|header| !header.bubble_id.is_empty())
    {
        let bubble_key = format!(
            "{BUBBLE_KEY_PREFIX}{}:{}",
            raw.composer_id, last_header.bubble_id
        );
        let bubble_json: Option<String> = cursor_conn
            .query_row(
                "SELECT value FROM cursorDiskKV WHERE key = ?1",
                params![bubble_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("Failed to read Cursor latest bubble timestamp: {err}"))?;
        if let Some(value) = bubble_json {
            if let Ok(timestamp) = serde_json::from_str::<BubbleTimestamp>(&value) {
                let bubble_active_at = parse_iso_to_epoch_ms(&timestamp.created_at);
                if bubble_active_at > 0 {
                    last_active_at = last_active_at.max(bubble_active_at);
                }
            }
        }
    }
    Ok(last_active_at)
}

fn parse_iso_to_epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}
