//! Mimo Code imported-history reader.
//!
//! Mimo persists sessions in `mimocode.db`. Its `message` and `part` tables use
//! the same normalized JSON shapes as OpenCode, while its `session` table has a
//! smaller metadata surface. This module owns Mimo discovery/cache metadata and
//! delegates part-to-activity conversion to the shared OpenCode-compatible
//! parser.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, OpenFlags};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
        SOURCE_MIMO_CODE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow,
};
use crate::sources::opencode::history::{
    load_opencode_compatible_history_from_conn, load_opencode_compatible_impact_from_conn,
};

pub const MIMO_CODE_SESSION_PREFIX: &str = "mimocodeapp-";
const MIMO_CODE_PROVIDER_SLUG: &str = "mimo_code";
const MIMO_CODE_DB_FILENAME: &str = "mimocode.db";
const MIMO_CODE_METADATA_PARSER_VERSION: i64 = 1;

pub type MimoCodeHistorySessionRow = ImportedHistorySessionRow;
pub type MimoCodeHistorySessionPage = ImportedHistorySessionPage;
pub type MimoCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct MimoCodeSessionMeta {
    source_session_id: String,
    source_path: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    title: String,
    directory: String,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    time_created: i64,
    time_updated: i64,
    parent_id: Option<String>,
    impact: ImportedHistoryImpactStats,
}

pub fn list_mimo_code_history_sessions_paginated(
    cache_conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<MimoCodeHistorySessionPage, String> {
    sync_mimo_code_history_cache(cache_conn)?;
    imported_cache::query_imported_session_page_from_conn(
        cache_conn,
        SOURCE_MIMO_CODE,
        limit,
        offset,
    )
}

pub fn list_mimo_code_recent_paths(
    cache_conn: &mut Connection,
    limit: usize,
) -> Result<Vec<MimoCodeRecentPath>, String> {
    sync_mimo_code_history_cache(cache_conn)?;
    imported_cache::query_imported_recent_paths_from_conn(cache_conn, SOURCE_MIMO_CODE, limit)
}

pub fn load_mimo_code_history_for_session(
    cache_conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = source_id_from_session_id(session_id)?;
    let cached = imported_cache::query_cached_session_from_conn(
        cache_conn,
        SOURCE_MIMO_CODE,
        source_session_id,
    )?
    .ok_or_else(|| format!("Mimo Code session not found: {source_session_id}"))?;
    let conn = open_mimo_code_db_at(Path::new(&cached.source_path))?;
    load_opencode_compatible_history_from_conn(
        &conn,
        session_id,
        source_session_id,
        MIMO_CODE_PROVIDER_SLUG,
    )
}

pub(crate) fn refresh_catalog(cache_conn: &mut Connection) -> Result<(), String> {
    sync_mimo_code_history_cache_inner(cache_conn, false)
}

fn sync_mimo_code_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    sync_mimo_code_history_cache_inner(cache_conn, true)
}

fn sync_mimo_code_history_cache_inner(
    cache_conn: &mut Connection,
    include_legacy_impact: bool,
) -> Result<(), String> {
    let mut metas = Vec::new();
    for db_path in mimo_code_history_candidate_paths() {
        if !db_path.is_file() {
            continue;
        }
        let conn = open_mimo_code_db_at(&db_path)?;
        let (mtime, size) = imported_paths::file_metadata_signature(&db_path, "Mimo Code")?;
        metas.extend(list_session_meta_from_conn(&conn, &db_path, mtime, size)?);
    }

    let container_parent_ids = container_parent_ids(&metas);
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let changed_ids = imported_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_MIMO_CODE,
        &metas,
        meta_signature,
    )?
    .into_iter()
    .map(|meta| meta.source_session_id.clone())
    .collect::<HashSet<_>>();

    let mut inputs = Vec::new();
    for mut meta in metas
        .into_iter()
        .filter(|meta| changed_ids.contains(&meta.source_session_id))
    {
        if include_legacy_impact {
            let session_id = format!("{MIMO_CODE_SESSION_PREFIX}{}", meta.source_session_id);
            let conn = open_mimo_code_db_at(Path::new(&meta.source_path))?;
            meta.impact = load_opencode_compatible_impact_from_conn(
                &conn,
                &session_id,
                &meta.source_session_id,
                MIMO_CODE_PROVIDER_SLUG,
            )?;
        } else if let Some(cached) = imported_cache::query_cached_session_from_conn(
            cache_conn,
            SOURCE_MIMO_CODE,
            &meta.source_session_id,
        )? {
            meta.impact = cached.impact;
        }
        inputs.push(meta_to_cache_input(meta, &container_parent_ids));
    }

    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_MIMO_CODE, live_ids, inputs)
}

