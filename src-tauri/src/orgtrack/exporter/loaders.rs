//! SQLite readers for the export inputs: provenance rows, local edit events,
//! sessions, commit links, and raw trajectory events, plus schema introspection.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;

use chrono::{DateTime, Utc};
use orgtrack_core::projectors::turn_metadata::metadata_projection_requirements;
use orgtrack_core::sources::imported_history::replay::{
    self, ImportedHistorySourceId, ReplayCursor, ReplayIndexedChunk, ReplayLimits,
    ReplayPayloadDescriptor,
};
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

use super::file_paths::{
    extract_file_paths_from_json, is_file_edit_function, path_belongs_to_repo,
};
use super::{LocalEditRow, ProvenanceRow, SessionRow};
use crate::orgtrack::types::OrgtrackTier;

/// SQLite BLOB and replay payload reads are kept independently bounded even
/// when one trajectory field is hundreds of MiB. The outer BufWriter is
/// capped separately in `export.rs`.
pub(super) const TRAJECTORY_PAYLOAD_RANGE_BYTES: usize = 256 * 1024;

pub(super) fn load_local_edit_rows(
    conn: &mut rusqlite::Connection,
    repo_path: &Path,
) -> Result<Vec<LocalEditRow>, String> {
    let mut rows = Vec::new();
    if table_exists(conn, "events")? {
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, function_name, args_json, result_json, created_at
                 FROM events
                 ORDER BY created_at ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let mut mapped = stmt
            .query([])
            .map_err(|err| format!("Query failed: {}", err))?;
        while let Some(row) = mapped
            .next()
            .map_err(|err| format!("Row decode failed: {}", err))?
        {
            let event_id = row
                .get::<_, String>(0)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let session_id = row
                .get::<_, String>(1)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let function_name = row
                .get::<_, Option<String>>(2)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let Some(function_name_value) = function_name.as_deref() else {
                continue;
            };
            // Read the lightweight tool discriminator before materializing
            // either JSON column. Known non-edit tools (assistant/thinking,
            // Grep, Node REPL, reads, shell, and so on) cannot contribute a
            // local-edit row, while unknown tools retain the conservative
            // old path through the shared projection classifier.
            if !metadata_projection_requirements(Some(function_name_value))
                .projects_modified_files()
            {
                continue;
            }
            let args_json = row
                .get::<_, String>(3)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let result_json = row
                .get::<_, String>(4)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let created_at = row
                .get::<_, String>(5)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            if !is_file_edit_function(function_name_value) {
                continue;
            }
            for file_path in
                extract_file_paths_from_json(function_name_value, &args_json, &result_json)
            {
                if path_belongs_to_repo(conn, repo_path, &session_id, &file_path)? {
                    rows.push(LocalEditRow {
                        event_id: event_id.clone(),
                        session_id: session_id.clone(),
                        file_path,
                        function_name: function_name.clone(),
                        created_at: parse_timestamp(&created_at),
                    });
                }
            }
        }
    }

    if table_exists(conn, "code_session_chunks")? {
        let mut stmt = conn
            .prepare(
                "SELECT chunk_id, session_id, function, args_json, result_json, created_at
                 FROM code_session_chunks
                 ORDER BY sequence ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let mut mapped = stmt
            .query([])
            .map_err(|err| format!("Query failed: {}", err))?;
        while let Some(row) = mapped
            .next()
            .map_err(|err| format!("Row decode failed: {}", err))?
        {
            let event_id = row
                .get::<_, String>(0)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let session_id = row
                .get::<_, String>(1)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let function_name = row
                .get::<_, String>(2)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            if !metadata_projection_requirements(Some(&function_name)).projects_modified_files() {
                continue;
            }
            let args_json = row
                .get::<_, String>(3)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let result_json = row
                .get::<_, String>(4)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            let created_at = row
                .get::<_, String>(5)
                .map_err(|err| format!("Row decode failed: {}", err))?;
            if !is_file_edit_function(&function_name) {
                continue;
            }
            for file_path in extract_file_paths_from_json(&function_name, &args_json, &result_json)
            {
                if path_belongs_to_repo(conn, repo_path, &session_id, &file_path)? {
                    rows.push(LocalEditRow {
                        event_id: event_id.clone(),
                        session_id: session_id.clone(),
                        file_path,
                        function_name: Some(function_name.clone()),
                        created_at: parse_timestamp(&created_at),
                    });
                }
            }
        }
    }

    // Native-mode managed sessions persist no chunk rows — their transcript
    // lives in the CLI's own store. Recover their file edits through the
    // imported loaders so exports don't silently lose those sessions.
    // `unwrap_or_default` tolerates DBs predating the transcript_source column.
    if table_exists(conn, "code_sessions")? {
        let native_session_ids: Vec<String> = conn
            .prepare("SELECT session_id FROM code_sessions WHERE transcript_source = 'native'")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        for session_id in native_session_ids {
            let Some(imported_id) =
                crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
                    &session_id,
                )
            else {
                continue;
            };
            let replay_result = for_each_imported_replay_chunk(
                conn,
                &imported_id,
                |replay_conn, _generation, indexed| {
                    let chunk = indexed.chunk;
                    if !is_file_edit_function(&chunk.function) {
                        return Ok(());
                    }
                    let args_json = chunk.args.to_string();
                    let result_json = chunk.result.to_string();
                    for file_path in
                        extract_file_paths_from_json(&chunk.function, &args_json, &result_json)
                    {
                        if path_belongs_to_repo(replay_conn, repo_path, &session_id, &file_path)? {
                            rows.push(LocalEditRow {
                                event_id: chunk.chunk_id.clone(),
                                session_id: session_id.clone(),
                                file_path,
                                function_name: Some(chunk.function.clone()),
                                created_at: parse_timestamp(&chunk.created_at),
                            });
                        }
                    }
                    Ok(())
                },
            );
            if let Err(err) = replay_result {
                tracing::warn!(
                    session_id,
                    imported_id,
                    error = %err,
                    "Skipping managed native transcript during edit export"
                );
            }
        }
    }

    rows.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    Ok(rows)
}

