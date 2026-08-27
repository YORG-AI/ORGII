//! GitHub Copilot CLI imported-history reader.
//!
//! Copilot CLI (verified against 0.0.421 and 1.0.69–1.0.75 stores) writes one
//! directory per session under `~/.copilot/session-state/<uuid>/`:
//!   - `events.jsonl`    — the full event stream, one JSON object per line:
//!     `{"type", "data", "id", "timestamp", "parentId"}`. Replay uses
//!     `user.message`, `assistant.message` (text + `toolRequests`), and the
//!     `tool.execution_start` / `tool.execution_complete` pair; lifecycle and
//!     hook events (`session.*`, `hook.*`, `assistant.turn_*`,
//!     `system.message`) are skipped, and unknown types are ignored so newer
//!     CLIs cannot break the parser.
//!   - `workspace.yaml`  — flat metadata sidecar (`id`, `cwd`, `name`,
//!     `created_at`, `updated_at`, …), hand-parsed here to avoid a YAML
//!     dependency.
//!
//! A sibling `~/.copilot/session-store.db` (SQLite, WAL, possibly held open
//! by a live CLI) enriches rows with `sessions.branch`/`repository` and
//! per-request token usage from `assistant_usage_events`. The db is strictly
//! best-effort: locked/missing/partial stores preserve cached enrichment when
//! available (or degrade to zero tokens and no branch on a cold import) rather
//! than failing the transcript scan.
//!
//! Token semantics, verified empirically against the real store (session
//! `e40a5c3d…`, CLI printout "↑ 26.0k (3.8k cached) ↓ 449 (320 reasoning)"):
//!   - `assistant_usage_events.input_tokens` is already CACHE-INCLUSIVE:
//!     `token_details_json` showed fresh input 10601 + cache_read 2176 =
//!     column value 12777 (and 11579 + 1664 = 13243 on the second request;
//!     12777 + 13243 = 26020 = the printed "↑ 26.0k"). So the column is used
//!     as-is for [`ImportedHistoryCacheInput::input_tokens`] (which must be
//!     cache-inclusive) with `cache_read/write_tokens` reported separately.
//!   - `output_tokens` already INCLUDES `reasoning_tokens`: rows summed to
//!     449 output / 320 reasoning, matching the printed "↓ 449 (320
//!     reasoning)", so reasoning is NOT added on top.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use core_types::activity::ActivityChunk;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        ImportedHistoryRecordSignature, RoundUsage, SOURCE_COPILOT,
    },
    paths as imported_paths, scan_snapshot,
    watermark::{ImportedParseWatermark, PrefixHasher, WatermarkedTranscriptReader},
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedHistorySessionRow,
    ImportedToolCall,
};

use super::SESSION_PREFIX as COPILOT_SESSION_PREFIX;

const COPILOT_PROVIDER_SLUG: &str = "copilot";
/// `code_sessions.cli_agent_type` for managed (GUI-launched) Copilot runs.
const COPILOT_AGENT_TYPE: &str = "copilot";
const COPILOT_METADATA_PARSER_VERSION: i64 = 2;
const EVENTS_FILENAME: &str = "events.jsonl";
const WORKSPACE_FILENAME: &str = "workspace.yaml";
const MAX_WORKSPACE_BYTES: u64 = 64 * 1024;
const MAX_EVENTS_FILE_BYTES: i64 = 64 * 1024 * 1024;
const MAX_CHANGED_SESSIONS_PER_SYNC: usize = 256;
const MAX_PARSE_SOURCE_BYTES_PER_SYNC: i64 = 64 * 1024 * 1024;
const MAX_RECENT_DB_CANDIDATES: usize = 64;
const MAX_DB_CANDIDATES: usize = MAX_CHANGED_SESSIONS_PER_SYNC + MAX_RECENT_DB_CANDIDATES;
const MAX_DB_USAGE_ROWS: usize = 20_000;
const MAX_PARSE_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_TOOL_CALLS: usize = 4_096;
const MAX_TOOL_REQUESTS_PER_EVENT: usize = 1_024;
const MAX_TOUCHED_FILES: usize = 256;
const MAX_DISCOVERED_SESSIONS: usize = 20_000;
const MAX_ID_BYTES: usize = 1_024;
const MAX_MODEL_BYTES: usize = 1_024;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_REPLAY_CHUNKS: usize = 20_000;
const MAX_REPLAY_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLAY_MESSAGE_CHARS: usize = 50_000;
const MAX_REPLAY_TOOL_RECORDS: usize = 20_000;
/// Cap a single tool-result body so a runaway command output can't bloat the
/// cache/replay payload (same cap as the Cline reader).
const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;

pub type CopilotHistorySessionRow = ImportedHistorySessionRow;
pub type CopilotHistorySessionPage = ImportedHistorySessionPage;
pub type CopilotRecentPath = ImportedHistoryRecentPath;

/// One `events.jsonl` line. `data` stays an untyped [`Value`] so unknown
/// event types (and new fields on known ones) parse without erroring.
#[derive(Debug, Default, Deserialize)]
struct CopilotEventLine {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    timestamp: String,
}

/// Fields read from the flat `workspace.yaml` sidecar.
#[derive(Debug, Default, Clone)]
struct CopilotWorkspaceMeta {
    cwd: Option<String>,
    name: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// One `assistant_usage_events` row (already in db order).
#[derive(Debug, Clone, Default)]
struct CopilotUsageRow {
    model: Option<String>,
    /// CACHE-INCLUSIVE input (fresh + cache_read + cache_write); see the
    /// module docs for the empirical verification.
    input_tokens: i64,
    /// Reasoning-INCLUSIVE output; reasoning is a reported subset, not an
    /// addend.
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    created_at_ms: i64,
}

/// Best-effort per-session enrichment from `session-store.db`.
#[derive(Debug, Clone, Default)]
struct CopilotDbEnrichment {
    repository: Option<String>,
    branch: Option<String>,
    usage: Vec<CopilotUsageRow>,
}

impl CopilotDbEnrichment {
    /// Minimal usage/branch signature folded into the discovery fingerprint,
    /// so out-of-band db writes (usage rows land after `events.jsonl` stops
    /// changing at shutdown, or the db was locked on the previous scan)
    /// trigger a re-parse on the next scan.
    fn fingerprint(&self) -> String {
        let mut hasher = PrefixHasher::default();
        hasher.update(self.repository.as_deref().unwrap_or_default().as_bytes());
        hasher.update(&[0]);
        hasher.update(self.branch.as_deref().unwrap_or_default().as_bytes());
        for row in &self.usage {
            hasher.update(&[0xff]);
            hasher.update(row.model.as_deref().unwrap_or_default().as_bytes());
            for value in [
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens,
                row.created_at_ms,
            ] {
                hasher.update(&value.to_le_bytes());
            }
        }
        format!("db-v2:{}:{}", self.usage.len(), hasher.digest())
    }
}

#[derive(Debug, Clone)]
struct CopilotDiscoveredRecord {
    record: ImportedHistoryDiscoveredRecord,
    enrichment: CopilotDbEnrichment,
}

impl CopilotDiscoveredRecord {
    fn signature(&self) -> ImportedHistoryRecordSignature {
        self.record.signature()
    }
}

#[derive(Debug, Clone)]
struct CopilotHistoryMeta {
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
    branch: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    rounds: Vec<RoundUsage>,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Clone)]
