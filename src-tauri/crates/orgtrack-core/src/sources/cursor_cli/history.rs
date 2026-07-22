//! Cursor CLI (cursor-agent) imported history reader.
//!
//! Store layout (reverse-engineered empirically, 2026-07, cursor-agent /
//! `composer-1` era stores):
//!
//! - One SQLite database per session at
//!   `~/.cursor/chats/<md5-of-workspace-path>/<session-uuid>/store.db`,
//!   in WAL mode — a young store's main file can be a 4 KB shell while the
//!   entire conversation lives in `store.db-wal`, so discovery fingerprints
//!   and freshness stats must fold the sidecars in.
//! - `meta(key TEXT PRIMARY KEY, value TEXT)` holds a single row `key = '0'`
//!   whose value is **hex-encoded UTF-8 JSON**:
//!   `{"agentId","latestRootBlobId","name","mode","createdAt","lastUsedModel"}`
//!   (`createdAt` is epoch ms; `name` defaults to `"New Agent"`).
//! - `blobs(id TEXT PRIMARY KEY, data BLOB)` is a content-addressed DAG:
//!   `id` = lowercase hex SHA-256 of `data`, so identical payloads dedupe
//!   (the agent loop re-injects the same user query around tool calls and all
//!   those list entries share one blob).
//! - The root blob (`latestRootBlobId`) is a protobuf manifest:
//!   - field 1 (repeated, 32 raw bytes): ordered message blob hashes — the
//!     conversation transcript in API order;
//!   - field 5 (message): `{1: context tokens used, 2: context window size}`;
//!   - field 8 (repeated, 32 raw bytes): checkpoint/file-snapshot tree nodes
//!     (protobuf lists of more hashes; not needed for replay);
//!   - field 9 (string): workspace root as a `file://` URI;
//!   - field 12 (repeated message): `{1: relative path, 2: snapshot hash}`.
//! - Each message blob referenced by field 1 is plain UTF-8 JSON in the
//!   Vercel-AI-SDK message shape: `{"role":"system"|"user"|"assistant"|"tool",
//!   "content": string | [{"type":"text"|"tool-call"|"tool-result", ...}]}`.
//!   Assistant text embeds `<think>…</think>` blocks inline; real user turns
//!   are wrapped in `<user_query>…</user_query>` (with an optional injected
//!   `USER REQUEST:` / `--- Model: …` / element-picker scaffold, sometimes
//!   serialized with literal `\n` two-character sequences), while other user
//!   rows are context injections (`<user_info>`, attached files).
//!
//! What is NOT recoverable from the store: per-message timestamps (chunks all
//! carry the session `createdAt`; ordering comes from the manifest) and an
//! input/output token split (field 5 only exposes context usage, surfaced
//! here as the session's token total).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_CURSOR_CLI,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

use super::SESSION_PREFIX as CURSOR_CLI_SESSION_PREFIX;

const CURSOR_CLI_PROVIDER_SLUG: &str = "cursorcli";
/// `code_sessions.cli_agent_type` for managed cursor-agent runs
/// (`ModelType::CursorCli`).
const CURSOR_CLI_AGENT_TYPE: &str = "cursor_cli";
const CURSOR_CLI_METADATA_PARSER_VERSION: i64 = 1;
const STORE_FILENAME: &str = "store.db";
const CURSOR_CLI_CATALOG_BLOB_BYTES: i64 = 1024 * 1024;
/// The store's placeholder session name; real titles only exist when the user
/// renames the agent, so the placeholder yields to the first prompt.
const DEFAULT_SESSION_NAME: &str = "New Agent";

pub type CursorCliHistorySessionRow = ImportedHistorySessionRow;
pub type CursorCliHistorySessionPage = ImportedHistorySessionPage;
pub type CursorCliRecentPath = ImportedHistoryRecentPath;

/// `meta` table row `'0'` — hex-encoded JSON session header.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CursorStoreMeta {
    agent_id: String,
    latest_root_blob_id: String,
    name: String,
    created_at: i64,
    last_used_model: String,
}