#[cfg(test)]
mod local_edit_projection_tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open test database");
        conn.execute_batch(
            "CREATE TABLE events (
                 id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 function_name TEXT,
                 args_json,
                 result_json,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE code_session_chunks (
                 chunk_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 function TEXT NOT NULL,
                 args_json,
                 result_json,
                 created_at TEXT NOT NULL,
                 sequence INTEGER NOT NULL
             );",
        )
        .expect("create test schema");
        conn
    }

    fn insert_valid_rows(conn: &Connection) {
        let large_text = format!(r#"{{"text":"{}"}}"#, "x".repeat(128 * 1024));
        for (id, function_name) in [
            ("assistant", "assistant"),
            ("thinking", "thinking"),
            ("grep", "Grep"),
            ("node", "node_repl"),
            ("unknown", "future_provider_tool"),
        ] {
            conn.execute(
                "INSERT INTO events
                 (id, session_id, function_name, args_json, result_json, created_at)
                 VALUES (?1, 'session', ?2, ?3, ?3, '2026-01-01T00:00:00Z')",
                params![id, function_name, large_text],
            )
            .expect("insert event fixture");
        }
        conn.execute(
            "INSERT INTO events
             (id, session_id, function_name, args_json, result_json, created_at)
             VALUES ('edit', 'session', 'edit_file',
                     '{\"file_path\":\"src/event.rs\"}', '{}',
                     '2026-01-01T00:00:01Z')",
            [],
        )
        .expect("insert event edit");
        conn.execute(
            "INSERT INTO code_session_chunks
             (chunk_id, session_id, function, args_json, result_json, created_at, sequence)
             VALUES ('patch', 'session', 'apply_patch',
                     '{\"patch_text\":\"*** Update File: src/chunk.rs\\n\"}', '{}',
                     '2026-01-01T00:00:02Z', 1)",
            [],
        )
        .expect("insert chunk edit");
        conn.execute(
            "INSERT INTO code_session_chunks
             (chunk_id, session_id, function, args_json, result_json, created_at, sequence)
             VALUES ('chunk-unknown', 'session', 'future_chunk_tool',
                     '{\"file_path\":\"src/ignored.rs\"}', '{}',
                     '2026-01-01T00:00:03Z', 2)",
            [],
        )
        .expect("insert unknown chunk");
    }

    /// Test-only copy of the pre-short-circuit projection. It intentionally
    /// materializes both JSON columns before inspecting the tool name.
    fn load_local_edit_rows_legacy(
        conn: &Connection,
        repo_path: &Path,
    ) -> Result<Vec<LocalEditRow>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, function_name, args_json, result_json, created_at
                 FROM events
                 UNION ALL
                 SELECT chunk_id, session_id, function, args_json, result_json, created_at
                 FROM code_session_chunks",
            )
            .map_err(|err| err.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        let mut rows = Vec::new();
        for row in mapped {
            let (event_id, session_id, function_name, args_json, result_json, created_at) =
                row.map_err(|err| err.to_string())?;
            let Some(function_name_value) = function_name.as_deref() else {
                continue;
            };
            if !is_file_edit_function(function_name_value) {
                continue;
            }
            for file_path in
                extract_file_paths_from_json(function_name_value, &args_json, &result_json)
            {
                if path_belongs_to_repo(conn, repo_path, &session_id, &file_path)? {
                    rows.push(LocalEditRow {
                        event_id: event_id.clone(),
                        session_id: session_id.clone(),
                        file_path,
                        function_name: function_name.clone(),
                        created_at: parse_timestamp(&created_at),
                    });
                }
            }
        }
        rows.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        Ok(rows)
    }

    fn row_signatures(
        rows: Vec<LocalEditRow>,
    ) -> Vec<(String, String, String, Option<String>, i64)> {
        rows.into_iter()
            .map(|row| {
                (
                    row.event_id,
                    row.session_id,
                    row.file_path,
                    row.function_name,
                    row.created_at,
                )
            })
            .collect()
    }

    #[test]
    fn local_edit_projection_matches_legacy_for_edits_and_unknown_tools() {
        let mut conn = test_connection();
        insert_valid_rows(&conn);

        let legacy = load_local_edit_rows_legacy(&conn, Path::new("/repo"))
            .expect("legacy projection succeeds");
        let projected =
            load_local_edit_rows(&mut conn, Path::new("/repo")).expect("projection succeeds");

        assert_eq!(row_signatures(projected), row_signatures(legacy));
    }

    #[test]
    fn large_known_non_edit_payloads_are_not_read_but_unknown_tools_remain_conservative() {
        let mut conn = test_connection();
        let large_blob = vec![b'x'; 1024 * 1024];
        for (index, function_name) in ["assistant", "thinking", "Grep", "node_repl"]
            .into_iter()
            .enumerate()
        {
            conn.execute(
                "INSERT INTO events
                 (id, session_id, function_name, args_json, result_json, created_at)
                 VALUES (?1, 'session', ?2, ?3, ?3, '2026-01-01T00:00:00Z')",
                params![format!("event-{index}"), function_name, &large_blob],
            )
            .expect("insert large event payload");
            conn.execute(
                "INSERT INTO code_session_chunks
                 (chunk_id, session_id, function, args_json, result_json, created_at, sequence)
                 VALUES (?1, 'session', ?2, ?3, ?3, '2026-01-01T00:00:00Z', ?4)",
                params![format!("chunk-{index}"), function_name, &large_blob, index],
            )
            .expect("insert large chunk payload");
        }
        conn.execute(
            "INSERT INTO events
             (id, session_id, function_name, args_json, result_json, created_at)
             VALUES ('edit', 'session', 'edit_file',
                     '{\"file_path\":\"src/kept.rs\"}', '{}',
                     '2026-01-01T00:00:01Z')",
            [],
        )
        .expect("insert edit event");

        let rows = load_local_edit_rows(&mut conn, Path::new("/repo"))
            .expect("known non-edit BLOB columns must not be decoded as strings");
        assert_eq!(row_signatures(rows).len(), 1);

        conn.execute(
            "INSERT INTO events
             (id, session_id, function_name, args_json, result_json, created_at)
             VALUES ('unknown', 'session', 'future_provider_tool', ?1, ?1,
                     '2026-01-01T00:00:02Z')",
            params![&large_blob],
        )
        .expect("insert unknown payload");
        let err = load_local_edit_rows(&mut conn, Path::new("/repo"))
            .expect_err("unknown tools must retain conservative payload materialization");
        assert!(err.contains("Row decode failed"), "unexpected error: {err}");
    }
}

