//! Codex session discovery, indexing, and cache sync.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, Transaction};
use serde::Deserialize;
use serde_json::Value;

use crate::sources::codex::{canonical_session_id, SESSION_PREFIX as CODEX_APP_SESSION_PREFIX};
use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryDiscoveredRecord, ImportedHistoryRecordSignature, SOURCE_CODEX_APP},
    paths as imported_paths, scan_snapshot,
};
use crate::store::{sqlite::SqliteRecordStore, RecordStore};

use super::meta::resolve_codex_transcript_for_thread_id_near_path;
use super::transcript::load_codex_app_from_path;
use super::{
    CodexAppRecentPath, CodexAppSessionPage, CodexAppSourceMetadata,
    CODEX_APP_METADATA_PARSER_VERSION,
};

#[derive(Debug, Clone)]
struct CodexSessionIndexEntry {
    thread_name: String,
    updated_at: Option<String>,
}

#[derive(Debug)]
struct DiscoveredCodexCatalogRecord {
    record: ImportedHistoryDiscoveredRecord,
    /// Codex's own session index is the authoritative source for a root
    /// thread's display title. Keep it separate from the discovery
    /// fingerprint so catalog repair never has to reverse-parse an opaque
    /// signature string.
    authoritative_title: Option<String>,
}

#[derive(Debug)]
struct CachedCodexCatalogTitle {
    name: String,
    source_record_key: String,
    session_id: String,
    signature: ImportedHistoryRecordSignature,
    verified_title_signature: Option<String>,
}

#[derive(Debug)]
struct ReplayAppliedTitleOwnership {
    applied_name: String,
}

const CODEX_TITLE_REPAIR_SIGNATURE_FIELD: &str = "_codexTitleRepairSignature";

#[derive(Debug, Deserialize)]
struct CodexSessionIndexLine {
    #[serde(default)]
    id: String,
    #[serde(default)]
    thread_name: String,
    #[serde(default)]
    updated_at: Option<String>,
}

pub fn list_codex_app_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CodexAppSessionPage, String> {
    refresh_codex_app_catalog(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CODEX_APP, limit, offset)
}

pub fn list_codex_app_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<CodexAppRecentPath>, String> {
    refresh_codex_app_catalog(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CODEX_APP, limit)
}

pub fn list_codex_app_reconciliation_sessions(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<imported_cache::ImportedHistoryCachedSession>, String> {
    refresh_codex_app_catalog(conn)?;
    imported_cache::query_recent_cached_sessions_for_source_from_conn(conn, SOURCE_CODEX_APP, limit)
}

pub fn load_codex_app_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = codex_file_stem_from_session_id(session_id)?;
    let path = resolve_codex_session_path(conn, file_stem)?;
    let mut chunks = load_codex_app_from_path(session_id, &path)?;
    link_codex_subagent_chunks(conn, session_id, &mut chunks)?;
    Ok(chunks)
}

#[derive(Debug, Clone)]
struct CodexChildSessionLink {
    session_id: String,
    thread_id: Option<String>,
    created_at_ms: i64,
    metadata: CodexAppSourceMetadata,
}

fn link_codex_subagent_chunks(
    conn: &Connection,
    parent_session_id: &str,
    chunks: &mut [ActivityChunk],
) -> Result<(), String> {
    let mut children = codex_child_session_links(conn, parent_session_id)?;
    link_codex_subagent_chunks_from_children(chunks, &mut children);
    Ok(())
}