/// Decoded root-blob manifest (the fields replay needs).
#[derive(Debug, Clone, Default)]
struct CursorStoreManifest {
    /// Ordered message blob ids (lowercase hex).
    message_blob_ids: Vec<String>,
    /// Context tokens used (root field 5.1). No input/output split exists.
    context_tokens: i64,
    /// Workspace root decoded from the `file://` URI in root field 9.
    workspace_path: Option<String>,
}

#[derive(Debug, Clone)]
struct CursorCliHistoryMeta {
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
    model: Option<String>,
    repo_path: Option<String>,
    input_tokens: i64,
    impact: ImportedHistoryImpactStats,
}

pub fn list_cursor_cli_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CursorCliHistorySessionPage, String> {
    sync_cursor_cli_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CURSOR_CLI, limit, offset)
}

pub fn list_cursor_cli_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<CursorCliRecentPath>, String> {
    sync_cursor_cli_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CURSOR_CLI, limit)
}

pub fn load_cursor_cli_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = cursor_cli_source_id_from_session_id(session_id)?;
    let path = resolve_store_path(conn, source_session_id)?;
    let store_conn = open_store_readonly(&path)?;
    load_history_from_store_conn(&store_conn, session_id)
}

/// Cheap freshness probe for one session's store: `(mtime_ms, size_bytes)`,
/// folding the `-wal` sidecar in (WAL commits don't touch the main file's
/// mtime until checkpoint). `Ok(None)` when the store is missing — callers
/// fall back to a full refresh.
pub fn stat_cursor_cli_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let source_session_id = cursor_cli_source_id_from_session_id(session_id)?;
    let Ok(path) = resolve_store_path(conn, source_session_id) else {
        return Ok(None);
    };
    Ok(stat_store(&path))
}

/// Candidate roots holding per-session store dirs. Exposed so the
/// external-CLI detection layer can report the store path.
///
/// cursor-agent resolves its config root as `$CURSOR_CONFIG_DIR ||
/// $XDG_CONFIG_HOME/cursor || ~/.cursor` and writes one store per session at
/// `<config-root>/chats/<md5-of-cwd>/<session-uuid>/store.db` (verified
/// against the 2026.01 and 2026.04 CLI builds: `getChatsRootDir()` joins
/// `chats` directly onto `getConfigDir()` — no `.cursor` component when the
/// config dir is overridden).
pub fn cursor_cli_history_candidate_paths() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home_dir) = dirs::home_dir() {
        roots.push(home_dir.join(".cursor").join("chats"));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            roots.push(PathBuf::from(xdg).join("cursor").join("chats"));
        }
    }
    // ORGII-managed cursor-agent runs redirect CURSOR_CONFIG_DIR (not HOME):
    // own-key sessions into per-account profile dirs, hosted-key sessions
    // into per-session config dirs. Chats land directly under
    // `<config-dir>/chats` in both cases.
    roots.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::cursor_cli_profile_root(),
            &["chats"],
        ),
    );
    roots.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::cursor_config_root(),
            &["chats"],
        ),
    );
    imported_paths::dedupe_paths(roots)
}

pub(crate) fn refresh_catalog(conn: &mut Connection) -> Result<(), String> {
    sync_cursor_cli_history_cache(conn)
}