pub(super) fn load_provenance_rows(
    conn: &rusqlite::Connection,
    repo_path: &Path,
) -> Result<Vec<ProvenanceRow>, String> {
    let repo_prefix = repo_path.to_string_lossy().to_string();
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, file, function_name, node_type, start_line, end_line, created_at
             FROM node_provenance
             WHERE file LIKE ?1 OR file NOT LIKE '/%'
             ORDER BY created_at ASC",
        )
        .map_err(|err| format!("Prepare failed: {}", err))?;
    let rows = stmt
        .query_map(params![format!("{}%", repo_prefix)], |row| {
            Ok(ProvenanceRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                file_path: row.get(2)?,
                function_name: row.get(3)?,
                node_type: row.get(4)?,
                start_line: row.get::<_, i64>(5)?.max(1) as u32,
                end_line: row.get::<_, i64>(6)?.max(1) as u32,
                created_at: row.get(7)?,
            })
        })
        .map_err(|err| format!("Query failed: {}", err))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| format!("Row decode failed: {}", err))
}

fn parse_timestamp(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp())
        .unwrap_or_else(|_| Utc::now().timestamp())
}

pub(super) fn load_session_rows(
    conn: &rusqlite::Connection,
    session_ids: &BTreeSet<String>,
) -> Result<BTreeMap<String, SessionRow>, String> {
    let mut sessions = BTreeMap::new();
    let columns = table_columns(conn, "agent_sessions")?;
    if columns.is_empty() {
        for session_id in session_ids {
            sessions.insert(session_id.clone(), fallback_session_row(session_id));
        }
        return Ok(sessions);
    }

    for session_id in session_ids {
        let mut stmt = conn
            .prepare("SELECT * FROM agent_sessions WHERE session_id = ?1")
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let row = stmt.query_row([session_id], |row| {
            let name = get_optional_column(row, &columns, "name")?.unwrap_or_default();
            let user_input = get_optional_column(row, &columns, "user_input")?;
            Ok(SessionRow {
                session_id: get_optional_column(row, &columns, "session_id")?
                    .unwrap_or_else(|| session_id.clone()),
                label: if name.trim().is_empty() {
                    user_input
                        .as_deref()
                        .unwrap_or(session_id)
                        .chars()
                        .take(80)
                        .collect()
                } else {
                    name
                },
                agent_kind: get_optional_column(row, &columns, "session_type")?,
                model: get_optional_column(row, &columns, "model")?,
                key_source: get_optional_column(row, &columns, "key_source")?,
                agent_exec_mode: get_optional_column(row, &columns, "agent_exec_mode")?,
                created_at: get_optional_column(row, &columns, "created_at")?,
                updated_at: get_optional_column(row, &columns, "updated_at")?,
                summary: user_input.map(|value| value.chars().take(240).collect()),
            })
        });
        match row {
            Ok(session) => {
                sessions.insert(session.session_id.clone(), session);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                if let Some(session) = load_code_session_row(conn, session_id)? {
                    sessions.insert(session.session_id.clone(), session);
                } else {
                    sessions.insert(session_id.clone(), fallback_session_row(session_id));
                }
            }
            Err(err) => return Err(format!("Session query failed: {}", err)),
        }
    }
    Ok(sessions)
}