struct ParsedCopilotMeta {
    meta: CopilotHistoryMeta,
    watermark: ImportedParseWatermark,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CopilotMetaState {
    session_start_cwd: Option<String>,
    start_time_ms: Option<i64>,
    first_event_ms: Option<i64>,
    last_event_ms: Option<i64>,
    first_user_text: Option<String>,
    last_assistant_model: Option<String>,
    last_model_change: Option<String>,
    impact: ImportedHistoryImpactStats,
    pending_tool_impacts: HashMap<String, ImportedHistoryImpactStats>,
}

pub fn list_copilot_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CopilotHistorySessionPage, String> {
    sync_copilot_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_COPILOT, limit, offset)
}

pub fn list_copilot_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<CopilotRecentPath>, String> {
    sync_copilot_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_COPILOT, limit)
}

pub fn load_copilot_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = copilot_source_id_from_session_id(session_id)?;
    let path = resolve_copilot_events_path(conn, source_session_id)?;
    load_copilot_history_from_path(session_id, &path)
}

// ---------------------------------------------------------------------------
// Discovery + cache sync
// ---------------------------------------------------------------------------

fn sync_copilot_history_cache(conn: &mut Connection) -> Result<(), String> {
    let roots = copilot_session_state_dirs()?;
    sync_copilot_history_cache_in_roots(conn, &roots, copilot_session_store_db_path().as_deref())
}

/// Root/db-injectable sync core, so tests can point discovery at a fixture
/// directory and a synthetic `session-store.db`.
fn sync_copilot_history_cache_in_roots(
    conn: &mut Connection,
    roots: &[PathBuf],
    store_db_path: Option<&Path>,
) -> Result<(), String> {
    let mut discovered = discover_copilot_history_records(conn, roots)?;
    // Managed (GUI-launched) sessions surface through their code_sessions
    // row; the imported twin goes unlistable. Folding the verdict into the
    // fingerprint re-parses a session whose managed status flips.
    let managed_ids = managed_mirror::managed_source_session_ids_from_conn(
        conn,
        COPILOT_AGENT_TYPE,
        SOURCE_COPILOT,
    )?;
    let cached_fingerprints = read_cached_copilot_fingerprints(conn)?;
    for record in &mut discovered {
        record.record.source_fingerprint = cached_fingerprints
            .get(&record.record.source_session_id)
            .map(|fingerprint| strip_managed_fingerprint(fingerprint).to_string())
            .unwrap_or_else(|| "copilot-events-v2|db=deferred".to_string());
        managed_mirror::append_managed_fingerprint(
            &mut record.record.source_fingerprint,
            managed_ids.contains(&record.record.source_session_id),
        );
    }

    // Candidate selection is cache-driven and bounded. Every event-changed
    // record is eventually admitted in 256-session batches; the newest 64
    // cached sessions are also refreshed so a usage row written just after
    // events.jsonl stopped changing is observed without scanning the whole
    // Copilot database on every sidebar open.
    let mut preliminary_changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_COPILOT,
        &discovered,
        CopilotDiscoveredRecord::signature,
    )?;
    preliminary_changed.sort_by(|left, right| {
        right
            .record
            .source_mtime_ms
            .cmp(&left.record.source_mtime_ms)
            .then_with(|| {
                left.record
                    .source_session_id
                    .cmp(&right.record.source_session_id)
            })
    });
    let mut candidate_ids = preliminary_changed
        .into_iter()
        .take(MAX_CHANGED_SESSIONS_PER_SYNC)
        .map(|record| record.record.source_session_id.clone())
        .collect::<HashSet<_>>();
    let mut newest = discovered.iter().collect::<Vec<_>>();
    newest.sort_by(|left, right| {
        right
            .record
            .source_mtime_ms
            .cmp(&left.record.source_mtime_ms)
            .then_with(|| {
                left.record
                    .source_session_id
                    .cmp(&right.record.source_session_id)
            })
    });
    for record in newest.into_iter().take(MAX_RECENT_DB_CANDIDATES) {
        candidate_ids.insert(record.record.source_session_id.clone());
    }
    if candidate_ids.len() > MAX_DB_CANDIDATES {
        return Err("Copilot enrichment candidate budget exceeded".to_string());
    }
    let candidate_ids = candidate_ids.into_iter().collect::<Vec<_>>();
    let mut cached_enrichment = read_cached_copilot_enrichment(conn, &candidate_ids)?;
    let mut live_enrichment = read_copilot_store_enrichment(store_db_path, &candidate_ids);
    let candidate_set = candidate_ids.iter().collect::<HashSet<_>>();
    for record in &mut discovered {
        if !candidate_set.contains(&record.record.source_session_id) {
            continue;
        }
        let enrichment = match live_enrichment.as_mut() {
            Some(live) => live
                .remove(&record.record.source_session_id)
                .unwrap_or_default(),
            None => cached_enrichment
                .remove(&record.record.source_session_id)
                .unwrap_or_default(),
        };
        record.record.source_fingerprint =
            format!("copilot-events-v2|{}", enrichment.fingerprint());
        managed_mirror::append_managed_fingerprint(
            &mut record.record.source_fingerprint,
            managed_ids.contains(&record.record.source_session_id),
        );
        record.enrichment = enrichment;
    }

    let signatures = discovered
        .iter()
        .map(CopilotDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let mut changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_COPILOT, &discovered, |record| {
            record.signature()
        })?;
    changed.sort_by(|left, right| {
        right
            .record
            .source_mtime_ms
            .cmp(&left.record.source_mtime_ms)
            .then_with(|| {
                left.record
                    .source_session_id
                    .cmp(&right.record.source_session_id)
            })
    });
    let mut inputs = Vec::new();
    let mut rounds = Vec::new();
    let mut reparsed_ids = Vec::new();
    let mut watermarks = Vec::new();
    let mut attempted = 0usize;
    let mut admitted_source_bytes = 0_i64;
    for record in changed {
        if attempted >= MAX_CHANGED_SESSIONS_PER_SYNC {
            break;
        }
        let next_source_bytes =
            admitted_source_bytes.saturating_add(record.record.source_size_bytes.max(0));
        if attempted > 0 && next_source_bytes > MAX_PARSE_SOURCE_BYTES_PER_SYNC {
            break;
        }
        attempted = attempted.saturating_add(1);
        admitted_source_bytes = next_source_bytes;
        let stored = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_COPILOT,
            &record.record.source_session_id,
        )?;
        let Some(parsed) = imported_history::skip_unparsable_record(
            SOURCE_COPILOT,
            &record.record.source_session_id,
            parse_copilot_session_meta(record, stored.as_ref()),
        ) else {
            continue;
        };
        let mut meta = parsed.meta;
        let is_managed_history_mirror = managed_ids.contains(&meta.source_session_id);
        reparsed_ids.push(meta.session_id.clone());
        rounds.append(&mut meta.rounds);
        let mut input = session_meta_to_cache_input(meta);
        input.listable = input.listable && !is_managed_history_mirror;
        inputs.push(input);
        watermarks.push((record.record.source_session_id.clone(), parsed.watermark));
    }
    imported_cache::write_session_rounds_from_conn(conn, &reparsed_ids, &rounds)?;
    for (source_session_id, watermark) in watermarks {
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_COPILOT,
            &source_session_id,
            &watermark,
        )?;
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_COPILOT,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_copilot_history_records(
    conn: &Connection,
    roots: &[PathBuf],
) -> Result<Vec<CopilotDiscoveredRecord>, String> {
    let previous = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_COPILOT);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Copilot");
    let mut records = Vec::new();
    let mut seen_session_ids = HashSet::new();
    for root in roots {
        match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Copilot history root {}: {error}",
                    root.display()
                ))
            }
        }
        let mut files = Vec::new();
        walker.collect_files_bounded(root, &mut files, 1)?;
        for events_path in files {
            let Some(relative) = events_path.strip_prefix(root).ok() else {
                continue;
            };
            let components = relative
                .components()
                .map(|component| match component {
                    Component::Normal(value) => value.to_str(),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>();
            let Some(components) = components else {
                continue;
            };
            let [id, filename] = components.as_slice() else {
                continue;
            };
            if *filename != EVENTS_FILENAME
                || !is_plain_session_dir_name(id)
                || !seen_session_ids.insert((*id).to_string())
            {
                continue;
            }
            ensure_exact_copilot_events_file(&events_path, root, id)?;
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&events_path, "Copilot")?;
            if source_size_bytes > MAX_EVENTS_FILE_BYTES {
                return Err(format!(
                    "Copilot history {} exceeds the {}-byte safety limit",
                    events_path.display(),
                    MAX_EVENTS_FILE_BYTES
                ));
            }
            records.push(CopilotDiscoveredRecord {
                record: ImportedHistoryDiscoveredRecord {
                    source_session_id: (*id).to_string(),
                    source_record_key: (*id).to_string(),
                    source_fingerprint: "copilot-events-v2|db=deferred".to_string(),
                    source_path: events_path,
                    source_mtime_ms,
                    source_size_bytes,
                    parser_version: COPILOT_METADATA_PARSER_VERSION,
                },
                enrichment: CopilotDbEnrichment::default(),
            });
            if records.len() > MAX_DISCOVERED_SESSIONS {
                return Err(format!(
                    "Copilot discovery exceeds the {MAX_DISCOVERED_SESSIONS}-session safety limit"
                ));
            }
        }
    }
    let next = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(conn, SOURCE_COPILOT, &previous, &next)?;
    records.sort_by(|left, right| {
        left.record
            .source_session_id
            .cmp(&right.record.source_session_id)
    });
    Ok(records)
}