fn sync_cursor_cli_history_cache(conn: &mut Connection) -> Result<(), String> {
    let mut discovered = discover_cursor_cli_history_records()?;
    // Managed (GUI-launched) sessions surface through their code_sessions
    // row; the imported twin goes unlistable. Folding the verdict into the
    // fingerprint re-parses a session whose managed status flips.
    let managed_ids = managed_mirror::managed_source_session_ids_from_conn(
        conn,
        CURSOR_CLI_AGENT_TYPE,
        SOURCE_CURSOR_CLI,
    )?;
    for record in &mut discovered {
        managed_mirror::append_managed_fingerprint(
            &mut record.source_fingerprint,
            managed_ids.contains(&record.source_session_id),
        );
    }
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_CURSOR_CLI,
        &discovered,
        |record| record.signature(),
    )?;
    let mut inputs = Vec::new();
    for record in changed {
        let is_managed = managed_ids.contains(&record.source_session_id);
        if imported_cache::advance_cached_catalog_record_from_conn(
            conn,
            SOURCE_CURSOR_CLI,
            record,
            Some(!is_managed),
        )? {
            continue;
        }
        // A single locked/corrupt per-session store must not hide every other
        // session, so unreadable stores are skipped rather than failing the
        // whole source sync; the unchanged signature retries them next scan.
        let Ok(store_conn) = open_store_readonly(&record.source_path) else {
            continue;
        };
        let updated_at_ms = store_updated_at_ms(&record.source_path);
        match session_meta_from_store_conn(&store_conn, record, updated_at_ms) {
            Ok(Some(meta)) => {
                let is_managed_history_mirror = managed_ids.contains(&meta.source_session_id);
                let mut input = session_meta_to_cache_input(meta);
                input.listable = input.listable && !is_managed_history_mirror;
                inputs.push(input);
            }
            Ok(None) | Err(_) => continue,
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CURSOR_CLI,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_cursor_cli_history_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    // The same session uuid can theoretically appear under two roots (user
    // home + managed profile); first root wins to keep ids unique.
    let mut seen_session_ids = HashSet::new();
    for chats_root in cursor_cli_history_candidate_paths() {
        let Ok(workspaces) = fs::read_dir(&chats_root) else {
            continue;
        };
        for workspace in workspaces.flatten() {
            let workspace_dir = workspace.path();
            if !workspace_dir.is_dir() {
                continue;
            }
            let Ok(sessions) = fs::read_dir(&workspace_dir) else {
                continue;
            };
            for session in sessions.flatten() {
                let session_dir = session.path();
                let store_path = session_dir.join(STORE_FILENAME);
                if !store_path.is_file() {
                    continue;
                }
                let Some(source_session_id) =
                    session_dir.file_name().and_then(|name| name.to_str())
                else {
                    continue;
                };
                if !seen_session_ids.insert(source_session_id.to_string()) {
                    continue;
                }
                let (source_mtime_ms, source_size_bytes) =
                    imported_paths::file_metadata_signature(&store_path, "Cursor CLI")?;
                records.push(ImportedHistoryDiscoveredRecord {
                    source_session_id: source_session_id.to_string(),
                    source_record_key: source_session_id.to_string(),
                    // WAL-mode store: fold the sidecars in so a commit that
                    // only grows `store.db-wal` still changes the signature.
                    source_fingerprint: imported_paths::sqlite_sidecar_signature(&store_path),
                    source_path: store_path,
                    source_mtime_ms,
                    source_size_bytes,
                    parser_version: CURSOR_CLI_METADATA_PARSER_VERSION,
                });
            }
        }
    }
    Ok(records)
}

fn session_meta_from_store_conn(
    store_conn: &Connection,
    record: &ImportedHistoryDiscoveredRecord,
    updated_at_ms: i64,
) -> Result<Option<CursorCliHistoryMeta>, String> {
    let Some(store_meta) = read_store_meta(store_conn)? else {
        return Ok(None);
    };
    let manifest =
        read_store_manifest(store_conn, &store_meta.latest_root_blob_id)?.unwrap_or_default();
    let session_id = super::canonical_session_id(&record.source_session_id);
    let (first_prompt, impact) =
        scan_manifest_catalog(store_conn, &session_id, &manifest, store_meta.created_at)?;

    // A user-set agent name wins; the store's "New Agent" placeholder yields
    // to the first prompt, then to the raw session uuid.
    let store_name = imported_history::strip_orgii_exec_mode_bridge(store_meta.name.trim()).trim();
    let name = if !store_name.is_empty() && store_name != DEFAULT_SESSION_NAME {
        imported_history::truncate_name(store_name, 200)
    } else if let Some(prompt) = first_prompt {
        imported_history::truncate_name(&prompt, 200)
    } else {
        record.source_record_key.clone()
    };

    let created_at_ms = if store_meta.created_at > 0 {
        store_meta.created_at
    } else {
        updated_at_ms
    };
    let model =
        Some(store_meta.last_used_model.trim().to_string()).filter(|model| !model.is_empty());

    Ok(Some(CursorCliHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        created_at_ms,
        updated_at_ms: updated_at_ms.max(created_at_ms),
        model,
        repo_path: manifest.workspace_path,
        input_tokens: manifest.context_tokens,
        impact,
    }))
}

