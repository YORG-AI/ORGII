//! Trae imported history reader
//!
//! Reads Trae's local per-session "memory" JSONL from
//! `~/.trae-cn/memory/projects/<slug>/<YYYYMMDD>/session_memory_<id>.jsonl` and
//! converts each turn-summary line into ORGII's canonical `ActivityChunk` shape
//! for read-only replay. Trae keeps only turn summaries in plaintext here
//! (intent / actions / outcome / learned); the verbatim transcript lives in a
//! SQLCipher-encrypted `ModularData/ai-agent/database.db` (and server-side)
//! that ORGII does not decrypt. Encrypted-DB format + key-extraction reference
//! (MIT): <https://github.com/bigmanBass666/trae-db-decrypt>.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::Deserialize;

use super::index;
use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_TRAE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow,
};

pub const TRAE_SESSION_PREFIX: &str = "traeapp-";
const TRAE_PROVIDER_SLUG: &str = "trae";
// v2: re-parse fixes — `message_summary_time` now read as local (not UTC)
// wall-clock time, and `repo_path` slug decode now anchors on the home dir (so
// dashed usernames like `laptop-h` resolve instead of yielding NULL). Bumping
// forces cached sessions to re-parse and pick up both.
const TRAE_METADATA_PARSER_VERSION: i64 = 2;
const SESSION_FILE_PREFIX: &str = "session_memory_";
const TRAE_TIME_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

pub type TraeHistorySessionRow = ImportedHistorySessionRow;
pub type TraeHistorySessionPage = ImportedHistorySessionPage;
pub type TraeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct TraeHistoryMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    repo_path: Option<String>,
    /// Friendly agent label from the vscdb index (e.g. `"Solo Agent"`).
    model: Option<String>,
    /// Serialized `{ "trae": TraeIndexEntry }` when the session carries index
    /// signal (agent / current / order), else `None`.
    source_metadata_json: Option<String>,
}

/// One turn-summary line of a Trae `session_memory_*.jsonl` file.
#[derive(Debug, Default, Deserialize)]
struct TraeMemoryLine {
    #[serde(default)]
    intent: String,
    #[serde(default)]
    actions: Vec<String>,
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    learned: Vec<String>,
    #[serde(default)]
    message_summary_time: String,
}

#[derive(Debug, Clone)]
struct TraeSessionFile {
    source_session_id: String,
    path: PathBuf,
    /// The project-slug directory name (e.g. `-Users-me-Documents-GitHub-Brick`).
    project_slug: String,
}

pub fn list_trae_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<TraeHistorySessionPage, String> {
    sync_trae_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_TRAE, limit, offset)
}

pub fn list_trae_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<TraeRecentPath>, String> {
    sync_trae_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_TRAE, limit)
}

pub fn load_trae_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = trae_source_id_from_session_id(session_id)?;
    let path = resolve_trae_session_path(conn, source_session_id)?;
    load_trae_history_from_path(session_id, &path)
}

fn sync_trae_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_trae_history_records()?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_TRAE, &discovered, |record| {
            record.signature()
        })?;
    // VS Code `state.vscdb` index (agent / current / order), keyed on the same
    // session ids. Best-effort and cheap, so only read it when there is work.
    let session_index = if changed.is_empty() {
        index::TraeSessionIndex::new()
    } else {
        index::load_trae_session_index()
    };
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_trae_session_meta(record, &session_index)? {
            inputs.push(session_meta_to_cache_input(meta));
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_TRAE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_trae_history_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    for projects_dir in trae_projects_dirs()? {
        if !projects_dir.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_trae_session_files(&projects_dir, &projects_dir, &mut files)?;
        for file in files {
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&file.path, "Trae")?;
            records.push(ImportedHistoryDiscoveredRecord {
                source_session_id: file.source_session_id.clone(),
                source_path: file.path,
                source_record_key: file.source_session_id.clone(),
                source_mtime_ms,
                source_size_bytes,
                // Slug is stable per file; mtime/size already drive change
                // detection, so no extra fingerprint is needed.
                source_fingerprint: file.project_slug,
                parser_version: TRAE_METADATA_PARSER_VERSION,
            });
        }
    }
    Ok(records)
}

/// Recursively collect `session_memory_*.jsonl` files, remembering the
/// project-slug directory (the first path component under `projects/`).
fn collect_trae_session_files(
    projects_root: &Path,
    dir: &Path,
    out: &mut Vec<TraeSessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Trae dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Trae dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_trae_session_files(projects_root, &path, out)?;
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(rest) = name
            .strip_prefix(SESSION_FILE_PREFIX)
            .and_then(|rest| rest.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        out.push(TraeSessionFile {
            source_session_id: rest.to_string(),
            project_slug: project_slug_for_path(projects_root, &path),
            path,
        });
    }
    Ok(())
}

