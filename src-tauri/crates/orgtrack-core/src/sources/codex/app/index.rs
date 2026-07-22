//! Codex session discovery, indexing, and cache sync.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::Deserialize;

use crate::sources::codex::{canonical_session_id, SESSION_PREFIX as CODEX_APP_SESSION_PREFIX};
use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryDiscoveredRecord, SOURCE_CODEX_APP},
    paths as imported_paths,
};
use crate::store::{sqlite::SqliteRecordStore, RecordStore};

use super::meta::{parse_codex_catalog_input, resolve_codex_transcript_for_thread_id_near_path};
use super::transcript::load_codex_app_from_path;
use super::{CodexAppRecentPath, CodexAppSessionPage, CODEX_APP_METADATA_PARSER_VERSION};

#[derive(Debug, Clone)]
struct CodexSessionIndexEntry {
    thread_name: String,
    updated_at: Option<String>,
}

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
    load_codex_app_from_path(session_id, &path)
}

pub(crate) fn refresh_catalog(conn: &mut Connection) -> Result<(), String> {
    refresh_codex_app_catalog(conn)
}

fn refresh_codex_app_catalog(conn: &mut Connection) -> Result<(), String> {
    let mut discovered = discover_codex_app_records()?;
    let managed_ids =
        crate::sources::imported_history::managed_mirror::managed_source_session_ids_from_conn(
            conn,
            "codex",
            SOURCE_CODEX_APP,
        )?;
    for record in &mut discovered {
        crate::sources::imported_history::managed_mirror::append_managed_fingerprint(
            &mut record.source_fingerprint,
            crate::sources::imported_history::managed_mirror::is_managed_source_session_id(
                &managed_ids,
                &record.source_session_id,
            ),
        );
    }
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_CODEX_APP, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
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
        if let Some(mut input) = parse_codex_catalog_input(record)? {
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

fn discover_codex_app_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut sessions = Vec::new();
    for sessions_dir in codex_sessions_dirs()? {
        if sessions_dir.is_dir() {
            let title_index = load_codex_session_index_for_sessions_dir(&sessions_dir)?;
            let mut files = Vec::new();
            collect_codex_session_files(&sessions_dir, &mut files)?;
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
                sessions.push(ImportedHistoryDiscoveredRecord {
                    source_session_id: file_stem.clone(),
                    source_path: path,
                    source_record_key: file_stem,
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint,
                    parser_version: CODEX_APP_METADATA_PARSER_VERSION,
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