/// Copilot session ids are plain hex uuids (`8-4-4-4-12`); the
/// junk dirs ("optimistic-chat-<uuid>", "pending-session:draft:<uuid>") never
/// match this shape.
fn is_plain_session_dir_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn parse_copilot_session_meta(
    discovered: &CopilotDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<ParsedCopilotMeta, String> {
    let record = &discovered.record;
    let enrichment = &discovered.enrichment;
    let events_path = &record.source_path;
    let workspace = read_copilot_workspace(events_path);
    let mut reader = WatermarkedTranscriptReader::open(
        events_path,
        "Copilot",
        watermark,
        COPILOT_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = CopilotMetaState::default();
    let mut resumed = false;
    if let Some(raw) = reader.resume_state_json() {
        if raw.len() <= MAX_PARSE_STATE_BYTES {
            if let Ok(candidate) = serde_json::from_str::<CopilotMetaState>(raw) {
                if candidate.validate().is_ok() {
                    state = candidate;
                    resumed = true;
                }
            }
        }
    }
    if !resumed && reader.resume_state_json().is_some() {
        reader = WatermarkedTranscriptReader::open(
            events_path,
            "Copilot",
            None,
            COPILOT_METADATA_PARSER_VERSION,
            record.source_mtime_ms,
            record.source_size_bytes,
        )?;
    }
    let mut tail_state = None;
    while let Some(line) = reader.next_line()? {
        let Ok(event) = serde_json::from_str::<CopilotEventLine>(line.text.trim()) else {
            continue;
        };
        if line.terminated {
            state.feed(&event)?;
        } else {
            let mut candidate = state.clone();
            candidate.feed(&event)?;
            tail_state = Some(candidate);
        }
    }
    state.validate()?;
    let state_json = serde_json::to_string(&state)
        .map_err(|error| format!("Failed to serialize Copilot parse state: {error}"))?;
    if state_json.len() > MAX_PARSE_STATE_BYTES {
        return Err(format!(
            "Copilot parse state exceeds the {MAX_PARSE_STATE_BYTES}-byte safety limit"
        ));
    }
    let next_watermark = reader.into_watermark(
        COPILOT_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let scan = tail_state.unwrap_or(state);

    let created_at_ms = workspace
        .created_at
        .as_deref()
        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        .or(scan.start_time_ms)
        .or(scan.first_event_ms)
        // `source_mtime_ms` carries NANOSECONDS (see `file_metadata_signature`);
        // scale down for this ms-granularity fallback.
        .unwrap_or(record.source_mtime_ms / 1_000_000);
    let updated_at_ms = scan
        .last_event_ms
        .or_else(|| {
            workspace
                .updated_at
                .as_deref()
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        })
        .unwrap_or(created_at_ms)
        .max(created_at_ms);

    let name = workspace
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(scan.first_user_text.clone())
        .map(|value| imported_history::truncate_name(&value, 200))
        .unwrap_or_else(|| record.source_record_key.clone());

    let repo_path = workspace
        .cwd
        .clone()
        .or(scan.session_start_cwd.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let model = scan
        .last_assistant_model
        .clone()
        .or(scan.last_model_change.clone())
        .or_else(|| {
            enrichment
                .usage
                .iter()
                .rev()
                .find_map(|row| row.model.clone())
        });

    // Cache-row totals: db `input_tokens` is already cache-inclusive and
    // `output_tokens` already includes reasoning (module docs), so both sum
    // directly into the cache-input convention.
    let input_tokens = enrichment
        .usage
        .iter()
        .fold(0_i64, |total, row| total.saturating_add(row.input_tokens));
    let output_tokens = enrichment
        .usage
        .iter()
        .fold(0_i64, |total, row| total.saturating_add(row.output_tokens));
    let cache_read_tokens = enrichment.usage.iter().fold(0_i64, |total, row| {
        total.saturating_add(row.cache_read_tokens)
    });
    let cache_write_tokens = enrichment.usage.iter().fold(0_i64, |total, row| {
        total.saturating_add(row.cache_write_tokens)
    });

    let session_id = super::canonical_session_id(&record.source_session_id);
    // Per-round rows use FRESH input (cache excluded) per the
    // `imported_history_round_usage` convention, so the cache-inclusive db
    // column is unfolded again here.
    let rounds = enrichment
        .usage
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            row.input_tokens > 0
                || row.output_tokens > 0
                || row.cache_read_tokens > 0
                || row.cache_write_tokens > 0
        })
        .map(|(seq, row)| RoundUsage {
            source: SOURCE_COPILOT,
            source_session_id: record.source_session_id.clone(),
            session_id: session_id.clone(),
            seq: seq as i64,
            model: row.model.clone().or_else(|| model.clone()),
            input_tokens: row
                .input_tokens
                .saturating_sub(row.cache_read_tokens)
                .saturating_sub(row.cache_write_tokens),
            output_tokens: row.output_tokens,
            cache_read_tokens: row.cache_read_tokens,
            cache_write_tokens: row.cache_write_tokens,
            created_at_ms: row.created_at_ms,
        })
        .collect();

    Ok(ParsedCopilotMeta {
        meta: CopilotHistoryMeta {
            source_session_id: record.source_session_id.clone(),
            session_id,
            source_path: events_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            source_fingerprint: record.source_fingerprint.clone(),
            name,
            created_at_ms,
            updated_at_ms,
            model,
            repo_path,
            branch: enrichment.branch.clone(),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            rounds,
            impact: scan.impact,
        },
        watermark: next_watermark,
    })
}

fn session_meta_to_cache_input(meta: CopilotHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_COPILOT,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: COPILOT_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
        client_origin: None,
        client_origin_raw: None,
    }
}

impl CopilotMetaState {
    fn feed(&mut self, event: &CopilotEventLine) -> Result<(), String> {
        if let Some(timestamp_ms) =
            imported_history::parse_iso_to_epoch_ms_opt(event.timestamp.trim())
        {
            self.first_event_ms.get_or_insert(timestamp_ms);
            self.last_event_ms = Some(timestamp_ms);
        }
        match event.r#type.as_str() {
            "session.start" => {
                if self.session_start_cwd.is_none() {
                    self.session_start_cwd = event
                        .data
                        .get("context")
                        .and_then(|context| context.get("cwd"))
                        .and_then(Value::as_str)
                        .and_then(|value| bounded_nonempty(value, MAX_PATH_BYTES));
                }
                if self.start_time_ms.is_none() {
                    self.start_time_ms = event
                        .data
                        .get("startTime")
                        .and_then(Value::as_str)
                        .and_then(imported_history::parse_iso_to_epoch_ms_opt);
                }
            }
            "session.model_change" => {
                if let Some(model) = bounded_data_str(&event.data, "newModel", MAX_MODEL_BYTES) {
                    self.last_model_change = Some(model);
                }
            }
            "user.message" => {
                if self.first_user_text.is_none() {
                    self.first_user_text = bounded_data_str(&event.data, "content", 1_024)
                        .map(|text| imported_history::truncate_name(&text, 200));
                }
            }
            "assistant.message" => {
                if let Some(model) = bounded_data_str(&event.data, "model", MAX_MODEL_BYTES) {
                    self.last_assistant_model = Some(model);
                }
                let requests = event
                    .data
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                if requests.len() > MAX_TOOL_REQUESTS_PER_EVENT {
                    return Err(format!(
                        "Copilot event exceeds the {MAX_TOOL_REQUESTS_PER_EVENT}-tool safety limit"
                    ));
                }
                for request in requests {
                    let Some(call_id) = request
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                    else {
                        continue;
                    };
                    let raw_name = request
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                        .unwrap_or_else(|| "tool".to_string());
                    let arguments = request.get("arguments").unwrap_or(&Value::Null);
                    let (canonical_name, args) = map_copilot_tool_call(&raw_name, arguments);
                    if canonical_name != imported_history::FUNCTION_EDIT_FILE {
                        continue;
                    }
                    let call = ImportedToolCall {
                        call_id: call_id.clone(),
                        raw_name,
                        canonical_name,
                        args,
                        created_at: event.timestamp.clone(),
                    };
                    let chunk = imported_history::tool_call_chunk(
                        "copilot-meta",
                        COPILOT_PROVIDER_SLUG,
                        0,
                        &call,
                        "",
                    );
                    let impact = imported_history::impact_from_edit_chunks(&[chunk]);
                    if impact.files_changed == 0 {
                        continue;
                    }
                    if !self.pending_tool_impacts.contains_key(&call_id)
                        && self.pending_tool_impacts.len() >= MAX_PENDING_TOOL_CALLS
                    {
                        return Err(format!(
                            "Copilot metadata exceeds the {MAX_PENDING_TOOL_CALLS}-pending-tool safety limit"
                        ));
                    }
                    self.pending_tool_impacts.insert(call_id, impact);
                }
            }
            "tool.execution_complete" => {
                let Some(call_id) = event
                    .data
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|value| value.len() <= MAX_ID_BYTES)
                else {
                    return Ok(());
                };
                let Some(impact) = self.pending_tool_impacts.remove(call_id) else {
                    return Ok(());
                };
                if event.data.get("success").and_then(Value::as_bool) != Some(false) {
                    merge_impact(&mut self.impact, impact)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), String> {
        if self
            .session_start_cwd
            .as_ref()
            .is_some_and(|value| value.len() > MAX_PATH_BYTES)
            || self
                .first_user_text
                .as_ref()
                .is_some_and(|value| value.len() > 1_024)
            || self
                .last_assistant_model
                .as_ref()
                .is_some_and(|value| value.len() > MAX_MODEL_BYTES)
            || self
                .last_model_change
                .as_ref()
                .is_some_and(|value| value.len() > MAX_MODEL_BYTES)
            || self.pending_tool_impacts.len() > MAX_PENDING_TOOL_CALLS
            || self.impact.touched_files.len() > MAX_TOUCHED_FILES
        {
            return Err("Copilot parse state contains an oversized field".to_string());
        }
        for (call_id, impact) in &self.pending_tool_impacts {
            if call_id.is_empty()
                || call_id.len() > MAX_ID_BYTES
                || impact.touched_files.len() > MAX_TOUCHED_FILES
                || impact
                    .touched_files
                    .iter()
                    .any(|path| path.len() > MAX_PATH_BYTES)
            {
                return Err("Copilot parse state contains invalid tool impact".to_string());
            }
        }
        if self
            .impact
            .touched_files
            .iter()
            .any(|path| path.len() > MAX_PATH_BYTES)
        {
            return Err("Copilot parse state contains an oversized path".to_string());
        }
        Ok(())
    }
}

fn merge_impact(
    target: &mut ImportedHistoryImpactStats,
    incoming: ImportedHistoryImpactStats,
) -> Result<(), String> {
    target.lines_added = target.lines_added.saturating_add(incoming.lines_added);
    target.lines_removed = target.lines_removed.saturating_add(incoming.lines_removed);
    let mut seen = target.touched_files.iter().cloned().collect::<HashSet<_>>();
    for path in incoming.touched_files {
        if path.len() > MAX_PATH_BYTES {
            continue;
        }
        if seen.insert(path.clone()) {
            if target.touched_files.len() >= MAX_TOUCHED_FILES {
                return Err(format!(
                    "Copilot metadata exceeds the {MAX_TOUCHED_FILES}-file safety limit"
                ));
            }
            target.touched_files.push(path);
        }
    }
    target.touched_files.sort();
    target.files_changed = target.touched_files.len() as i64;
    Ok(())
}

fn bounded_nonempty(value: &str, max_bytes: usize) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed.len() <= max_bytes).then(|| trimmed.to_string())
}