/// The directory name directly under `projects/` for a session file.
fn project_slug_for_path(projects_root: &Path, session_path: &Path) -> String {
    session_path
        .strip_prefix(projects_root)
        .ok()
        .and_then(|rel| rel.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .unwrap_or_default()
        .to_string()
}

fn parse_trae_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
    session_index: &index::TraeSessionIndex,
) -> Result<Option<TraeHistoryMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Trae history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut first_intent = String::new();

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Trae history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: TraeMemoryLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if let Some(timestamp) = parse_trae_time_ms(&parsed.message_summary_time) {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            if timestamp > updated_at_ms {
                updated_at_ms = timestamp;
            }
        }
        if first_intent.is_empty() && !parsed.intent.trim().is_empty() {
            first_intent = imported_history::truncate_name(parsed.intent.trim(), 200);
        }
    }

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    let topic = topic_summary_for_session(&record.source_path, &record.source_session_id);
    let name = if let Some(topic) = topic {
        imported_history::truncate_name(&topic, 200)
    } else if !first_intent.is_empty() {
        first_intent
    } else {
        record.source_record_key.clone()
    };

    let repo_path = decode_project_path(&record.source_fingerprint);

    // Enrich from the vscdb index: surface the agent as the session's model
    // label and persist the raw index signal for later use.
    let index_entry = session_index.get(&record.source_session_id);
    let model = index_entry
        .and_then(|entry| entry.agent.as_deref())
        .map(index::agent_display_label);
    let source_metadata_json = index_entry
        .filter(|entry| entry.is_meaningful())
        .and_then(|entry| serde_json::to_string(&serde_json::json!({ "trae": entry })).ok());

    // Trae session ids are Mongo ObjectId-style; their embedded creation time is
    // a more reliable `created_at` than the summary timestamps when the latter
    // are absent.
    let created_at_ms = if created_at_ms > 0 {
        created_at_ms
    } else {
        object_id_created_ms(&record.source_session_id).unwrap_or(record.source_mtime_ms)
    };

    Ok(Some(TraeHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: format!("{TRAE_SESSION_PREFIX}{}", record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        created_at_ms,
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            record.source_mtime_ms
        },
        repo_path,
        model,
        source_metadata_json,
    }))
}

/// Extract the creation time (ms) embedded in a Mongo ObjectId-style session id
/// (24 hex chars; first 4 bytes are the Unix seconds). `None` for other shapes.
fn object_id_created_ms(source_session_id: &str) -> Option<i64> {
    if source_session_id.len() != 24 || !source_session_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let seconds = i64::from_str_radix(&source_session_id[..8], 16).ok()?;
    (seconds > 0).then_some(seconds * 1000)
}

fn session_meta_to_cache_input(meta: TraeHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_TRAE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: TRAE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: 0,
        output_tokens: 0,
        repo_path: meta.repo_path,
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: true,
        source_metadata_json: meta.source_metadata_json,
        parent_session_id: None,
    }
}

fn load_trae_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Trae history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Trae history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: TraeMemoryLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = trae_time_to_iso(&parsed.message_summary_time);

        let intent = parsed.intent.trim();
        if !intent.is_empty() {
            chunks.push(imported_history::user_message_chunk(
                session_id,
                TRAE_PROVIDER_SLUG,
                sequence,
                &created_at,
                intent,
            ));
            sequence += 1;
        }

        let body = compose_turn_body(&parsed);
        if !body.trim().is_empty() {
            chunks.push(imported_history::assistant_message_chunk(
                session_id,
                TRAE_PROVIDER_SLUG,
                sequence,
                &created_at,
                &body,
            ));
            sequence += 1;
        }
    }

    Ok(chunks)
}

/// Render a turn's outcome + actions + learned facts as a readable summary.
fn compose_turn_body(line: &TraeMemoryLine) -> String {
    let mut body = String::new();
    let outcome = line.outcome.trim();
    if !outcome.is_empty() {
        body.push_str(outcome);
    }
    if !line.actions.is_empty() {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str("Actions:");
        for action in &line.actions {
            body.push_str(&format!("\n- {}", action.trim()));
        }
    }
    if !line.learned.is_empty() {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str("Learned:");
        for fact in &line.learned {
            body.push_str(&format!("\n- {}", fact.trim()));
        }
    }
    body
}

