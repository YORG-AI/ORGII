//! SQLite readers for the export inputs: provenance rows, local edit events,
//! sessions, commit links, and raw trajectory events, plus schema introspection.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::params;

use super::file_paths::{
    extract_file_paths_from_json, is_file_edit_function, path_belongs_to_repo,
};
use super::{LocalEditRow, ProvenanceRow, SessionRow};
use crate::orgtrack::types::{OrgtrackRawEvent, OrgtrackRawEventSource};

pub(super) fn load_local_edit_rows(
    conn: &rusqlite::Connection,
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
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in mapped {
            let (event_id, session_id, function_name, args_json, result_json, created_at) =
                row.map_err(|err| format!("Row decode failed: {}", err))?;
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
    }

    if table_exists(conn, "code_session_chunks")? {
        let mut stmt = conn
            .prepare(
                "SELECT chunk_id, session_id, function, args_json, result_json, created_at
                 FROM code_session_chunks
                 ORDER BY sequence ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in mapped {
            let (event_id, session_id, function_name, args_json, result_json, created_at) =
                row.map_err(|err| format!("Row decode failed: {}", err))?;
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
            let Ok(Some(chunks)) =
                orgtrack_core::sources::imported_history::load_activity_chunks_for_session(
                    conn,
                    &imported_id,
                )
            else {
                continue;
            };
            for chunk in chunks {
                if !is_file_edit_function(&chunk.function) {
                    continue;
                }
                let args_json = chunk.args.to_string();
                let result_json = chunk.result.to_string();
                for file_path in
                    extract_file_paths_from_json(&chunk.function, &args_json, &result_json)
                {
                    if path_belongs_to_repo(conn, repo_path, &session_id, &file_path)? {
                        rows.push(LocalEditRow {
                            event_id: chunk.chunk_id.clone(),
                            session_id: session_id.clone(),
                            file_path,
                            function_name: Some(chunk.function.clone()),
                            created_at: parse_timestamp(&chunk.created_at),
                        });
                    }
                }
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

pub(super) fn load_raw_events(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<OrgtrackRawEvent>, String> {
    let mut raw_events = Vec::new();
    if table_exists(conn, "events")? {
        let mut stmt = conn
            .prepare(
                "SELECT function_name, args_json, result_json, history_sequence, created_at
                 FROM events
                 WHERE session_id = ?1
                 ORDER BY COALESCE(history_sequence, 0) ASC, created_at ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok(OrgtrackRawEvent {
                    source: OrgtrackRawEventSource::Event,
                    name: row.get(0)?,
                    args_json: row.get(1)?,
                    result_json: row.get(2)?,
                    sequence: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in rows {
            raw_events.push(row.map_err(|err| format!("Row decode failed: {}", err))?);
        }
    }
    if table_exists(conn, "code_session_chunks")? {
        let mut stmt = conn
            .prepare(
                "SELECT function, args_json, result_json, sequence, created_at
                 FROM code_session_chunks
                 WHERE session_id = ?1
                 ORDER BY sequence ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok(OrgtrackRawEvent {
                    source: OrgtrackRawEventSource::CodeSessionChunk,
                    name: row.get(0)?,
                    args_json: row.get(1)?,
                    result_json: row.get(2)?,
                    sequence: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in rows {
            raw_events.push(row.map_err(|err| format!("Row decode failed: {}", err))?);
        }
    }
    // Native-mode managed sessions persist no chunk rows — replay the
    // imported transcript into the same raw-event shape so exported
    // trajectories stay complete.
    if let Some(imported_id) =
        crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
            session_id,
        )
    {
        if let Some(chunks) =
            orgtrack_core::sources::imported_history::load_activity_chunks_for_session(
                conn,
                &imported_id,
            )?
        {
            for (index, chunk) in chunks.into_iter().enumerate() {
                raw_events.push(OrgtrackRawEvent {
                    source: OrgtrackRawEventSource::CodeSessionChunk,
                    name: Some(chunk.function),
                    args_json: Some(chunk.args.to_string()),
                    result_json: Some(chunk.result.to_string()),
                    sequence: Some(index as i64),
                    created_at: Some(chunk.created_at),
                });
            }
        }
    }
    Ok(raw_events)
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