fn bounded_data_str(data: &Value, key: &str, max_bytes: usize) -> Option<String> {
    data.get(key)
        .and_then(Value::as_str)
        .and_then(|value| bounded_nonempty(value, max_bytes))
}

fn read_copilot_workspace(events_path: &Path) -> CopilotWorkspaceMeta {
    let Some(session_dir) = events_path.parent() else {
        return CopilotWorkspaceMeta::default();
    };
    let path = session_dir.join(WORKSPACE_FILENAME);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return CopilotWorkspaceMeta::default();
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_WORKSPACE_BYTES
    {
        return CopilotWorkspaceMeta::default();
    }
    let Ok(file) = fs::File::open(path) else {
        return CopilotWorkspaceMeta::default();
    };
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if file
        .take(MAX_WORKSPACE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_WORKSPACE_BYTES
    {
        return CopilotWorkspaceMeta::default();
    }
    std::str::from_utf8(&bytes)
        .ok()
        .map(parse_workspace_yaml)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// session-store.db enrichment (best-effort)
// ---------------------------------------------------------------------------

fn strip_managed_fingerprint(fingerprint: &str) -> &str {
    fingerprint
        .rsplit_once("|managed=")
        .map(|(base, _)| base)
        .unwrap_or(fingerprint)
}

fn read_cached_copilot_fingerprints(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT source_session_id, source_fingerprint
             FROM imported_history_session_cache
             WHERE source = ?1
             LIMIT 20001",
        )
        .map_err(|error| format!("Failed to prepare Copilot fingerprint query: {error}"))?;
    let rows = statement
        .query_map([SOURCE_COPILOT], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Failed to query Copilot fingerprints: {error}"))?;
    let mut fingerprints = HashMap::new();
    for row in rows {
        let (source_session_id, fingerprint) =
            row.map_err(|error| format!("Failed to read Copilot fingerprint: {error}"))?;
        fingerprints.insert(source_session_id, fingerprint);
        if fingerprints.len() > MAX_DISCOVERED_SESSIONS {
            return Err("Copilot cache exceeds the discovery safety limit".to_string());
        }
    }
    Ok(fingerprints)
}

fn read_cached_copilot_enrichment(
    conn: &Connection,
    session_ids: &[String],
) -> Result<HashMap<String, CopilotDbEnrichment>, String> {
    let mut enrichment = HashMap::new();
    if session_ids.is_empty() {
        return Ok(enrichment);
    }
    let placeholders = (2..session_ids.len() + 2)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let params = std::iter::once(SOURCE_COPILOT)
        .chain(session_ids.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let mut statement = conn
        .prepare(&format!(
            "SELECT source_session_id, branch
             FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id IN ({placeholders})"
        ))
        .map_err(|error| format!("Failed to prepare cached Copilot enrichment: {error}"))?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Failed to query cached Copilot enrichment: {error}"))?;
    for row in rows {
        let (session_id, branch) =
            row.map_err(|error| format!("Failed to read cached Copilot enrichment: {error}"))?;
        enrichment.entry(session_id).or_default().branch =
            bounded_nonempty(&branch, MAX_PATH_BYTES);
    }

    let params = std::iter::once(SOURCE_COPILOT)
        .chain(session_ids.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let mut statement = conn
        .prepare(&format!(
            "SELECT source_session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, created_at_ms
             FROM imported_history_round_usage
             WHERE source = ?1 AND source_session_id IN ({placeholders})
             ORDER BY source_session_id, seq
             LIMIT {}",
            MAX_DB_USAGE_ROWS + 1
        ))
        .map_err(|error| format!("Failed to prepare cached Copilot rounds: {error}"))?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                CopilotUsageRow {
                    model: row
                        .get::<_, Option<String>>(1)?
                        .and_then(|value| bounded_nonempty(&value, MAX_MODEL_BYTES)),
                    input_tokens: row
                        .get::<_, i64>(2)?
                        .max(0)
                        .saturating_add(row.get::<_, i64>(4)?.max(0))
                        .saturating_add(row.get::<_, i64>(5)?.max(0)),
                    output_tokens: row.get::<_, i64>(3)?.max(0),
                    cache_read_tokens: row.get::<_, i64>(4)?.max(0),
                    cache_write_tokens: row.get::<_, i64>(5)?.max(0),
                    created_at_ms: row.get::<_, i64>(6)?,
                },
            ))
        })
        .map_err(|error| format!("Failed to query cached Copilot rounds: {error}"))?;
    let mut count = 0usize;
    for row in rows {
        count = count.saturating_add(1);
        if count > MAX_DB_USAGE_ROWS {
            return Err("Cached Copilot usage exceeds the safety limit".to_string());
        }
        let (session_id, usage) =
            row.map_err(|error| format!("Failed to read cached Copilot round: {error}"))?;
        enrichment.entry(session_id).or_default().usage.push(usage);
    }
    Ok(enrichment)
}