fn scan_manifest_catalog(
    store_conn: &Connection,
    session_id: &str,
    manifest: &CursorStoreManifest,
    created_at_ms: i64,
) -> Result<(Option<String>, ImportedHistoryImpactStats), String> {
    let created_at = imported_history::epoch_ms_to_iso(created_at_ms);
    let mut first_prompt = None;
    let mut touched_files = std::collections::BTreeSet::new();
    let mut impact = ImportedHistoryImpactStats::default();
    for blob_id in &manifest.message_blob_ids {
        let Some(data) = read_catalog_blob(store_conn, blob_id)? else {
            continue;
        };
        let Ok(message) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        match message.get("role").and_then(Value::as_str) {
            Some("user") if first_prompt.is_none() => {
                first_prompt = clean_user_text(&message_content_text(message.get("content")));
            }
            Some("assistant") => {
                for item in message_content_items(message.get("content")) {
                    if item.get("type").and_then(Value::as_str) != Some("tool-call") {
                        continue;
                    }
                    let Some(call) = tool_call_from_item(item, &created_at) else {
                        continue;
                    };
                    if call.canonical_name != imported_history::FUNCTION_EDIT_FILE {
                        continue;
                    }
                    let chunk = imported_history::tool_call_chunk(
                        session_id,
                        CURSOR_CLI_PROVIDER_SLUG,
                        0,
                        &call,
                        "",
                    );
                    let one = imported_history::impact_from_edit_chunks(&[chunk]);
                    impact.lines_added = impact.lines_added.saturating_add(one.lines_added);
                    impact.lines_removed = impact.lines_removed.saturating_add(one.lines_removed);
                    touched_files.extend(one.touched_files);
                }
            }
            _ => {}
        }
    }
    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
    Ok((first_prompt, impact))
}

fn session_meta_to_cache_input(meta: CursorCliHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_CLI,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CURSOR_CLI_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        // The manifest only exposes context usage (no input/output split);
        // surface it as the session total on the input side.
        input_tokens: meta.input_tokens,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: meta.repo_path,
        branch: None,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

fn open_store_readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| format!("Failed to open Cursor CLI store {}: {err}", path.display()))
}

fn resolve_store_path(conn: &Connection, source_session_id: &str) -> Result<PathBuf, String> {
    if let Some(path) = imported_cache::get_cached_source_path_from_conn(
        conn,
        SOURCE_CURSOR_CLI,
        source_session_id,
    )? {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    discover_cursor_cli_history_records()?
        .into_iter()
        .find(|record| record.source_session_id == source_session_id)
        .map(|record| record.source_path)
        .ok_or_else(|| format!("Cursor CLI store not found for session: {source_session_id}"))
}

fn stat_store(path: &Path) -> Option<(i64, u64)> {
    let main = fs::metadata(path).ok()?;
    let mut mtime_ms = metadata_mtime_epoch_ms(&main);
    let mut size_bytes = main.len();
    let mut wal_path = path.as_os_str().to_owned();
    wal_path.push("-wal");
    if let Ok(wal) = fs::metadata(&wal_path) {
        mtime_ms = mtime_ms.max(metadata_mtime_epoch_ms(&wal));
        size_bytes += wal.len();
    }
    Some((mtime_ms, size_bytes))
}

fn store_updated_at_ms(path: &Path) -> i64 {
    stat_store(path).map(|(mtime_ms, _)| mtime_ms).unwrap_or(0)
}

fn metadata_mtime_epoch_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn read_store_meta(conn: &Connection) -> Result<Option<CursorStoreMeta>, String> {
    let raw: Option<rusqlite::types::Value> = conn
        .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|err| format!("Failed to read Cursor CLI store meta: {err}"))?;
    let bytes = match raw {
        Some(rusqlite::types::Value::Text(text)) => text.into_bytes(),
        Some(rusqlite::types::Value::Blob(blob)) => blob,
        _ => return Ok(None),
    };
    let Some(json_bytes) = decode_meta_bytes(&bytes) else {
        return Ok(None);
    };
    Ok(serde_json::from_slice::<CursorStoreMeta>(&json_bytes).ok())
}