fn list_session_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<MimoCodeSessionMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, s.parent_id, \
                    (SELECT json_extract(m.data, '$.modelID') FROM message m \
                     WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant' \
                     ORDER BY m.time_created DESC LIMIT 1), \
                    COALESCE((SELECT SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0) + \
                                               COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) + \
                                               COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)) \
                              FROM message m WHERE m.session_id = s.id), 0), \
                    COALESCE((SELECT SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0) + \
                                               COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)) \
                              FROM message m WHERE m.session_id = s.id), 0) \
             FROM session s WHERE s.time_archived IS NULL",
        )
        .map_err(|err| format!("Failed to prepare Mimo Code session query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MimoCodeSessionMeta {
                source_session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                source_path: db_path.to_string_lossy().to_string(),
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint: String::new(),
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                directory: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                time_created: row.get::<_, Option<i64>>(3)?.unwrap_or_default(),
                time_updated: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                parent_id: row
                    .get::<_, Option<String>>(5)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                model: row
                    .get::<_, Option<String>>(6)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                input_tokens: row.get::<_, Option<i64>>(7)?.unwrap_or_default(),
                output_tokens: row.get::<_, Option<i64>>(8)?.unwrap_or_default(),
                impact: ImportedHistoryImpactStats::default(),
            })
        })
        .map_err(|err| format!("Failed to query Mimo Code sessions: {err}"))?;

    let sidecars = imported_paths::sqlite_sidecar_signature(db_path);
    let mut metas = Vec::new();
    for row in rows {
        let mut meta = row.map_err(|err| format!("Failed to read Mimo Code session row: {err}"))?;
        if meta.source_session_id.trim().is_empty() {
            continue;
        }
        meta.source_fingerprint = [
            meta.source_session_id.as_str(),
            meta.title.as_str(),
            meta.directory.as_str(),
            meta.model.as_deref().unwrap_or_default(),
            &meta.time_created.to_string(),
            &meta.time_updated.to_string(),
            &meta.input_tokens.to_string(),
            &meta.output_tokens.to_string(),
            meta.parent_id.as_deref().unwrap_or_default(),
            sidecars.as_str(),
        ]
        .join("|");
        metas.push(meta);
    }
    Ok(metas)
}

fn meta_signature(meta: &MimoCodeSessionMeta) -> ImportedHistoryRecordSignature {
    ImportedHistoryRecordSignature {
        source_session_id: meta.source_session_id.clone(),
        source_path: meta.source_path.clone(),
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint.clone(),
        parser_version: MIMO_CODE_METADATA_PARSER_VERSION,
    }
}

fn container_parent_ids(metas: &[MimoCodeSessionMeta]) -> HashSet<String> {
    let source_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.as_str())
        .collect::<HashSet<_>>();
    metas
        .iter()
        .filter_map(|meta| meta.parent_id.as_deref())
        .filter(|parent| source_ids.contains(parent))
        .map(str::to_string)
        .collect()
}