/// Read branch/repository and per-request usage only for the bounded set of
/// cache candidates. `None` means the live database could not be read, so the
/// caller preserves the last cached enrichment instead of clearing tokens on
/// a transient lock or partial schema.
fn read_copilot_store_enrichment(
    db_path: Option<&Path>,
    session_ids: &[String],
) -> Option<HashMap<String, CopilotDbEnrichment>> {
    let mut enrichment = HashMap::new();
    if session_ids.is_empty() {
        return Some(enrichment);
    }
    let db_path = db_path?;
    let metadata = fs::symlink_metadata(db_path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    };
    let Ok(conn) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return None;
    };
    // Short busy timeout: tolerate a briefly-writing live CLI without ever
    // stalling a scan on a held lock.
    let _ = conn.busy_timeout(Duration::from_millis(250));
    // Usage totals must be all-or-nothing: keeping a prefix after the global
    // row cap would under-report spend. A missing/locked/oversized usage table
    // therefore preserves the previous cache snapshot. Branch enrichment is
    // optional once that complete usage read has succeeded.
    read_copilot_usage_rows(&conn, session_ids, &mut enrichment).ok()?;
    let _ = read_copilot_session_rows(&conn, session_ids, &mut enrichment);
    Some(enrichment)
}

fn read_copilot_session_rows(
    conn: &Connection,
    session_ids: &[String],
    enrichment: &mut HashMap<String, CopilotDbEnrichment>,
) -> Result<(), String> {
    let placeholders = (1..=session_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, repository, branch FROM sessions WHERE id IN ({placeholders})"
        ))
        .map_err(|error| format!("Failed to prepare Copilot session-store query: {error}"))?;
    let rows = stmt
        .query_map(params_from_iter(session_ids.iter()), |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| format!("Failed to query Copilot session-store rows: {error}"))?;
    for row in rows {
        let (id, repository, branch) =
            row.map_err(|error| format!("Failed to read Copilot session-store row: {error}"))?;
        if !is_plain_session_dir_name(id.trim()) {
            continue;
        }
        let entry = enrichment.entry(id).or_default();
        entry.repository = repository.and_then(|value| bounded_nonempty(&value, MAX_PATH_BYTES));
        entry.branch = branch.and_then(|value| bounded_nonempty(&value, MAX_PATH_BYTES));
    }
    Ok(())
}