/// The meta value is hex-encoded JSON in every observed store; accept raw
/// JSON too in case a future build drops the hex layer.
fn decode_meta_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.first() == Some(&b'{') {
        return Some(bytes.to_vec());
    }
    hex_decode(std::str::from_utf8(bytes).ok()?)
}

fn read_blob(conn: &Connection, blob_id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row("SELECT data FROM blobs WHERE id = ?1", [blob_id], |row| {
        row.get::<_, Vec<u8>>(0)
    })
    .optional()
    .map_err(|err| format!("Failed to read Cursor CLI blob {blob_id}: {err}"))
}

fn read_catalog_blob(conn: &Connection, blob_id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT CASE WHEN length(data) <= ?2 THEN data ELSE NULL END
         FROM blobs WHERE id = ?1",
        rusqlite::params![blob_id, CURSOR_CLI_CATALOG_BLOB_BYTES],
        |row| row.get::<_, Option<Vec<u8>>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(|err| format!("Failed to read compact Cursor CLI blob {blob_id}: {err}"))
}

fn read_store_manifest(
    conn: &Connection,
    root_blob_id: &str,
) -> Result<Option<CursorStoreManifest>, String> {
    if root_blob_id.trim().is_empty() {
        return Ok(None);
    }
    let Some(data) = read_blob(conn, root_blob_id)? else {
        return Ok(None);
    };
    let Some(fields) = wire_fields(&data) else {
        return Ok(None);
    };
    let mut manifest = CursorStoreManifest::default();
    for (field, value) in fields {
        match (field, value) {
            // Ordered message hashes: 32 raw SHA-256 bytes each.
            (1, WireValue::Bytes(hash)) if hash.len() == 32 => {
                manifest.message_blob_ids.push(hex_encode(hash));
            }
            // Token usage: {1: context tokens used, 2: context window}.
            (5, WireValue::Bytes(usage)) => {
                if let Some(usage_fields) = wire_fields(usage) {
                    for (usage_field, usage_value) in usage_fields {
                        if usage_field == 1 {
                            if let WireValue::Varint(tokens) = usage_value {
                                manifest.context_tokens = tokens as i64;
                            }
                        }
                    }
                }
            }
            // Workspace root as a file:// URI.
            (9, WireValue::Bytes(uri)) => {
                if let Ok(uri) = std::str::from_utf8(uri) {
                    manifest.workspace_path = file_uri_to_path(uri);
                }
            }
            _ => {}
        }
    }
    Ok(Some(manifest))
}

// ---------------------------------------------------------------------------
// Transcript conversion
// ---------------------------------------------------------------------------

