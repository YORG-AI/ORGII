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

use std::collections::HashSet;
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

mod store;
mod transcript;
mod wire;

use store::*;
use transcript::*;
use wire::*;

const CURSOR_CLI_PROVIDER_SLUG: &str = "cursorcli";
/// `code_sessions.cli_agent_type` for managed cursor-agent runs
/// (`ModelType::CursorCli`).
const CURSOR_CLI_AGENT_TYPE: &str = "cursor_cli";
const CURSOR_CLI_METADATA_PARSER_VERSION: i64 = 1;
const STORE_FILENAME: &str = "store.db";
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
    let home_dir = app_paths::external_history_home_dir();
    let mut roots = vec![
        home_dir.join(".cursor").join("chats"),
        app_paths::external_history_config_dir()
            .join("cursor")
            .join("chats"),
    ];
    // `dirs::config_dir()` only honors XDG on Linux, but cursor-agent honors
    // an exported `$XDG_CONFIG_HOME` on macOS too (resolution order above),
    // so probe it explicitly. `None` under identity isolation; overlaps with
    // the config-dir candidate on Linux, which dedupe below collapses.
    if let Some(xdg_config) = app_paths::external_history_xdg_config_dir() {
        roots.push(xdg_config.join("cursor").join("chats"));
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
    let chunks = load_history_from_store_conn(store_conn, &session_id)?;
    let impact = imported_history::impact_from_edit_chunks(&chunks);
    let first_prompt = first_user_prompt_from_chunks(&chunks);

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
        client_origin: None,
        client_origin_raw: None,
    }
}

fn first_user_prompt_from_chunks(chunks: &[ActivityChunk]) -> Option<String> {
    chunks
        .iter()
        .find(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .and_then(|chunk| {
            chunk
                .result
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
#[path = "../history_tests.rs"]
mod tests;