fn codex_child_session_links(
    conn: &Connection,
    parent_session_id: &str,
) -> Result<Vec<CodexChildSessionLink>, String> {
    let mut statement = conn
        .prepare(
            "SELECT session_id, source_session_id, created_at_ms, source_metadata_json
             FROM imported_history_session_cache
             WHERE source = ?1
               AND parent_session_id = ?2
               AND parent_session_id != ''
             ORDER BY created_at_ms ASC, source_session_id ASC",
        )
        .map_err(|err| format!("Failed to prepare Codex child-session query: {err}"))?;
    let rows = statement
        .query_map([SOURCE_CODEX_APP, parent_session_id], |row| {
            let source_session_id: String = row.get(1)?;
            let metadata_json: String = row.get(3)?;
            Ok(CodexChildSessionLink {
                session_id: row.get(0)?,
                thread_id: codex_thread_id_from_file_stem(&source_session_id).map(str::to_string),
                created_at_ms: row.get(2)?,
                metadata: serde_json::from_str(&metadata_json).unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to query Codex child sessions: {err}"))?;

    let mut children = Vec::new();
    for row in rows {
        children.push(row.map_err(|err| format!("Failed to read Codex child-session row: {err}"))?);
    }
    Ok(children)
}

fn link_codex_subagent_chunks_from_children(
    chunks: &mut [ActivityChunk],
    children: &mut Vec<CodexChildSessionLink>,
) {
    for chunk in chunks
        .iter_mut()
        .filter(|chunk| chunk.function == "subagent")
    {
        if chunk
            .args
            .get("subagentSessionId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            continue;
        }
        let task_name = chunk
            .args
            .get("task_name")
            .or_else(|| chunk.args.get("taskName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let agent_thread_id = chunk
            .args
            .get("codexAgentThreadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let chunk_created_at_ms = imported_history::parse_iso_to_epoch_ms_opt(&chunk.created_at);
        let Some(child_index) =
            best_codex_child_match(children, agent_thread_id, task_name, chunk_created_at_ms)
        else {
            continue;
        };
        let child = children.remove(child_index);
        let Some(args) = chunk.args.as_object_mut() else {
            continue;
        };
        args.insert(
            "subagentSessionId".to_string(),
            Value::String(child.session_id),
        );
        args.entry("action".to_string())
            .or_insert_with(|| Value::String("delegate".to_string()));
        if let Some(prompt) = child
            .metadata
            .first_prompt
            .filter(|value| !value.trim().is_empty())
        {
            args.entry("prompt".to_string())
                .or_insert_with(|| Value::String(prompt));
        }
        if let Some(nickname) = child
            .metadata
            .agent_nickname
            .filter(|value| !value.trim().is_empty())
        {
            args.entry("subagent_type".to_string())
                .or_insert_with(|| Value::String(nickname));
        }
    }
}

fn best_codex_child_match(
    children: &[CodexChildSessionLink],
    agent_thread_id: Option<&str>,
    task_name: Option<&str>,
    chunk_created_at_ms: Option<i64>,
) -> Option<usize> {
    children
        .iter()
        .enumerate()
        .min_by_key(|(_, child)| {
            let thread_mismatch = agent_thread_id
                .is_some_and(|thread_id| child.thread_id.as_deref() != Some(thread_id));
            let task_mismatch = task_name.is_some_and(|task_name| {
                child
                    .metadata
                    .agent_path
                    .as_deref()
                    .and_then(|path| path.rsplit('/').next())
                    != Some(task_name)
            });
            let time_distance = chunk_created_at_ms
                .map(|created_at_ms| created_at_ms.abs_diff(child.created_at_ms))
                .unwrap_or_default();
            (thread_mismatch, task_mismatch, time_distance)
        })
        .map(|(index, _)| index)
}

pub(crate) fn refresh_catalog(conn: &mut Connection) -> Result<(), String> {
    refresh_codex_app_catalog(conn)
}

fn refresh_codex_app_catalog(conn: &mut Connection) -> Result<(), String> {
    let previous_snapshots = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_CODEX_APP);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous_snapshots, "jsonl", "Codex");
    let mut discovered = discover_codex_app_records(&codex_sessions_dirs()?, &mut walker)?;
    let next_snapshots = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(
        conn,
        SOURCE_CODEX_APP,
        &previous_snapshots,
        &next_snapshots,
    )?;
    let managed_ids =
        crate::sources::imported_history::managed_mirror::managed_source_session_ids_from_conn(
            conn,
            "codex",
            SOURCE_CODEX_APP,
        )?;
    for discovered_record in &mut discovered {
        crate::sources::imported_history::managed_mirror::append_managed_fingerprint(
            &mut discovered_record.record.source_fingerprint,
            crate::sources::imported_history::managed_mirror::is_managed_source_session_id(
                &managed_ids,
                &discovered_record.record.source_session_id,
            ),
        );
    }
    repair_codex_catalog_titles(conn, &discovered)?;
    let signatures = discovered
        .iter()
        .map(|record| record.record.signature())
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_CODEX_APP, &discovered, |record| {
            record.record.signature()
        })?;
    let mut inputs = Vec::new();
    for discovered_record in changed {
        let record = &discovered_record.record;
        let is_managed =
            crate::sources::imported_history::managed_mirror::is_managed_source_session_id(
                &managed_ids,
                &record.source_session_id,
            );
        // Growth of an existing rollout only advances the compact catalog
        // signature. Its body is indexed incrementally by bounded replay when
        // the session is visible/active; sidebar refresh never starts over.
        if imported_cache::advance_cached_catalog_record_from_conn(
            conn,
            SOURCE_CODEX_APP,
            record,
            Some(!is_managed),
        )? {
            continue;
        }
        if let Some(mut input) = super::meta::parse_codex_catalog_input_with_title(
            record,
            discovered_record.authoritative_title.as_deref(),
        )? {
            input.listable = !is_managed;
            inputs.push(input);
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CODEX_APP,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

/// Reassert Codex-owned title precedence without hydrating transcripts.
///
/// Older replay cursors treated every payload `name` as a session title, so
/// an active session could be renamed from its session-index title to
/// `update_plan`, then to `js`, on successive polls. The derivation baseline
/// is not sufficient to undo that damage because an already-polluted title
/// can itself become the next baseline. Discovery has stronger provenance:
/// use the session index unconditionally, and only inspect the bounded JSONL
/// prefix when a legacy replay-owned title has no index entry.
fn repair_codex_catalog_titles(
    conn: &mut Connection,
    discovered: &[DiscoveredCodexCatalogRecord],
) -> Result<(), String> {
    let cached = load_cached_codex_catalog_titles(conn)?;
    let replay_applied_names = load_current_replay_applied_names(conn, &cached)?;
    let mut repairs = Vec::new();
    let mut verified_replay_titles = Vec::new();

    for discovered_record in discovered {
        let source_session_id = &discovered_record.record.source_session_id;
        let Some(current) = cached.get(source_session_id) else {
            continue;
        };
        let discovered_signature = discovered_record.record.signature();
        let title_repair_signature = codex_title_repair_signature(&discovered_signature);
        let desired =
            if let Some(authoritative_title) = discovered_record.authoritative_title.as_deref() {
                Some(authoritative_title.to_string())
            } else {
                let signature_changed = !imported_cache::record_matches_cached_signature(
                    &current.signature,
                    &discovered_signature,
                );
                let placeholder = is_codex_catalog_placeholder(current, source_session_id);
                let already_neutral = current.name.trim() == "Untitled";
                let replay_polluted =
                    replay_applied_names
                        .get(source_session_id)
                        .is_some_and(|ownership| {
                            ownership.applied_name == current.name.trim()
                                && current.verified_title_signature.as_deref()
                                    != Some(title_repair_signature.as_str())
                        });
                if replay_polluted || placeholder && (!already_neutral || signature_changed) {
                    let parsed = super::meta::parse_codex_catalog_input_with_title(
                        &discovered_record.record,
                        None,
                    )?
                    .map(|input| input.name);
                    if replay_polluted {
                        // The replay derivation can legitimately have selected
                        // the same first-user title that discovery now verifies.
                        // Record the physical source signature so an unchanged
                        // sidebar refresh does not reopen the JSONL prefix on
                        // every pass. A replace/append/parser upgrade changes the
                        // signature and intentionally re-enables verification.
                        verified_replay_titles
                            .push((source_session_id.clone(), title_repair_signature));
                    }
                    parsed
                } else {
                    None
                }
            };
        if let Some(desired) = desired.filter(|desired| desired.trim() != current.name.trim()) {
            repairs.push((source_session_id.clone(), desired));
        }
    }

    if repairs.is_empty() && verified_replay_titles.is_empty() {
        return Ok(());
    }
    let tx = conn
        .transaction()
        .map_err(|err| format!("start Codex catalog-title repair: {err}"))?;
    for (source_session_id, desired) in repairs {
        tx.execute(
            "UPDATE imported_history_session_cache
             SET name=?2, updated_at=?3
             WHERE source='codex_app' AND source_session_id=?1",
            (source_session_id, desired, chrono::Utc::now().to_rfc3339()),
        )
        .map_err(|err| format!("restore Codex catalog title: {err}"))?;
    }
    for (source_session_id, signature) in verified_replay_titles {
        mark_codex_replay_title_verified(&tx, &source_session_id, &signature)?;
    }
    tx.commit()
        .map_err(|err| format!("commit Codex catalog-title repair: {err}"))
}

fn codex_title_repair_signature(signature: &ImportedHistoryRecordSignature) -> String {
    serde_json::json!([
        signature.source_path,
        signature.source_mtime_ms,
        signature.source_size_bytes,
        signature.source_fingerprint,
        signature.parser_version
    ])
    .to_string()
}

fn mark_codex_replay_title_verified(
    tx: &Transaction<'_>,
    source_session_id: &str,
    signature: &str,
) -> Result<(), String> {
    let source_metadata_json = tx
        .query_row(
            "SELECT source_metadata_json
             FROM imported_history_session_cache
             WHERE source='codex_app' AND source_session_id=?1",
            [source_session_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("read Codex replay-title verification state: {err}"))?;
    let mut source_metadata = serde_json::from_str::<Value>(&source_metadata_json)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    source_metadata.insert(
        CODEX_TITLE_REPAIR_SIGNATURE_FIELD.to_string(),
        Value::String(signature.to_string()),
    );
    tx.execute(
        "UPDATE imported_history_session_cache
         SET source_metadata_json=?2, updated_at=?3
         WHERE source='codex_app' AND source_session_id=?1",
        (
            source_session_id,
            Value::Object(source_metadata).to_string(),
            chrono::Utc::now().to_rfc3339(),
        ),
    )
    .map(|_| ())
    .map_err(|err| format!("store Codex replay-title verification state: {err}"))
}

fn load_cached_codex_catalog_titles(
    conn: &Connection,
) -> Result<HashMap<String, CachedCodexCatalogTitle>, String> {
    let mut statement = conn
        .prepare(
            "SELECT source_session_id,name,source_record_key,session_id,
                    source_path,source_mtime_ms,source_size_bytes,
                    source_fingerprint,parser_version,source_metadata_json
             FROM imported_history_session_cache
             WHERE source='codex_app'",
        )
        .map_err(|err| format!("prepare cached Codex title query: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            let source_session_id = row.get::<_, String>(0)?;
            let source_metadata_json = row.get::<_, String>(9)?;
            let verified_title_signature = serde_json::from_str::<Value>(&source_metadata_json)
                .ok()
                .and_then(|value| {
                    value
                        .get(CODEX_TITLE_REPAIR_SIGNATURE_FIELD)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            Ok((
                source_session_id.clone(),
                CachedCodexCatalogTitle {
                    name: row.get(1)?,
                    source_record_key: row.get(2)?,
                    session_id: row.get(3)?,
                    signature: ImportedHistoryRecordSignature {
                        source_session_id,
                        source_path: row.get(4)?,
                        source_mtime_ms: row.get(5)?,
                        source_size_bytes: row.get(6)?,
                        source_fingerprint: row.get(7)?,
                        parser_version: row.get(8)?,
                    },
                    verified_title_signature,
                },
            ))
        })
        .map_err(|err| format!("query cached Codex titles: {err}"))?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|err| format!("read cached Codex titles: {err}"))
}

fn load_current_replay_applied_names(
    conn: &Connection,
    cached: &HashMap<String, CachedCodexCatalogTitle>,
) -> Result<HashMap<String, ReplayAppliedTitleOwnership>, String> {
    let mut statement = conn
        .prepare(
            "SELECT source_session_id,applied_json
             FROM imported_replay_catalog_derivations
             WHERE source='codex_app'",
        )
        .map_err(|err| format!("prepare Codex replay-title ownership query: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("query Codex replay-title ownership: {err}"))?;
    let mut applied_names = HashMap::new();
    for row in rows {
        let (source_session_id, applied_json) =
            row.map_err(|err| format!("read Codex replay-title ownership: {err}"))?;
        let Some(current) = cached.get(&source_session_id) else {
            continue;
        };
        let applied = serde_json::from_str::<Value>(&applied_json).ok();
        let applied_name = applied
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if applied_name.as_deref() == Some(current.name.trim()) {
            applied_names.insert(
                source_session_id,
                ReplayAppliedTitleOwnership {
                    applied_name: current.name.trim().to_string(),
                },
            );
        }
    }
    Ok(applied_names)
}

fn is_codex_catalog_placeholder(cached: &CachedCodexCatalogTitle, source_session_id: &str) -> bool {
    let name = cached.name.trim();
    name.is_empty()
        || name == cached.source_record_key
        || name == source_session_id
        || name == cached.session_id
        || matches!(name, "New Agent" | "Untitled")
}

fn discover_codex_app_records(
    sessions_dirs: &[PathBuf],
    walker: &mut scan_snapshot::SnapshotDirWalker<'_>,
) -> Result<Vec<DiscoveredCodexCatalogRecord>, String> {
    let mut sessions = Vec::new();
    for sessions_dir in sessions_dirs {
        if sessions_dir.is_dir() {
            let title_index = load_codex_session_index_for_sessions_dir(sessions_dir)?;
            let mut files = Vec::new();
            walker.collect_files(sessions_dir, &mut files)?;
            for path in files {
                let Some(file_stem) = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(ToString::to_string)
                else {
                    continue;
                };
                let (source_mtime_ms, source_size_bytes) =
                    imported_paths::file_metadata_signature(&path, "Codex")?;
                let source_fingerprint = codex_source_fingerprint(&file_stem, &title_index);
                let authoritative_title = codex_title_entry_for_file_stem(&file_stem, &title_index)
                    .map(|entry| imported_history::truncate_name(entry.thread_name.trim(), 200));
                sessions.push(DiscoveredCodexCatalogRecord {
                    record: ImportedHistoryDiscoveredRecord {
                        source_session_id: file_stem.clone(),
                        source_path: path,
                        source_record_key: file_stem,
                        source_mtime_ms,
                        source_size_bytes,
                        source_fingerprint,
                        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
                    },
                    authoritative_title,
                });
            }
        }
    }
    Ok(sessions)
}

pub(super) fn collect_codex_session_files(
    dir: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Codex dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Codex dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_codex_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            out.push(path);
        }
    }
    Ok(())
}

fn load_codex_session_index_for_sessions_dir(
    sessions_dir: &Path,
) -> Result<HashMap<String, CodexSessionIndexEntry>, String> {
    let Some(root) = sessions_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_codex_session_index(&root.join("session_index.jsonl"))
}

fn load_codex_session_index(
    index_path: &Path,
) -> Result<HashMap<String, CodexSessionIndexEntry>, String> {
    let mut entries = HashMap::new();
    if !index_path.is_file() {
        return Ok(entries);
    }

    let file = fs::File::open(index_path).map_err(|err| {
        format!(
            "Failed to open Codex session index {}: {err}",
            index_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line.map_err(|err| {
            format!(
                "Failed to read Codex session index {}: {err}",
                index_path.display()
            )
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexSessionIndexLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let id = parsed.id.trim();
        let thread_name = parsed.thread_name.trim();
        if id.is_empty() || thread_name.is_empty() {
            continue;
        }
        entries.insert(
            id.to_string(),
            CodexSessionIndexEntry {
                thread_name: thread_name.to_string(),
                updated_at: parsed.updated_at,
            },
        );
    }

    Ok(entries)
}

fn codex_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, CodexSessionIndexEntry>,
) -> String {
    codex_title_entry_for_file_stem(file_stem, title_index)
        .map(|entry| {
            format!(
                "session-index:{}:{}",
                entry.updated_at.as_deref().unwrap_or_default(),
                entry.thread_name
            )
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub(super) fn codex_session_index_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(index_path) = codex_index_path_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_codex_session_index(&index_path)?;
    Ok(
        codex_title_entry_for_file_stem(&record.source_record_key, &title_index)
            .map(|entry| imported_history::truncate_name(&entry.thread_name, 200))
            .unwrap_or_default(),
    )
}

#[cfg(test)]
fn codex_index_path_for_session_path(session_path: &Path) -> Option<PathBuf> {
    codex_sessions_dir_for_session_path(session_path).and_then(|sessions_dir| {
        sessions_dir
            .parent()
            .map(|root| root.join("session_index.jsonl"))
    })
}

pub(super) fn codex_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path
        .ancestors()
        .find(|ancestor| ancestor.file_name().and_then(|name| name.to_str()) == Some("sessions"))
        .map(Path::to_path_buf)
}

fn codex_title_entry_for_file_stem<'a>(
    file_stem: &str,
    title_index: &'a HashMap<String, CodexSessionIndexEntry>,
) -> Option<&'a CodexSessionIndexEntry> {
    codex_thread_id_from_file_stem(file_stem).and_then(|thread_id| title_index.get(thread_id))
}

pub fn codex_thread_id_from_file_stem(file_stem: &str) -> Option<&str> {
    if is_uuid_like(file_stem) {
        return Some(file_stem);
    }
    if file_stem.len() < 36 {
        return None;
    }
    let candidate = &file_stem[file_stem.len() - 36..];
    is_uuid_like(candidate).then_some(candidate)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

fn codex_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CODEX_APP_SESSION_PREFIX) else {
        return Err(format!("Invalid Codex app session id: {session_id}"));
    };
    if file_stem.is_empty() {
        return Err("Codex app session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

fn resolve_codex_session_path(conn: &Connection, file_stem: &str) -> Result<PathBuf, String> {
    let transcript_session_id = canonical_session_id(file_stem);
    let store = SqliteRecordStore::new(conn);
    if let Some(path) = store
        .get_session_actor_by_transcript_session_id(SOURCE_CODEX_APP, &transcript_session_id)?
        .and_then(|actor| actor.transcript_path)
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    // The lifecycle record stores the stable parent thread UUID plus the
    // child's concrete transcript path. That is enough to rediscover the
    // parent's rollout even when CODEX_HOME is outside the standard roots.
    for actor in store.list_session_actors(SOURCE_CODEX_APP, &transcript_session_id)? {
        let Some(reference_path) = actor.transcript_path.as_deref() else {
            continue;
        };
        let Some(locator) = resolve_codex_transcript_for_thread_id_near_path(
            Path::new(reference_path),
            &actor.source_session_id,
        )?
        else {
            continue;
        };
        if locator.session_id == transcript_session_id && locator.source_path.is_file() {
            return Ok(locator.source_path);
        }
    }

    // Suffix form: runner bindings carry the bare thread uuid while rollout
    // stems are `rollout-<timestamp>-<thread-uuid>`.
    if let Some(path) = imported_cache::get_cached_source_path_by_suffix_from_conn(
        conn,
        SOURCE_CODEX_APP,
        file_stem,
    )? {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for sessions_dir in codex_sessions_dirs()? {
        if sessions_dir.is_dir() {
            collect_codex_session_files(&sessions_dir, &mut files)?;
        }
    }
    let stem_matches = |stem: &str| {
        stem == file_stem
            || (stem.len() > file_stem.len() + 1
                && stem.ends_with(file_stem)
                && stem.as_bytes()[stem.len() - file_stem.len() - 1] == b'-')
    };
    files
        .into_iter()
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(stem_matches)
        })
        // Newest rollout wins when several share a thread (resume forks).
        .max_by_key(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        })
        .ok_or_else(|| format!("Codex app file not found for session: {file_stem}"))
}

fn codex_sessions_dirs() -> Result<Vec<PathBuf>, String> {
    let home = app_paths::external_history_home_dir();
    let mut dirs = codex_sessions_dir_candidates(&home);
    // ORGII-managed own-key Codex runs redirect CODEX_HOME into per-account
    // profile dirs; native-transcript mode reads those rollouts back here.
    // (Hosted-key Codex keeps the system CODEX_HOME and is covered above.)
    dirs.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::codex_cli_profile_root(),
            &["sessions"],
        ),
    );
    Ok(dirs)
}

pub(crate) fn codex_sessions_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".codex"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Codex"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("codex"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Codex"));
        roots.push(home.join("AppData").join("Roaming").join("codex"));
        roots.push(home.join("AppData").join("Local").join("Codex"));
        roots.push(home.join("AppData").join("Local").join("codex"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("codex"));
        roots.push(home.join(".local").join("share").join("codex"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("sessions"))
        .collect()
}
#[cfg(test)]
mod tests;