fn load_code_session_row(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionRow>, String> {
    if !table_exists(conn, "code_sessions")? {
        return Ok(None);
    }
    let columns = table_columns(conn, "code_sessions")?;
    let mut stmt = conn
        .prepare("SELECT * FROM code_sessions WHERE session_id = ?1")
        .map_err(|err| format!("Prepare failed: {}", err))?;
    let row = stmt.query_row([session_id], |row| {
        let name = get_optional_column(row, &columns, "name")?.unwrap_or_default();
        let user_input = get_optional_column(row, &columns, "user_input")?;
        let cli_agent_type = get_optional_column(row, &columns, "cli_agent_type")?.or_else(|| {
            get_optional_column(row, &columns, "platform")
                .ok()
                .flatten()
        });
        Ok(SessionRow {
            session_id: get_optional_column(row, &columns, "session_id")?
                .unwrap_or_else(|| session_id.to_string()),
            label: if name.trim().is_empty() {
                user_input
                    .as_deref()
                    .unwrap_or(session_id)
                    .chars()
                    .take(80)
                    .collect()
            } else {
                name
            },
            agent_kind: cli_agent_type.or_else(|| Some("cli_agent".to_string())),
            model: get_optional_column(row, &columns, "model")?,
            key_source: get_optional_column(row, &columns, "key_source")?,
            agent_exec_mode: get_optional_column(row, &columns, "agent_exec_mode")?,
            created_at: get_optional_column(row, &columns, "created_at")?,
            updated_at: get_optional_column(row, &columns, "updated_at")?,
            summary: user_input.map(|value| value.chars().take(240).collect()),
        })
    });
    match row {
        Ok(session) => Ok(Some(session)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("Code session query failed: {}", err)),
    }
}

fn fallback_session_row(session_id: &str) -> SessionRow {
    SessionRow {
        session_id: session_id.to_string(),
        label: session_id.to_string(),
        agent_kind: None,
        model: None,
        key_source: None,
        agent_exec_mode: None,
        created_at: None,
        updated_at: None,
        summary: None,
    }
}

pub(super) fn load_commit_links(
    conn: &rusqlite::Connection,
) -> Result<BTreeMap<i64, Vec<String>>, String> {
    if !table_exists(conn, "commit_lineage")? {
        return Ok(BTreeMap::new());
    }
    let mut stmt = conn
        .prepare("SELECT provenance_id, commit_id FROM commit_lineage ORDER BY created_at ASC")
        .map_err(|err| format!("Prepare failed: {}", err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("Query failed: {}", err))?;
    let mut links: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for row in rows {
        let (provenance_id, commit_sha) =
            row.map_err(|err| format!("Row decode failed: {}", err))?;
        links.entry(provenance_id).or_default().push(commit_sha);
    }
    Ok(links)
}

/// Stream the legacy trajectory schema without ever constructing a
/// session-sized `Vec<OrgtrackRawEvent>` or JSON string. Field order,
/// indentation, enum spelling and camelCase names intentionally match
/// `serde_json::to_string_pretty(OrgtrackSessionTrajectory)` byte-for-byte.
pub(super) fn write_session_trajectory<W: Write>(
    conn: &mut rusqlite::Connection,
    writer: &mut W,
    schema_version: u32,
    tier: OrgtrackTier,
    session_id: &str,
) -> Result<(), String> {
    let imported_id =
        crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
            session_id,
        );
    write_session_trajectory_with_imported_id(
        conn,
        writer,
        schema_version,
        tier,
        session_id,
        imported_id.as_deref(),
    )
}

fn write_session_trajectory_with_imported_id<W: Write>(
    conn: &mut rusqlite::Connection,
    writer: &mut W,
    schema_version: u32,
    tier: OrgtrackTier,
    session_id: &str,
    imported_id: Option<&str>,
) -> Result<(), String> {
    writer
        .write_all(b"{\n  \"schemaVersion\": ")
        .map_err(write_error)?;
    write_json(writer, &schema_version)?;
    writer.write_all(b",\n  \"tier\": ").map_err(write_error)?;
    write_json(writer, &tier)?;
    writer
        .write_all(b",\n  \"sessionId\": ")
        .map_err(write_error)?;
    write_json(writer, &session_id)?;
    writer
        .write_all(b",\n  \"rawEvents\": [")
        .map_err(write_error)?;

    let mut wrote_event = false;
    write_native_events(conn, writer, session_id, &mut wrote_event)?;
    write_native_code_session_chunks(conn, writer, session_id, &mut wrote_event)?;

    // Native-mode managed sessions persist no chunk rows. Their canonical
    // transcript remains in the CLI store, so stream its compact replay index
    // with a generation+revision pin and restore every deferred payload range.
    if let Some(imported_id) = imported_id {
        for_each_imported_replay_chunk(conn, imported_id, |replay_conn, generation, indexed| {
            write_imported_event(
                replay_conn,
                writer,
                imported_id,
                generation,
                indexed,
                &mut wrote_event,
            )
        })?;
    }

    if wrote_event {
        writer.write_all(b"\n  ]\n}").map_err(write_error)?;
    } else {
        writer.write_all(b"]\n}").map_err(write_error)?;
    }
    Ok(())
}

fn write_native_events<W: Write>(
    conn: &rusqlite::Connection,
    writer: &mut W,
    session_id: &str,
    wrote_event: &mut bool,
) -> Result<(), String> {
    if !table_exists(conn, "events")? {
        return Ok(());
    }
    let mut args_range = conn
        .prepare(
            "SELECT substr(CAST(args_json AS BLOB), ?2, ?3)
             FROM events WHERE rowid = ?1",
        )
        .map_err(|err| format!("Prepare event args range failed: {err}"))?;
    let mut result_range = conn
        .prepare(
            "SELECT substr(CAST(result_json AS BLOB), ?2, ?3)
             FROM events WHERE rowid = ?1",
        )
        .map_err(|err| format!("Prepare event result range failed: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT rowid, function_name,
                    length(CAST(args_json AS BLOB)),
                    length(CAST(result_json AS BLOB)),
                    history_sequence, created_at
             FROM events
             WHERE session_id = ?1
             ORDER BY COALESCE(history_sequence, 0) ASC, created_at ASC",
        )
        .map_err(|err| format!("Prepare events failed: {err}"))?;
    let mut rows = stmt
        .query([session_id])
        .map_err(|err| format!("Query events failed: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Read event row failed: {err}"))?
    {
        let rowid = row.get::<_, i64>(0).map_err(row_error)?;
        let name = row.get::<_, Option<String>>(1).map_err(row_error)?;
        let args_bytes = optional_length(row, 2)?;
        let result_bytes = optional_length(row, 3)?;
        let sequence = row.get::<_, Option<i64>>(4).map_err(row_error)?;
        let created_at = row.get::<_, Option<String>>(5).map_err(row_error)?;
        begin_raw_event(writer, wrote_event, "event", name.as_deref())?;
        write_sqlite_blob_json_string(writer, &mut args_range, rowid, args_bytes, "event args")?;
        writer
            .write_all(b",\n      \"resultJson\": ")
            .map_err(write_error)?;
        write_sqlite_blob_json_string(
            writer,
            &mut result_range,
            rowid,
            result_bytes,
            "event result",
        )?;
        finish_raw_event(writer, sequence, created_at.as_deref())?;
    }
    Ok(())
}

fn write_native_code_session_chunks<W: Write>(
    conn: &rusqlite::Connection,
    writer: &mut W,
    session_id: &str,
    wrote_event: &mut bool,
) -> Result<(), String> {
    if !table_exists(conn, "code_session_chunks")? {
        return Ok(());
    }
    let mut args_range = conn
        .prepare(
            "SELECT substr(CAST(args_json AS BLOB), ?2, ?3)
             FROM code_session_chunks WHERE rowid = ?1",
        )
        .map_err(|err| format!("Prepare code-session args range failed: {err}"))?;
    let mut result_range = conn
        .prepare(
            "SELECT substr(CAST(result_json AS BLOB), ?2, ?3)
             FROM code_session_chunks WHERE rowid = ?1",
        )
        .map_err(|err| format!("Prepare code-session result range failed: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT rowid, function,
                    length(CAST(args_json AS BLOB)),
                    length(CAST(result_json AS BLOB)),
                    sequence, created_at
             FROM code_session_chunks
             WHERE session_id = ?1
             ORDER BY sequence ASC",
        )
        .map_err(|err| format!("Prepare code-session chunks failed: {err}"))?;
    let mut rows = stmt
        .query([session_id])
        .map_err(|err| format!("Query code-session chunks failed: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Read code-session row failed: {err}"))?
    {
        let rowid = row.get::<_, i64>(0).map_err(row_error)?;
        let name = row.get::<_, Option<String>>(1).map_err(row_error)?;
        let args_bytes = optional_length(row, 2)?;
        let result_bytes = optional_length(row, 3)?;
        let sequence = row.get::<_, Option<i64>>(4).map_err(row_error)?;
        let created_at = row.get::<_, Option<String>>(5).map_err(row_error)?;
        begin_raw_event(writer, wrote_event, "code_session_chunk", name.as_deref())?;
        write_sqlite_blob_json_string(
            writer,
            &mut args_range,
            rowid,
            args_bytes,
            "code-session args",
        )?;
        writer
            .write_all(b",\n      \"resultJson\": ")
            .map_err(write_error)?;
        write_sqlite_blob_json_string(
            writer,
            &mut result_range,
            rowid,
            result_bytes,
            "code-session result",
        )?;
        finish_raw_event(writer, sequence, created_at.as_deref())?;
    }
    Ok(())
}

fn optional_length(row: &rusqlite::Row<'_>, index: usize) -> Result<Option<u64>, String> {
    row.get::<_, Option<i64>>(index)
        .map_err(row_error)
        .and_then(|length| match length {
            Some(length) if length < 0 => Err("SQLite reported a negative JSON length".to_string()),
            Some(length) => Ok(Some(length as u64)),
            None => Ok(None),
        })
}

fn write_sqlite_blob_json_string<W: Write>(
    writer: &mut W,
    range_stmt: &mut rusqlite::Statement<'_>,
    rowid: i64,
    total_bytes: Option<u64>,
    field_label: &str,
) -> Result<(), String> {
    let Some(total_bytes) = total_bytes else {
        return writer.write_all(b"null").map_err(write_error);
    };
    writer.write_all(b"\"").map_err(write_error)?;
    let mut offset = 0_u64;
    let mut pending_utf8 = Vec::with_capacity(4);
    while offset < total_bytes {
        let requested = (total_bytes - offset).min(TRAJECTORY_PAYLOAD_RANGE_BYTES as u64) as usize;
        let bytes = range_stmt
            .query_row(
                params![rowid, offset.saturating_add(1) as i64, requested as i64],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .map_err(|err| format!("Read {field_label} range failed: {err}"))?
            .unwrap_or_default();
        if bytes.len() != requested {
            return Err(format!(
                "{field_label} changed during trajectory export: expected {requested} bytes at offset {offset}, read {}",
                bytes.len()
            ));
        }
        offset = offset.saturating_add(bytes.len() as u64);
        if pending_utf8.is_empty() {
            write_utf8_json_content(writer, &bytes, &mut pending_utf8, field_label)?;
        } else {
            let mut joined = Vec::with_capacity(pending_utf8.len() + bytes.len());
            joined.extend_from_slice(&pending_utf8);
            joined.extend_from_slice(&bytes);
            pending_utf8.clear();
            write_utf8_json_content(writer, &joined, &mut pending_utf8, field_label)?;
        }
    }
    if !pending_utf8.is_empty() {
        return Err(format!("{field_label} ended with incomplete UTF-8"));
    }
    writer.write_all(b"\"").map_err(write_error)
}

fn write_utf8_json_content<W: Write>(
    writer: &mut W,
    bytes: &[u8],
    pending: &mut Vec<u8>,
    field_label: &str,
) -> Result<(), String> {
    match std::str::from_utf8(bytes) {
        Ok(text) => write_escaped_json_content(writer, text),
        Err(err) if err.error_len().is_none() => {
            let valid = err.valid_up_to();
            write_escaped_json_content(
                writer,
                std::str::from_utf8(&bytes[..valid]).map_err(|decode| decode.to_string())?,
            )?;
            pending.extend_from_slice(&bytes[valid..]);
            if pending.len() > 3 {
                return Err(format!("{field_label} contains invalid UTF-8"));
            }
            Ok(())
        }
        Err(err) => Err(format!("{field_label} contains invalid UTF-8: {err}")),
    }
}

fn write_imported_event<W: Write>(
    conn: &mut rusqlite::Connection,
    writer: &mut W,
    imported_session_id: &str,
    generation: &str,
    indexed: ReplayIndexedChunk,
    wrote_event: &mut bool,
) -> Result<(), String> {
    let source = ImportedHistorySourceId::from_session_id(imported_session_id)
        .ok_or_else(|| format!("Unknown imported transcript id: {imported_session_id}"))?;
    let ReplayIndexedChunk {
        sequence,
        chunk,
        payloads,
        ..
    } = indexed;
    begin_raw_event(
        writer,
        wrote_event,
        "code_session_chunk",
        Some(&chunk.function),
    )?;
    write_replay_value_json_string(
        conn,
        writer,
        source,
        imported_session_id,
        generation,
        &chunk.chunk_id,
        "args",
        &chunk.args,
        &payloads,
    )?;
    writer
        .write_all(b",\n      \"resultJson\": ")
        .map_err(write_error)?;
    write_replay_value_json_string(
        conn,
        writer,
        source,
        imported_session_id,
        generation,
        &chunk.chunk_id,
        "result",
        &chunk.result,
        &payloads,
    )?;
    finish_raw_event(writer, Some(sequence), Some(&chunk.created_at))
}

#[allow(clippy::too_many_arguments)]
fn write_replay_value_json_string<W: Write>(
    conn: &mut rusqlite::Connection,
    writer: &mut W,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    root: &str,
    value: &Value,
    payloads: &[ReplayPayloadDescriptor],
) -> Result<(), String> {
    writer.write_all(b"\"").map_err(write_error)?;
    write_value_inside_outer_json_string(
        conn, writer, source, session_id, generation, event_id, root, value, payloads,
    )?;
    writer.write_all(b"\"").map_err(write_error)
}

#[allow(clippy::too_many_arguments)]
fn write_value_inside_outer_json_string<W: Write>(
    conn: &mut rusqlite::Connection,
    writer: &mut W,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    path: &str,
    value: &Value,
    payloads: &[ReplayPayloadDescriptor],
) -> Result<(), String> {
    if let Some(payload) = payloads.iter().find(|payload| payload.field_path == path) {
        return match payload.resolved_encoding() {
            replay::ReplayPayloadEncoding::JsonValue => stream_replay_payload(
                conn, writer, source, session_id, generation, event_id, path, false,
            ),
            replay::ReplayPayloadEncoding::Utf8Text => {
                write_escaped_json_content(writer, "\"")?;
                stream_replay_payload(
                    conn, writer, source, session_id, generation, event_id, path, true,
                )?;
                write_escaped_json_content(writer, "\"")
            }
            replay::ReplayPayloadEncoding::LegacyPathInferred => {
                unreachable!("resolved replay payload encoding cannot remain legacy")
            }
        };
    }
    match value {
        Value::Null => write_escaped_json_content(writer, "null"),
        Value::Bool(value) => {
            write_escaped_json_content(writer, if *value { "true" } else { "false" })
        }
        Value::Number(value) => write_escaped_json_content(writer, &value.to_string()),
        Value::String(value) => write_inner_json_string(writer, value),
        Value::Array(values) => {
            write_escaped_json_content(writer, "[")?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    write_escaped_json_content(writer, ",")?;
                }
                write_value_inside_outer_json_string(
                    conn,
                    writer,
                    source,
                    session_id,
                    generation,
                    event_id,
                    &format!("{path}.{index}"),
                    value,
                    payloads,
                )?;
            }
            write_escaped_json_content(writer, "]")
        }
        Value::Object(values) => {
            write_escaped_json_content(writer, "{")?;
            let mut wrote_field = false;
            for (key, value) in values {
                if replay::is_compact_only_replay_field(key) {
                    continue;
                }
                if wrote_field {
                    write_escaped_json_content(writer, ",")?;
                }
                wrote_field = true;
                write_inner_json_string(writer, key)?;
                write_escaped_json_content(writer, ":")?;
                let child_path = format!("{path}.{key}");
                write_value_inside_outer_json_string(
                    conn,
                    writer,
                    source,
                    session_id,
                    generation,
                    event_id,
                    &child_path,
                    value,
                    payloads,
                )?;
            }
            write_escaped_json_content(writer, "}")
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn stream_replay_payload<W: Write>(
    conn: &mut rusqlite::Connection,
    writer: &mut W,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    nested_string: bool,
) -> Result<(), String> {
    let mut offset = 0_u64;
    loop {
        let range = replay::read_payload_range(
            conn,
            source,
            session_id,
            generation,
            event_id,
            field_path,
            offset,
            Some(TRAJECTORY_PAYLOAD_RANGE_BYTES),
        )?;
        if range.offset != offset {
            return Err(format!(
                "Replay payload {event_id}:{field_path} skipped from {offset} to {}",
                range.offset
            ));
        }
        if nested_string {
            write_double_escaped_json_content(writer, &range.text)?;
        } else {
            write_escaped_json_content(writer, &range.text)?;
        }
        if range.next_offset <= offset && !range.eof {
            return Err(format!(
                "Replay payload {event_id}:{field_path} made no progress at {offset}"
            ));
        }
        offset = range.next_offset;
        if range.eof {
            if offset != range.total_bytes {
                return Err(format!(
                    "Replay payload {event_id}:{field_path} ended at {offset}, expected {}",
                    range.total_bytes
                ));
            }
            break;
        }
    }
    Ok(())
}

fn begin_raw_event<W: Write>(
    writer: &mut W,
    wrote_event: &mut bool,
    source: &str,
    name: Option<&str>,
) -> Result<(), String> {
    if *wrote_event {
        writer.write_all(b",\n").map_err(write_error)?;
    } else {
        writer.write_all(b"\n").map_err(write_error)?;
        *wrote_event = true;
    }
    writer
        .write_all(b"    {\n      \"source\": ")
        .map_err(write_error)?;
    write_json(writer, &source)?;
    writer
        .write_all(b",\n      \"name\": ")
        .map_err(write_error)?;
    write_json(writer, &name)?;
    writer
        .write_all(b",\n      \"argsJson\": ")
        .map_err(write_error)
}

fn finish_raw_event<W: Write>(
    writer: &mut W,
    sequence: Option<i64>,
    created_at: Option<&str>,
) -> Result<(), String> {
    writer
        .write_all(b",\n      \"sequence\": ")
        .map_err(write_error)?;
    write_json(writer, &sequence)?;
    writer
        .write_all(b",\n      \"createdAt\": ")
        .map_err(write_error)?;
    write_json(writer, &created_at)?;
    writer.write_all(b"\n    }").map_err(write_error)
}

fn write_inner_json_string<W: Write>(writer: &mut W, text: &str) -> Result<(), String> {
    write_escaped_json_content(writer, "\"")?;
    write_double_escaped_json_content(writer, text)?;
    write_escaped_json_content(writer, "\"")
}

fn write_double_escaped_json_content<W: Write>(writer: &mut W, text: &str) -> Result<(), String> {
    let mut plain_start = 0_usize;
    for (index, character) in text.char_indices() {
        if !needs_json_escape(character) {
            continue;
        }
        if plain_start < index {
            writer
                .write_all(&text.as_bytes()[plain_start..index])
                .map_err(write_error)?;
        }
        let mut encoded = [0_u8; 4];
        let mut control = [0_u8; 6];
        let fragment = json_escape_fragment(character, &mut encoded, &mut control);
        write_escaped_json_content(writer, fragment)?;
        plain_start = index + character.len_utf8();
    }
    if plain_start < text.len() {
        writer
            .write_all(&text.as_bytes()[plain_start..])
            .map_err(write_error)?;
    }
    Ok(())
}

fn write_escaped_json_content<W: Write>(writer: &mut W, text: &str) -> Result<(), String> {
    let mut plain_start = 0_usize;
    for (index, character) in text.char_indices() {
        if !needs_json_escape(character) {
            continue;
        }
        if plain_start < index {
            writer
                .write_all(&text.as_bytes()[plain_start..index])
                .map_err(write_error)?;
        }
        let mut encoded = [0_u8; 4];
        let mut control = [0_u8; 6];
        writer
            .write_all(json_escape_fragment(character, &mut encoded, &mut control).as_bytes())
            .map_err(write_error)?;
        plain_start = index + character.len_utf8();
    }
    if plain_start < text.len() {
        writer
            .write_all(&text.as_bytes()[plain_start..])
            .map_err(write_error)?;
    }
    Ok(())
}

fn needs_json_escape(character: char) -> bool {
    matches!(
        character,
        '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t'
    ) || character <= '\u{1f}'
}

fn json_escape_fragment<'a>(
    character: char,
    encoded: &'a mut [u8; 4],
    control: &'a mut [u8; 6],
) -> &'a str {
    match character {
        '"' => "\\\"",
        '\\' => "\\\\",
        '\u{08}' => "\\b",
        '\u{0c}' => "\\f",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        character if character <= '\u{1f}' => {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            let value = character as usize;
            *control = [b'\\', b'u', b'0', b'0', HEX[value >> 4], HEX[value & 0x0f]];
            // The array is constructed from ASCII bytes only.
            std::str::from_utf8(control).expect("ASCII JSON escape")
        }
        character => character.encode_utf8(encoded),
    }
}

fn write_json<W: Write>(writer: &mut W, value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(writer, value)
        .map_err(|err| format!("Serialize trajectory failed: {err}"))
}

fn write_error(err: std::io::Error) -> String {
    format!("Write trajectory failed: {err}")
}

fn row_error(err: rusqlite::Error) -> String {
    format!("Decode trajectory row failed: {err}")
}

fn for_each_imported_replay_chunk(
    conn: &mut rusqlite::Connection,
    imported_session_id: &str,
    mut visit: impl FnMut(&mut rusqlite::Connection, &str, ReplayIndexedChunk) -> Result<(), String>,
) -> Result<(), String> {
    let source = ImportedHistorySourceId::from_session_id(imported_session_id)
        .ok_or_else(|| format!("Unknown imported transcript id: {imported_session_id}"))?;
    let limits = ReplayLimits {
        max_turns: replay::HARD_MAX_TURNS,
        max_events: replay::HARD_MAX_EVENTS,
        max_ipc_bytes: replay::HARD_MAX_IPC_BYTES,
    };
    let prepared = {
        // Synchronization and lazy-turn materialization can write the compact
        // replay index, so keep only that preparation under the process-wide
        // writer lock. The potentially long export below is read-only.
        let _writer = database::db::sessions_writer_guard();
        replay::prepare_pinned_scan(conn, source, imported_session_id, limits)?
    };
    let generation = prepared.generation;
    let revision = prepared.revision;
    if let Some(mut read_conn) = open_export_read_connection(conn)? {
        visit_pinned_replay_chunks(
            &mut read_conn,
            source,
            imported_session_id,
            &generation,
            revision,
            limits,
            &mut visit,
        )?;
    } else {
        // In-memory SQLite is used by unit tests and has no second connection
        // target. It still runs outside the writer guard.
        visit_pinned_replay_chunks(
            conn,
            source,
            imported_session_id,
            &generation,
            revision,
            limits,
            &mut visit,
        )?;
    }

    // Re-synchronize briefly after every payload range has been emitted. A
    // generation or same-generation revision change rejects the UUID temp
    // before the caller publishes it, without blocking unrelated writers
    // during the streamed file I/O.
    let final_scan = {
        let _writer = database::db::sessions_writer_guard();
        replay::scan_window_after(conn, source, imported_session_id, i64::MAX, limits)?
    };
    validate_pinned_replay_cursor(
        imported_session_id,
        &generation,
        revision,
        &final_scan.cursor,
    )?;
    if final_scan.has_more || !final_scan.chunks.is_empty() {
        return Err(format!(
            "Imported transcript grew after the pinned trajectory scan: {imported_session_id}"
        ));
    }
    Ok(())
}

fn open_export_read_connection(
    conn: &rusqlite::Connection,
) -> Result<Option<rusqlite::Connection>, String> {
    let Some(path) = conn.path().filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let read_conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_URI
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("Open replay export read connection failed: {err}"))?;
    read_conn
        .busy_timeout(std::time::Duration::from_secs(15))
        .map_err(|err| format!("Configure replay export read connection failed: {err}"))?;
    Ok(Some(read_conn))
}

#[allow(
    clippy::too_many_arguments,
    reason = "Pinned replay scan keeps the immutable source identity and bounded visitor explicit"
)]
fn visit_pinned_replay_chunks(
    conn: &mut rusqlite::Connection,
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    generation: &str,
    revision: u64,
    limits: ReplayLimits,
    visit: &mut impl FnMut(&mut rusqlite::Connection, &str, ReplayIndexedChunk) -> Result<(), String>,
) -> Result<(), String> {
    let mut after_sequence = -1_i64;
    loop {
        let batch = replay::scan_window_after_generation(
            conn,
            source,
            imported_session_id,
            generation,
            revision,
            after_sequence,
            limits,
        )?;
        if batch.chunks.is_empty()
            && batch.has_more
            && batch.cursor.through_sequence <= after_sequence
        {
            return Err(format!(
                "Bounded replay scan made no progress for {imported_session_id} after sequence {after_sequence}"
            ));
        }
        let next_sequence = batch.cursor.through_sequence;
        for indexed in batch.chunks {
            visit(conn, generation, indexed)?;
        }
        after_sequence = next_sequence;
        if !batch.has_more {
            break;
        }
    }
    Ok(())
}