fn meta_to_cache_input(
    meta: MimoCodeSessionMeta,
    container_parent_ids: &HashSet<String>,
) -> ImportedHistoryCacheInput {
    let name = if meta.title.trim().is_empty() {
        meta.source_session_id.clone()
    } else {
        imported_history::truncate_name(&meta.title, 200)
    };
    let parent_session_id = meta
        .parent_id
        .as_deref()
        .filter(|parent| container_parent_ids.contains(*parent))
        .map(|parent| format!("{MIMO_CODE_SESSION_PREFIX}{parent}"));
    ImportedHistoryCacheInput {
        source: SOURCE_MIMO_CODE,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{MIMO_CODE_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_session_id.clone(),
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: MIMO_CODE_METADATA_PARSER_VERSION,
        name,
        created_at_ms: meta.time_created,
        updated_at_ms: meta.time_updated.max(meta.time_created),
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: (!meta.directory.trim().is_empty()).then_some(meta.directory),
        branch: None,
        impact: meta.impact,
        listable: !container_parent_ids.contains(&meta.source_session_id),
        source_metadata_json: None,
        parent_session_id,
    }
}

fn source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    session_id
        .strip_prefix(MIMO_CODE_SESSION_PREFIX)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Invalid Mimo Code session id: {session_id}"))
}

fn open_mimo_code_db_at(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| {
        format!(
            "Failed to open Mimo Code database {}: {err}",
            path.display()
        )
    })
}

pub fn mimo_code_history_candidate_paths() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut roots = vec![home.join(".local").join("share").join("mimocode")];
    if let Some(data_local) = dirs::data_local_dir() {
        roots.push(data_local.join("mimocode"));
    }
    if let Some(data) = dirs::data_dir() {
        roots.push(data.join("mimocode"));
    }
    #[cfg(target_os = "macos")]
    roots.push(home.join("Library/Application Support/mimocode"));
    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData/Roaming/mimocode"));
        roots.push(home.join("AppData/Local/mimocode"));
    }
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .map(|root| root.join(MIMO_CODE_DB_FILENAME))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_prefix_is_distinct_from_opencode() {
        assert_eq!(
            source_id_from_session_id("mimocodeapp-session-1").unwrap(),
            "session-1"
        );
        assert!(source_id_from_session_id("opencodeapp-session-1").is_err());
    }

    #[test]
    fn reads_mimo_session_metadata_and_shared_parts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER,
                time_updated INTEGER, parent_id TEXT, time_archived INTEGER
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
             );
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
                time_created INTEGER, data TEXT
             );
             INSERT INTO session VALUES (
                'ses_1', 'Mimo session', '/repo', 1000, 2000, NULL, NULL
             );
             INSERT INTO message VALUES (
                'msg_1', 'ses_1', 1000,
                '{\"role\":\"user\",\"time\":{\"created\":1000}}'
             );
             INSERT INTO message VALUES (
                'msg_2', 'ses_1', 1500,
                '{\"role\":\"assistant\",\"modelID\":\"mimo-model\",\"tokens\":{\"input\":2,\"output\":3,\"reasoning\":1,\"cache\":{\"read\":5,\"write\":7}}}'
             );
             INSERT INTO part VALUES (
                'part_1', 'msg_1', 'ses_1', 1000,
                '{\"type\":\"text\",\"text\":\"hello\"}'
             );
             INSERT INTO part VALUES (
                'part_2', 'msg_2', 'ses_1', 1500,
                '{\"type\":\"text\",\"text\":\"hi\"}'
             );",
        )
        .unwrap();

        let metas =
            list_session_meta_from_conn(&conn, Path::new("mimocode.db"), 10, 20).expect("metadata");
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].model.as_deref(), Some("mimo-model"));
        assert_eq!(metas[0].input_tokens, 14);
        assert_eq!(metas[0].output_tokens, 4);

        let chunks = load_opencode_compatible_history_from_conn(
            &conn,
            "mimocodeapp-ses_1",
            "ses_1",
            MIMO_CODE_PROVIDER_SLUG,
        )
        .expect("chunks");
        assert_eq!(chunks.len(), 2);
    }
}