fn read_copilot_usage_rows(
    conn: &Connection,
    session_ids: &[String],
    enrichment: &mut HashMap<String, CopilotDbEnrichment>,
) -> Result<(), String> {
    // Rowid order is the round ordinal (`seq`); `created_at` rides along as
    // the round timestamp.
    let placeholders = (1..=session_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT session_id, model, input_tokens, output_tokens, \
                cache_read_tokens, cache_write_tokens, created_at \
         FROM assistant_usage_events
         WHERE session_id IN ({placeholders})
         ORDER BY id
         LIMIT {}",
            MAX_DB_USAGE_ROWS + 1
        ))
        .map_err(|error| format!("Failed to prepare Copilot usage query: {error}"))?;
    let rows = stmt
        .query_map(params_from_iter(session_ids.iter()), |row| {
            let session_id = row.get::<_, Option<String>>(0)?.unwrap_or_default();
            let created_at = row.get::<_, Option<String>>(6)?.unwrap_or_default();
            Ok((
                session_id,
                CopilotUsageRow {
                    model: row
                        .get::<_, Option<String>>(1)?
                        .and_then(|value| bounded_nonempty(&value, MAX_MODEL_BYTES)),
                    input_tokens: row.get::<_, Option<i64>>(2)?.unwrap_or_default().max(0),
                    output_tokens: row.get::<_, Option<i64>>(3)?.unwrap_or_default().max(0),
                    cache_read_tokens: row.get::<_, Option<i64>>(4)?.unwrap_or_default().max(0),
                    cache_write_tokens: row.get::<_, Option<i64>>(5)?.unwrap_or_default().max(0),
                    created_at_ms: imported_history::parse_iso_to_epoch_ms_opt(created_at.trim())
                        .unwrap_or_default(),
                },
            ))
        })
        .map_err(|error| format!("Failed to query Copilot usage rows: {error}"))?;
    let mut count = 0usize;
    for row in rows {
        count = count.saturating_add(1);
        if count > MAX_DB_USAGE_ROWS {
            return Err(format!(
                "Copilot usage enrichment exceeds the {MAX_DB_USAGE_ROWS}-row safety limit"
            ));
        }
        let (session_id, usage) =
            row.map_err(|error| format!("Failed to read Copilot usage row: {error}"))?;
        if !is_plain_session_dir_name(session_id.trim()) {
            continue;
        }
        enrichment.entry(session_id).or_default().usage.push(usage);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// events.jsonl → ActivityChunk conversion
// ---------------------------------------------------------------------------

fn load_copilot_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect Copilot history {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("Unsafe Copilot history path: {}", path.display()));
    }
    let (mtime, size) = imported_paths::file_metadata_signature(path, "Copilot")?;
    if size > MAX_EVENTS_FILE_BYTES {
        return Err("Copilot history exceeds the replay safety limit".to_string());
    }

    let mut tool_results: HashMap<String, (Option<bool>, String)> = HashMap::new();
    let mut tool_start_args: HashMap<String, Value> = HashMap::new();
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Copilot",
        None,
        COPILOT_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    while let Some(line) = reader.next_line()? {
        let Ok(event) = serde_json::from_str::<CopilotEventLine>(line.text.trim()) else {
            continue;
        };
        index_copilot_tool_event(&event, &mut tool_results, &mut tool_start_args)?;
    }

    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Copilot",
        None,
        COPILOT_METADATA_PARSER_VERSION,
        mtime,
        size,
    )?;
    let mut chunks = Vec::new();
    let mut retained_bytes = 0usize;
    let mut sequence = 0usize;
    while let Some(line) = reader.next_line()? {
        let Ok(event) = serde_json::from_str::<CopilotEventLine>(line.text.trim()) else {
            continue;
        };
        append_copilot_event_chunks(
            session_id,
            &event,
            &tool_results,
            &tool_start_args,
            &mut chunks,
            &mut sequence,
            &mut retained_bytes,
        )?;
    }
    Ok(chunks)
}