fn load_history_from_store_conn(
    store_conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let Some(store_meta) = read_store_meta(store_conn)? else {
        return Ok(Vec::new());
    };
    let Some(manifest) = read_store_manifest(store_conn, &store_meta.latest_root_blob_id)? else {
        return Ok(Vec::new());
    };
    // The store carries no per-message timestamps; every chunk gets the
    // session's creation time and ordering comes from the manifest.
    let created_at = imported_history::epoch_ms_to_iso(store_meta.created_at);

    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    let mut pending_tool_calls: HashMap<String, ImportedToolCall> = HashMap::new();
    let mut last_user_text: Option<String> = None;

    for blob_id in &manifest.message_blob_ids {
        let Some(data) = read_blob(store_conn, blob_id)? else {
            continue;
        };
        let Ok(message) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                let text = message_content_text(message.get("content"));
                let Some(text) = clean_user_text(&text) else {
                    continue;
                };
                // The agent loop re-injects the pending query around tool
                // calls; content-addressing makes those repeats byte-identical,
                // so collapse consecutive duplicates into one bubble.
                if last_user_text.as_deref() == Some(text.as_str()) {
                    continue;
                }
                last_user_text = Some(text.clone());
                chunks.push(imported_history::user_message_chunk(
                    session_id,
                    CURSOR_CLI_PROVIDER_SLUG,
                    sequence,
                    &created_at,
                    &text,
                ));
                sequence += 1;
            }
            Some("assistant") => {
                for item in message_content_items(message.get("content")) {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                            let (thoughts, visible) = split_think_blocks(text);
                            for thought in thoughts {
                                chunks.push(imported_history::thinking_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    &thought,
                                ));
                                sequence += 1;
                            }
                            let visible = visible.trim();
                            if !visible.is_empty() {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    visible,
                                ));
                                sequence += 1;
                            }
                        }
                        Some("tool-call") => {
                            if let Some(call) = tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("tool") => {
                for item in message_content_items(message.get("content")) {
                    if item.get("type").and_then(Value::as_str) != Some("tool-result") {
                        continue;
                    }
                    let Some(call_id) = item.get("toolCallId").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(call) = pending_tool_calls.remove(call_id) else {
                        continue;
                    };
                    let output = tool_result_output_text(item.get("result"));
                    chunks.push(imported_history::tool_call_chunk(
                        session_id,
                        CURSOR_CLI_PROVIDER_SLUG,
                        sequence,
                        &call,
                        &output,
                    ));
                    sequence += 1;
                }
            }
            _ => {}
        }
    }

    // In-flight calls at the tail of an interrupted session: still show them.
    for call in pending_tool_calls.into_values() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            CURSOR_CLI_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