/// Find the `topics.md` next to a session file and return the last topic summary
/// recorded for `source_session_id` (the human-readable session title).
fn topic_summary_for_session(session_path: &Path, source_session_id: &str) -> Option<String> {
    let topics_path = session_path.parent()?.join("topics.md");
    let contents = fs::read_to_string(&topics_path).ok()?;
    let marker = format!("[session_id: {source_session_id}");
    let mut summary: Option<String> = None;
    for start in find_all(&contents, &marker) {
        // Skip past the `... ]` header to the summary text.
        let after_header = contents[start..].find(']').map(|idx| start + idx + 1)?;
        let end = contents[after_header..]
            .find("[session_id:")
            .map(|idx| after_header + idx)
            .unwrap_or(contents.len());
        let text = contents[after_header..end].trim();
        if !text.is_empty() {
            summary = Some(text.to_string());
        }
    }
    summary
}

fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(idx) = haystack[from..].find(needle) {
        let abs = from + idx;
        out.push(abs);
        from = abs + needle.len();
    }
    out
}

/// Decode a `-Users-me-Documents-GitHub-Brick` slug back to an absolute path.
///
/// The slug replaces every `/` with `-`, which is lossy when a path segment
/// itself contains `-` (e.g. a username like `laptop-h`: the naive decode
/// `/Users/laptop/h/…` doesn't exist, so the repo can't be resolved and the
/// session ends up with a NULL `repo_path` — which drops it from the Data
/// Sources session count). Anchor on the home directory first, whose known slug
/// prefix disambiguates the dashes in that portion, then fall back to the naive
/// decode. Returns `None` only when neither resolves to an existing directory.
fn decode_project_path(slug: &str) -> Option<String> {
    let cleaned = slug.trim_start_matches('-');
    if cleaned.is_empty() {
        return None;
    }
    // Home-anchored decode: strip the home dir's slug prefix (which may itself
    // contain literal dashes) and decode only the remainder under it.
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        let home_prefix = home_str.replace('/', "-");
        if let Some(rest) = cleaned.strip_prefix(home_prefix.trim_start_matches('-')) {
            let rest = rest.trim_start_matches('-');
            let candidate = if rest.is_empty() {
                home_str.to_string()
            } else {
                format!("{home_str}/{}", rest.replace('-', "/"))
            };
            if Path::new(&candidate).is_dir() {
                return Some(candidate);
            }
        }
    }
    // Fallback: naive decode (correct when no path segment contains `-`).
    let candidate = format!("/{}", cleaned.replace('-', "/"));
    if Path::new(&candidate).is_dir() {
        Some(candidate)
    } else {
        None
    }
}

fn parse_trae_time_ms(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    // Trae records `message_summary_time` as wall-clock *local* time with no
    // timezone suffix (it matches the file's local mtime). Interpret it in the
    // machine's local zone to recover the correct UTC instant — treating it as
    // UTC would shift every timestamp by the local offset (e.g. sessions land
    // +8h "in the future" on a UTC+8 machine).
    chrono::NaiveDateTime::parse_from_str(value, TRAE_TIME_FORMAT)
        .ok()
        .and_then(|naive| naive.and_local_timezone(chrono::Local).earliest())
        .map(|dt| dt.timestamp_millis())
}

fn trae_time_to_iso(value: &str) -> String {
    parse_trae_time_ms(value)
        .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

fn trae_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(rest) = session_id.strip_prefix(TRAE_SESSION_PREFIX) else {
        return Err(format!("Invalid Trae history session id: {session_id}"));
    };
    if rest.is_empty() {
        return Err("Trae history session id is missing its source id".to_string());
    }
    Ok(rest)
}

fn resolve_trae_session_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_TRAE, source_session_id)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    for projects_dir in trae_projects_dirs()? {
        if !projects_dir.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_trae_session_files(&projects_dir, &projects_dir, &mut files)?;
        if let Some(file) = files
            .into_iter()
            .find(|file| file.source_session_id == source_session_id)
        {
            return Ok(file.path);
        }
    }
    Err(format!(
        "Trae history file not found for session: {source_session_id}"
    ))
}

fn trae_projects_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(trae_projects_dir_candidates(&home))
}

/// `~/.trae-cn/memory/projects` (China build) and `~/.trae/memory/projects`
/// (international build).
fn trae_projects_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let roots = [".trae-cn", ".trae"];
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .map(|root| home.join(root))
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("memory").join("projects"))
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