fn index_copilot_tool_event(
    event: &CopilotEventLine,
    tool_results: &mut HashMap<String, (Option<bool>, String)>,
    tool_start_args: &mut HashMap<String, Value>,
) -> Result<(), String> {
    match event.r#type.as_str() {
        "tool.execution_complete" => {
            if let Some(call_id) = bounded_data_str(&event.data, "toolCallId", MAX_ID_BYTES) {
                if !tool_results.contains_key(&call_id)
                    && tool_results.len() >= MAX_REPLAY_TOOL_RECORDS
                {
                    return Err("Copilot replay exceeds the tool-result safety limit".to_string());
                }
                let success = event.data.get("success").and_then(Value::as_bool);
                let output = tool_result_text(
                    event
                        .data
                        .get("result")
                        .and_then(|result| result.get("content")),
                );
                tool_results.insert(call_id, (success, output));
            }
        }
        "tool.execution_start" => {
            if let Some(call_id) = bounded_data_str(&event.data, "toolCallId", MAX_ID_BYTES) {
                if !tool_start_args.contains_key(&call_id)
                    && tool_start_args.len() >= MAX_REPLAY_TOOL_RECORDS
                {
                    return Err("Copilot replay exceeds the tool-argument safety limit".to_string());
                }
                if let Some(arguments) =
                    event.data.get("arguments").and_then(bounded_tool_arguments)
                {
                    tool_start_args.insert(call_id, arguments);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_copilot_event_chunks(
    session_id: &str,
    event: &CopilotEventLine,
    tool_results: &HashMap<String, (Option<bool>, String)>,
    tool_start_args: &HashMap<String, Value>,
    chunks: &mut Vec<ActivityChunk>,
    sequence: &mut usize,
    retained_bytes: &mut usize,
) -> Result<(), String> {
    let created_at = bounded_nonempty(&event.timestamp, MAX_ID_BYTES).unwrap_or_default();
    match event.r#type.as_str() {
        "user.message" => {
            let Some(text) = event.data.get("content").and_then(Value::as_str) else {
                return Ok(());
            };
            let text = bounded_replay_text(text);
            if text.is_empty() {
                return Ok(());
            }
            let chunk = imported_history::user_message_chunk(
                session_id,
                COPILOT_PROVIDER_SLUG,
                *sequence,
                &created_at,
                &text,
            );
            push_copilot_replay_chunk(chunks, retained_bytes, chunk)?;
            *sequence = sequence.saturating_add(1);
        }
        "assistant.message" => {
            if let Some(text) = event.data.get("content").and_then(Value::as_str) {
                let text = bounded_replay_text(text);
                if !text.is_empty() {
                    let chunk = imported_history::assistant_message_chunk(
                        session_id,
                        COPILOT_PROVIDER_SLUG,
                        *sequence,
                        &created_at,
                        &text,
                    );
                    push_copilot_replay_chunk(chunks, retained_bytes, chunk)?;
                    *sequence = sequence.saturating_add(1);
                }
            }
            let requests = event
                .data
                .get("toolRequests")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if requests.len() > MAX_TOOL_REQUESTS_PER_EVENT {
                return Err("Copilot replay event exceeds the tool safety limit".to_string());
            }
            for request in requests {
                let call_id = request
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                    .unwrap_or_default();
                let raw_name = request
                    .get("name")
                    .and_then(Value::as_str)
                    .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                    .unwrap_or_else(|| "tool".to_string());
                let arguments = request
                    .get("arguments")
                    .filter(|value| !value.is_null())
                    .and_then(bounded_tool_arguments)
                    .or_else(|| tool_start_args.get(&call_id).cloned())
                    .unwrap_or(Value::Null);
                let (canonical_name, args) = map_copilot_tool_call(&raw_name, &arguments);
                let paired = tool_results.get(&call_id);
                let output = paired.map(|(_, output)| output.as_str()).unwrap_or("");
                let call = ImportedToolCall {
                    call_id: call_id.clone(),
                    raw_name,
                    canonical_name,
                    args,
                    created_at: created_at.clone(),
                };
                let mut chunk = imported_history::tool_call_chunk(
                    session_id,
                    COPILOT_PROVIDER_SLUG,
                    *sequence,
                    &call,
                    output,
                );
                if paired.and_then(|(success, _)| *success) == Some(false) {
                    if let Some(result) = chunk.result.as_object_mut() {
                        result.insert("success".to_string(), Value::Bool(false));
                        result.insert("status".to_string(), Value::String("failed".to_string()));
                    }
                }
                push_copilot_replay_chunk(chunks, retained_bytes, chunk)?;
                *sequence = sequence.saturating_add(1);
            }
        }
        _ => {}
    }
    Ok(())
}

fn push_copilot_replay_chunk(
    chunks: &mut Vec<ActivityChunk>,
    retained_bytes: &mut usize,
    chunk: ActivityChunk,
) -> Result<(), String> {
    let chunk_bytes = chunk
        .args
        .to_string()
        .len()
        .saturating_add(chunk.result.to_string().len())
        .saturating_add(chunk.function.len())
        .saturating_add(chunk.created_at.len());
    if chunks.len() >= MAX_REPLAY_CHUNKS
        || retained_bytes.saturating_add(chunk_bytes) > MAX_REPLAY_TEXT_BYTES
    {
        return Err("Copilot replay exceeds the bounded in-memory safety limit".to_string());
    }
    *retained_bytes = retained_bytes.saturating_add(chunk_bytes);
    chunks.push(chunk);
    Ok(())
}

fn bounded_replay_text(text: &str) -> String {
    text.trim().chars().take(MAX_REPLAY_MESSAGE_CHARS).collect()
}

const MAX_TOOL_ARGUMENT_BYTES: usize = 256 * 1024;

fn bounded_tool_arguments(arguments: &Value) -> Option<Value> {
    let encoded = serde_json::to_vec(arguments).ok()?;
    (encoded.len() <= MAX_TOOL_ARGUMENT_BYTES).then(|| arguments.clone())
}

#[cfg(test)]
fn events_to_chunks(session_id: &str, events: &[CopilotEventLine]) -> Vec<ActivityChunk> {
    let mut tool_results = HashMap::new();
    let mut tool_start_args = HashMap::new();
    for event in events {
        index_copilot_tool_event(event, &mut tool_results, &mut tool_start_args)
            .expect("test tool index");
    }
    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    let mut retained_bytes = 0usize;
    for event in events {
        append_copilot_event_chunks(
            session_id,
            event,
            &tool_results,
            &tool_start_args,
            &mut chunks,
            &mut sequence,
            &mut retained_bytes,
        )
        .expect("test replay");
    }
    chunks
}

/// Map a Copilot tool request onto the canonical function names the frontend
/// extractors read. Best-effort: `bash` and the `str_replace_editor` family
/// (`view` / `create` / `str_replace` / `edit` / `insert`, args `path` /
/// `old_str` / `new_str` / `file_text`) reshape into typed cards; anything
/// unknown passes through with its raw name and args so nothing is dropped.
fn map_copilot_tool_call(name: &str, arguments: &Value) -> (String, Value) {
    let args_str = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(MAX_REPLAY_MESSAGE_CHARS)
            .collect::<String>()
    };
    let editor_command = |command: &str| match command {
        "view" => Some((
            imported_history::FUNCTION_READ_FILE.to_string(),
            json!({ "file_path": args_str("path") }),
        )),
        "create" => Some((
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            json!({
                "file_path": args_str("path"),
                "old_string": "",
                "new_string": args_str("file_text"),
            }),
        )),
        "str_replace" | "edit" | "insert" => Some((
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            json!({
                "file_path": args_str("path"),
                "old_string": args_str("old_str"),
                "new_string": args_str("new_str"),
            }),
        )),
        _ => None,
    };

    let mapped = match name {
        "bash" | "shell" => {
            let command = args_str("command");
            (!command.is_empty()).then(|| {
                (
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    json!({ "command": command.clone(), "cmd": command }),
                )
            })
        }
        "str_replace_editor" => editor_command(&args_str("command")),
        "view" | "create" | "str_replace" | "edit" => editor_command(name),
        "grep" => Some((
            imported_history::FUNCTION_CODE_SEARCH.to_string(),
            bounded_tool_arguments(arguments).unwrap_or(Value::Null),
        )),
        "glob" => Some((
            imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
            bounded_tool_arguments(arguments).unwrap_or(Value::Null),
        )),
        _ => None,
    };
    mapped.unwrap_or_else(|| {
        (
            name.chars().take(MAX_ID_BYTES).collect(),
            bounded_tool_arguments(arguments).unwrap_or(Value::Null),
        )
    })
}

/// Flatten a `tool.execution_complete` `result.content` value (a plain string
/// in every observed store; tolerate arrays/objects defensively) into capped
/// text.
fn tool_result_text(content: Option<&Value>) -> String {
    fn append(value: &Value, out: &mut String, remaining: &mut usize) {
        if *remaining == 0 {
            return;
        }
        match value {
            Value::String(text) => {
                if !text.trim().is_empty() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    let fragment = text.trim().chars().take(*remaining).collect::<String>();
                    *remaining = remaining.saturating_sub(fragment.chars().count());
                    out.push_str(&fragment);
                }
            }
            Value::Array(items) => {
                for item in items {
                    append(item, out, remaining);
                    if *remaining == 0 {
                        break;
                    }
                }
            }
            Value::Null => {}
            other => append(&Value::String(other.to_string()), out, remaining),
        }
    }
    let mut out = String::new();
    let mut remaining = MAX_TOOL_OUTPUT_CHARS;
    if let Some(content) = content {
        append(content, &mut out, &mut remaining);
    }
    if remaining == 0 {
        out.push_str("\n… (truncated)");
    }
    out
}

// ---------------------------------------------------------------------------
// workspace.yaml (flat, hand-parsed — no YAML dependency)
// ---------------------------------------------------------------------------

fn parse_workspace_yaml(raw: &str) -> CopilotWorkspaceMeta {
    let mut meta = CopilotWorkspaceMeta::default();
    for line in raw.lines() {
        // The sidecar is flat `key: value`; skip blanks, comments, and any
        // indented (nested) line defensively.
        if line.trim().is_empty() || line.trim_start().starts_with('#') || line.starts_with(' ') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = unquote_yaml_scalar(value);
        match key.trim() {
            "cwd" => meta.cwd = bounded_nonempty(&value, MAX_PATH_BYTES),
            "name" => meta.name = bounded_nonempty(&value, 1_024),
            "created_at" => meta.created_at = bounded_nonempty(&value, MAX_ID_BYTES),
            "updated_at" => meta.updated_at = bounded_nonempty(&value, MAX_ID_BYTES),
            _ => {}
        }
    }
    meta
}

/// Trim and unquote a YAML scalar: single-quoted values (the CLI's style,
/// e.g. `name: 'Reply with exactly: OK'`) un-double their embedded `''`;
/// double-quoted values unescape `\"`. Plain scalars pass through trimmed.
fn unquote_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(inner) = trimmed
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        return inner.replace("''", "'");
    }
    if let Some(inner) = trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        return inner.replace("\\\"", "\"");
    }
    trimmed.to_string()
}