fn message_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn message_content_items(content: Option<&Value>) -> Vec<&Value> {
    match content {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

/// Recover the user-authored text from a `role: "user"` message.
///
/// Real turns are wrapped in `<user_query>…</user_query>`; everything else on
/// the user role (`<user_info>` environment header, attached-file context) is
/// injected scaffolding and yields `None`. Inside the wrapper, the
/// element-picker form (`USER REQUEST:` … `--- Model: …` / `SELECTED
/// COMPONENT` / DOM dump) is cut down to the request itself.
fn clean_user_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let inner = match trimmed.find("<user_query>") {
        Some(start) => {
            let rest = &trimmed[start + "<user_query>".len()..];
            match rest.find("</user_query>") {
                Some(end) => &rest[..end],
                None => rest,
            }
        }
        None => {
            if trimmed.starts_with("<user_info>") {
                return None;
            }
            // Unwrapped user text: keep verbatim so a future format change
            // degrades to showing the raw prompt instead of dropping it.
            trimmed
        }
    };
    let cleaned = strip_user_query_scaffold(inner);
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn strip_user_query_scaffold(inner: &str) -> &str {
    let text = trim_wrapper_edges(inner);
    let Some(request) = text.strip_prefix("USER REQUEST:") else {
        return text;
    };
    // The injected context after the request starts at a `---` separator.
    // Some builds serialize the wrapper with literal `\n` two-character
    // sequences instead of newlines, so both separator spellings count.
    let request = match [request.find("\n---"), request.find("\\n---")]
        .into_iter()
        .flatten()
        .min()
    {
        Some(cut) => &request[..cut],
        None => request,
    };
    trim_wrapper_edges(request)
}

/// Trim whitespace and literal `\n` two-character sequences from both edges.
fn trim_wrapper_edges(mut text: &str) -> &str {
    loop {
        let before = text;
        text = text.trim();
        text = text.strip_prefix("\\n").unwrap_or(text);
        text = text.strip_suffix("\\n").unwrap_or(text);
        if text == before {
            return text;
        }
    }
}

/// Split inline `<think>…</think>` blocks out of assistant text. Returns the
/// extracted thoughts (in order) and the remaining visible text. An unclosed
/// block swallows the rest of the text as thought.
fn split_think_blocks(text: &str) -> (Vec<String>, String) {
    let mut thoughts = Vec::new();
    let mut visible = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        visible.push_str(&rest[..start]);
        let after = &rest[start + "<think>".len()..];
        match after.find("</think>") {
            Some(end) => {
                thoughts.push(after[..end].trim().to_string());
                rest = &after[end + "</think>".len()..];
            }
            None => {
                thoughts.push(after.trim().to_string());
                rest = "";
            }
        }
    }
    visible.push_str(rest);
    thoughts.retain(|thought| !thought.is_empty());
    (thoughts, visible)
}

fn tool_call_from_item(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("toolCallId")?.as_str()?.to_string();
    let raw_name = item.get("toolName")?.as_str()?.to_string();
    let args = item.get("args").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_cursor_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn tool_result_output_text(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Map cursor-agent tool names onto ORGII's canonical functions. Observed
/// names: `read_file`, `grep`, `glob_file_search` (already canonical),
/// `search_replace` (edit), plus the shell/write family.
fn normalize_cursor_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "shell" | "bash" | "run_terminal_cmd" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "search_replace" | "edit_file" | "write" | "write_file" | "create_file" | "multi_edit"
        | "MultiEdit" | "apply_patch" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "command": command,
        "cmd": command,
        "payload": args,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("filePath").and_then(Value::as_str))
        .or_else(|| args.get("target_file").and_then(Value::as_str))
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    // `payload` keeps old_string/new_string so the shared impact collector
    // can count the changed lines.
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn cursor_cli_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(CURSOR_CLI_SESSION_PREFIX) else {
        return Err(format!("Invalid Cursor CLI session id: {session_id}"));
    };
    if source_session_id.trim().is_empty() {
        return Err("Cursor CLI session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

// ---------------------------------------------------------------------------
// Wire helpers (protobuf wire format + hex + file URIs)
// ---------------------------------------------------------------------------

enum WireValue<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// Minimal protobuf wire-format walker for the root manifest. The store has
/// no published descriptor, so this decodes just the tag/length framing and
/// leaves interpretation to the caller. Returns `None` on malformed input.
fn wire_fields(data: &[u8]) -> Option<Vec<(u32, WireValue<'_>)>> {
    let mut fields = Vec::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let (tag, next) = read_varint(data, offset)?;
        offset = next;
        let field = (tag >> 3) as u32;
        match tag & 7 {
            0 => {
                let (value, next) = read_varint(data, offset)?;
                offset = next;
                fields.push((field, WireValue::Varint(value)));
            }
            1 => {
                offset = offset.checked_add(8).filter(|end| *end <= data.len())?;
            }
            2 => {
                let (length, next) = read_varint(data, offset)?;
                offset = next;
                let end = offset.checked_add(usize::try_from(length).ok()?)?;
                if end > data.len() {
                    return None;
                }
                fields.push((field, WireValue::Bytes(&data[offset..end])));
                offset = end;
            }
            5 => {
                offset = offset.checked_add(4).filter(|end| *end <= data.len())?;
            }
            _ => return None,
        }
    }
    Some(fields)
}

fn read_varint(data: &[u8], mut offset: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(offset)?;
        offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, offset));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.is_empty() || text.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push(((high << 4) | low) as u8);
    }
    Some(out)
}

/// Decode a `file://` URI into a filesystem path (percent-decoding included).
fn file_uri_to_path(uri: &str) -> Option<String> {
    let raw = uri.trim().strip_prefix("file://")?;
    let decoded = percent_decode(raw);
    // Windows URIs look like `file:///C:/path`; strip the leading slash.
    let decoded = if decoded.len() >= 3
        && decoded.starts_with('/')
        && decoded.as_bytes()[2] == b':'
        && decoded.as_bytes()[1].is_ascii_alphabetic()
    {
        decoded[1..].to_string()
    } else {
        decoded
    };
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