fn validate_pinned_replay_cursor(
    imported_session_id: &str,
    expected_generation: &str,
    expected_revision: u64,
    cursor: &ReplayCursor,
) -> Result<(), String> {
    if cursor.generation != expected_generation || cursor.revision != expected_revision {
        return Err(format!(
            "Imported transcript changed during trajectory export: expected {expected_generation}@{expected_revision}, found {}@{} for {imported_session_id}",
            cursor.generation, cursor.revision
        ));
    }
    Ok(())
}

pub(super) fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|err| format!("Failed to inspect table {}: {}", table, err))
}

pub(super) fn table_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<BTreeMap<String, usize>, String> {
    if !table_exists(conn, table)? {
        return Ok(BTreeMap::new());
    }
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|err| format!("Failed to inspect {}: {}", table, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, usize>(0)?))
        })
        .map_err(|err| format!("Failed to inspect {}: {}", table, err))?;
    let mut columns = BTreeMap::new();
    for row in rows {
        let (name, index) = row.map_err(|err| format!("Failed to inspect {}: {}", table, err))?;
        columns.insert(name, index);
    }
    Ok(columns)
}

fn get_optional_column(
    row: &rusqlite::Row<'_>,
    columns: &BTreeMap<String, usize>,
    column: &str,
) -> rusqlite::Result<Option<String>> {
    let Some(index) = columns.get(column) else {
        return Ok(None);
    };
    row.get(*index)
}

#[cfg(test)]
#[path = "loaders/tests.rs"]
mod tests;