// ---------------------------------------------------------------------------
// Paths + id resolution
// ---------------------------------------------------------------------------

fn copilot_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(rest) = session_id.strip_prefix(COPILOT_SESSION_PREFIX) else {
        return Err(format!("Invalid Copilot history session id: {session_id}"));
    };
    if !is_plain_session_dir_name(rest) {
        return Err(format!("Invalid Copilot source session id: {rest}"));
    }
    Ok(rest)
}

fn resolve_copilot_events_path(
    _conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if !is_plain_session_dir_name(source_session_id) {
        return Err(format!(
            "Invalid Copilot source session id: {source_session_id}"
        ));
    }
    for root in copilot_session_state_dirs()? {
        let candidate = root.join(source_session_id).join(EVENTS_FILENAME);
        if ensure_exact_copilot_events_file(&candidate, &root, source_session_id).is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Copilot history file not found for session: {source_session_id}"
    ))
}

fn ensure_exact_copilot_events_file(
    path: &Path,
    root: &Path,
    source_session_id: &str,
) -> Result<(), String> {
    if !is_plain_session_dir_name(source_session_id) {
        return Err("Invalid Copilot session directory name".to_string());
    }
    let expected = root.join(source_session_id).join(EVENTS_FILENAME);
    if path != expected {
        return Err(format!(
            "Unexpected Copilot history path: {}",
            path.display()
        ));
    }
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Failed to inspect Copilot history root: {error}"))?;
    let session_metadata = fs::symlink_metadata(root.join(source_session_id))
        .map_err(|error| format!("Failed to inspect Copilot session directory: {error}"))?;
    let file_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Copilot events file: {error}"))?;
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || session_metadata.file_type().is_symlink()
        || !session_metadata.is_dir()
        || file_metadata.file_type().is_symlink()
        || !file_metadata.is_file()
    {
        return Err(format!("Unsafe Copilot history path: {}", path.display()));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve Copilot history root: {error}"))?;
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve Copilot events path: {error}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!(
            "Copilot history escapes its source root: {}",
            path.display()
        ));
    }
    Ok(())
}

fn copilot_session_state_dirs() -> Result<Vec<PathBuf>, String> {
    let home = app_paths::external_history_home_dir();
    Ok(copilot_session_state_dir_candidates(&home))
}

/// `~/.copilot/session-state` — one dir per session.
fn copilot_session_state_dir_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".copilot").join("session-state")]
}

fn copilot_session_store_db_path() -> Option<PathBuf> {
    Some(
        app_paths::external_history_home_dir()
            .join(".copilot")
            .join("session-store.db"),
    )
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
