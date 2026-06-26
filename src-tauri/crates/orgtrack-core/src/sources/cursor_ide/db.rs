//! Cursor IDE metadata cache and delta sync.
//!
//! Cursor owns `state.vscdb`; this module opens it read-only, parses only
//! composer metadata rows, and stores normalized session metadata in the shared
//! external-history cache table. Full bubble/transcript content stays in
//! Cursor's DB and is loaded lazily by `history.rs`.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use chrono::TimeZone;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    cache as source_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
        SOURCE_CURSOR_IDE,
    },
};

use super::io::cursor_db_path;

static LAST_SYNC: Mutex<Option<SyncSnapshot>> = Mutex::new(None);
const SYNC_COOLDOWN: Duration = Duration::from_secs(60);
const RECENT_TERMINAL_RESYNC_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const TERMINAL_STATUSES: &[&str] = &["completed", "aborted", "cancelled", "failed"];
const CURSOR_IDE_METADATA_PARSER_VERSION: i64 = 2;
const COMPOSER_KEY_PREFIX: &str = "composerData:";
const BUBBLE_KEY_PREFIX: &str = "bubbleId:";
const SOURCE_RECORD_KEY_PREFIX: &str = "cursorDiskKV:";

#[derive(Debug, Clone, Copy)]
struct SyncSnapshot {
    synced_at: Instant,
    cursor_db_modified_at: Option<SystemTime>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComposerData {
    #[serde(default)]
    composer_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    last_updated_at: i64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    is_agentic: bool,
    #[serde(default)]
    unified_mode: String,
    #[serde(default)]
    model_config: Option<ModelConfig>,
    #[serde(default)]
    total_lines_added: i64,
    #[serde(default)]
    total_lines_removed: i64,
    #[serde(default)]
    files_changed_count: i64,
    #[serde(default)]
    context_tokens_used: f64,
    #[serde(default)]
    full_conversation_headers_only: Vec<BubbleHeader>,
    #[serde(default)]
    subagent_info: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BubbleHeader {
    #[serde(default)]
    bubble_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BubbleTimestamp {
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfig {
    #[serde(default)]
    model_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorCacheMetadata {
    status: String,
    is_agentic: bool,
    mode: String,
}

#[derive(Debug, Clone)]
struct CursorDiscoveredComposer {
    source_session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    raw: RawComposerData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSession {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_active_at: i64,
    pub status: String,
    pub is_agentic: bool,
    pub mode: String,
    pub model: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
    pub tokens_used: i64,
}

pub fn get_cursor_sessions(
    cache_conn: &mut Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<CursorSession>, String> {
    delta_sync(cache_conn)?;
    let start_epoch = date_str_to_epoch_ms(start_date);
    let end_epoch = date_str_to_epoch_ms_end(end_date);
    source_cache::query_cached_sessions_in_range_from_conn(
        cache_conn,
        SOURCE_CURSOR_IDE,
        start_epoch,
        end_epoch,
    )?
    .into_iter()
    .map(cursor_session_from_cached)
    .collect()
}

pub fn list_for_sidebar(
    cache_conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<(Vec<CursorSession>, bool), String> {
    list_for_sidebar_filtered(cache_conn, limit, offset, |_| Ok(true))
}

pub fn get_cached_session(
    cache_conn: &mut Connection,
    session_id: &str,
) -> Result<Option<CursorSession>, String> {
    delta_sync(cache_conn)?;
    source_cache::query_cached_session_from_conn(cache_conn, SOURCE_CURSOR_IDE, session_id)?
        .map(cursor_session_from_cached)
        .transpose()
}

pub fn list_for_sidebar_filtered<F>(
    cache_conn: &mut Connection,
    limit: usize,
    offset: usize,
    mut include: F,
) -> Result<(Vec<CursorSession>, bool), String>
where
    F: FnMut(&CursorSession) -> Result<bool, String>,
{
    delta_sync(cache_conn)?;

    let rows =
        source_cache::query_cached_sessions_for_source_from_conn(cache_conn, SOURCE_CURSOR_IDE)?;
    let mut matched = Vec::with_capacity(limit.saturating_add(1));
    let mut skipped = 0usize;

    for row in rows {
        let session = cursor_session_from_cached(row)?;
        if !include(&session)? {
            continue;
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        matched.push(session);
        if matched.len() > limit {
            break;
        }
    }

    let has_more = matched.len() > limit;
    if has_more {
        matched.truncate(limit);
    }
    Ok((matched, has_more))
}

fn delta_sync(cache_conn: &mut Connection) -> Result<(), String> {
    let now = Instant::now();
    let cursor_path = match cursor_db_path() {
        Some(path) => path,
        None => return Ok(()),
    };
    let cursor_db_modified_at = cursor_path
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok();

    if let Ok(guard) = LAST_SYNC.lock() {
        if let Some(last) = *guard {
            if now.duration_since(last.synced_at) < SYNC_COOLDOWN
                && last.cursor_db_modified_at == cursor_db_modified_at
            {
                return Ok(());
            }
        }
    }

    let cursor_conn = super::io::open_cursor_db()
        .ok_or_else(|| "Failed to open Cursor DB for metadata sync".to_string())?;
    let source_path = cursor_path.to_string_lossy().to_string();
    let discovered = discover_cursor_composers(&cursor_conn, &source_path)?;
    let signatures = discovered
        .iter()
        .map(CursorDiscoveredComposer::signature)
        .collect::<Vec<_>>();
    let live_ids = source_cache::live_ids_from_signatures(&signatures);
    let old_terminal_ids = get_old_terminal_cached_ids(cache_conn)?;
    let changed = source_cache::changed_records_from_conn(
        cache_conn,
        SOURCE_CURSOR_IDE,
        &discovered,
        CursorDiscoveredComposer::signature,
    )?;
    let inputs = changed
        .into_iter()
        .filter(|record| !old_terminal_ids.contains(&record.source_session_id))
        .map(|record| composer_to_cache_input(&cursor_conn, record))
        .collect::<Result<Vec<_>, _>>()?;

    source_cache::sync_source_cache_from_conn(cache_conn, SOURCE_CURSOR_IDE, live_ids, inputs)?;
    update_sync_snapshot(now, cursor_db_modified_at);

    Ok(())
}

fn update_sync_snapshot(synced_at: Instant, cursor_db_modified_at: Option<SystemTime>) {
    if let Ok(mut guard) = LAST_SYNC.lock() {
        *guard = Some(SyncSnapshot {
            synced_at,
            cursor_db_modified_at,
        });
    }
}

fn get_old_terminal_cached_ids(conn: &Connection) -> Result<HashSet<String>, String> {
    let now_ms = source_cache::current_epoch_ms()?;
    let cutoff_ms = now_ms - RECENT_TERMINAL_RESYNC_WINDOW.as_millis() as i64;
    let rows = source_cache::query_cached_sessions_for_source_from_conn(conn, SOURCE_CURSOR_IDE)?;
    let mut ids = HashSet::new();
    for row in rows {
        if row.updated_at_ms >= cutoff_ms {
            continue;
        }
        let metadata = cursor_metadata_from_cached(&row)?;
        if TERMINAL_STATUSES.contains(&metadata.status.as_str()) {
            ids.insert(row.source_session_id);
        }
    }
    Ok(ids)
}

fn discover_cursor_composers(
    cursor_conn: &Connection,
    source_path: &str,
) -> Result<Vec<CursorDiscoveredComposer>, String> {
    let mut stmt = cursor_conn
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .map_err(|err| format!("Failed to query Cursor composer metadata: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|err| format!("Failed to read Cursor composer metadata: {err}"))?;

    let mut composers = Vec::new();
    for row in rows {
        let (key, Some(value)) =
            row.map_err(|err| format!("Failed to read Cursor composer metadata row: {err}"))?
        else {
            continue;
        };
        let Some(source_session_id) = key.strip_prefix(COMPOSER_KEY_PREFIX) else {
            continue;
        };
        let raw: RawComposerData = match serde_json::from_str(&value) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if raw.created_at == 0 || raw.composer_id.is_empty() {
            continue;
        }
        let source_fingerprint = cursor_source_fingerprint(&raw);
        composers.push(CursorDiscoveredComposer {
            source_session_id: source_session_id.to_string(),
            source_path: source_path.to_string(),
            source_record_key: format!("{SOURCE_RECORD_KEY_PREFIX}{key}"),
            source_mtime_ms: raw.last_updated_at.max(raw.created_at),
            source_size_bytes: value.len() as i64,
            source_fingerprint,
            raw,
        });
    }
    Ok(composers)
}

fn composer_to_cache_input(
    cursor_conn: &Connection,
    record: &CursorDiscoveredComposer,
) -> Result<ImportedHistoryCacheInput, String> {
    let raw = &record.raw;
    let model = raw
        .model_config
        .as_ref()
        .map(|config| config.model_name.trim())
        .filter(|model_name| !model_name.is_empty())
        .map(str::to_string);
    let last_active_at = cursor_last_active_at(cursor_conn, raw)?;
    let metadata = CursorCacheMetadata {
        status: raw.status.clone(),
        is_agentic: raw.is_agentic,
        mode: raw.unified_mode.clone(),
    };
    let source_metadata_json = serde_json::to_string(&metadata)
        .map_err(|err| format!("Failed to encode Cursor metadata cache payload: {err}"))?;

    Ok(ImportedHistoryCacheInput {
        source: SOURCE_CURSOR_IDE,
        source_session_id: record.source_session_id.clone(),
        session_id: record.source_session_id.clone(),
        source_path: record.source_path.clone(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        name: raw.name.clone(),
        created_at_ms: raw.created_at,
        updated_at_ms: last_active_at,
        model,
        input_tokens: raw.context_tokens_used as i64,
        output_tokens: 0,
        repo_path: None,
        branch: None,
        impact: ImportedHistoryImpactStats {
            files_changed: raw.files_changed_count,
            lines_added: raw.total_lines_added,
            lines_removed: raw.total_lines_removed,
            touched_files: Vec::new(),
        },
        listable: raw.subagent_info.is_none(),
        source_metadata_json: Some(source_metadata_json),
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

fn cursor_session_from_cached(
    row: source_cache::ImportedHistoryCachedSession,
) -> Result<CursorSession, String> {
    let metadata = cursor_metadata_from_cached(&row)?;
    Ok(CursorSession {
        id: row.source_session_id,
        name: row.name,
        created_at: row.created_at_ms,
        last_active_at: row.updated_at_ms,
        status: metadata.status,
        is_agentic: metadata.is_agentic,
        mode: metadata.mode,
        model: row.model.unwrap_or_default(),
        lines_added: row.impact.lines_added,
        lines_removed: row.impact.lines_removed,
        files_changed: row.impact.files_changed,
        tokens_used: row.input_tokens + row.output_tokens,
    })
}

fn cursor_metadata_from_cached(
    row: &source_cache::ImportedHistoryCachedSession,
) -> Result<CursorCacheMetadata, String> {
    let Some(source_metadata_json) = row.source_metadata_json.as_deref() else {
        return Ok(CursorCacheMetadata::default());
    };
    serde_json::from_str(source_metadata_json)
        .map_err(|err| format!("Failed to decode Cursor metadata cache payload: {err}"))
}

fn cursor_source_fingerprint(raw: &RawComposerData) -> String {
    [
        raw.composer_id.as_str(),
        raw.name.as_str(),
        raw.status.as_str(),
        raw.unified_mode.as_str(),
        &raw.created_at.to_string(),
        &raw.last_updated_at.to_string(),
        &raw.is_agentic.to_string(),
        &raw.total_lines_added.to_string(),
        &raw.total_lines_removed.to_string(),
        &raw.files_changed_count.to_string(),
        &raw.context_tokens_used.to_string(),
        &raw.full_conversation_headers_only.len().to_string(),
        &raw.subagent_info.is_some().to_string(),
    ]
    .join("|")
}

impl CursorDiscoveredComposer {
    fn signature(&self) -> ImportedHistoryRecordSignature {
        ImportedHistoryRecordSignature {
            source_session_id: self.source_session_id.clone(),
            source_path: self.source_path.clone(),
            source_mtime_ms: self.source_mtime_ms,
            source_size_bytes: self.source_size_bytes,
            source_fingerprint: self.source_fingerprint.clone(),
            parser_version: CURSOR_IDE_METADATA_PARSER_VERSION,
        }
    }
}

fn date_str_to_epoch_ms(date_str: &str) -> i64 {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return 0;
    }
    let year: i32 = parts[0].parse().unwrap_or(2025);
    let month: u32 = parts[1].parse().unwrap_or(1);
    let day: u32 = parts[2].parse().unwrap_or(1);

    match chrono::NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            let dt = date.and_hms_opt(0, 0, 0).unwrap_or_default();
            let local = chrono::Local
                .from_local_datetime(&dt)
                .single()
                .unwrap_or_else(chrono::Local::now);
            local.timestamp_millis()
        }
        None => 0,
    }
}

fn date_str_to_epoch_ms_end(date_str: &str) -> i64 {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return i64::MAX;
    }
    let year: i32 = parts[0].parse().unwrap_or(2025);
    let month: u32 = parts[1].parse().unwrap_or(1);
    let day: u32 = parts[2].parse().unwrap_or(1);

    match chrono::NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            let dt = date.and_hms_opt(23, 59, 59).unwrap_or_default();
            let local = chrono::Local
                .from_local_datetime(&dt)
                .single()
                .unwrap_or_else(chrono::Local::now);
            local.timestamp_millis()
        }
        None => i64::MAX,
    }
}

fn parse_iso_to_epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_composer_detects_subagent_info_when_present() {
        let json = r#"{
            "composerId": "c6f60eb9-575a-4478-aef7-037ee6c9f620",
            "name": "Cleanup bucket A",
            "createdAt": 1746150752293,
            "status": "completed",
            "contextTokensUsed": 12345.0,
            "subagentInfo": {
                "subagentType": 3,
                "subagentTypeName": "generalPurpose",
                "parentComposerId": "df05eda5-7f2e-40d1-9e15-1667a1c49af2"
            }
        }"#;
        let row: RawComposerData = serde_json::from_str(json).expect("parse");
        assert!(row.subagent_info.is_some());
    }

    #[test]
    fn raw_composer_treats_missing_subagent_info_as_top_level() {
        let json = r#"{
            "composerId": "df05eda5-7f2e-40d1-9e15-1667a1c49af2",
            "name": "User-initiated session",
            "createdAt": 1746150752293,
            "status": "completed",
            "contextTokensUsed": 0.0
        }"#;
        let row: RawComposerData = serde_json::from_str(json).expect("parse");
        assert!(row.subagent_info.is_none());
    }

    #[test]
    fn raw_composer_treats_null_subagent_info_as_top_level() {
        let json = r#"{
            "composerId": "abc",
            "name": "Top-level",
            "createdAt": 1,
            "status": "",
            "contextTokensUsed": 0.0,
            "subagentInfo": null
        }"#;
        let row: RawComposerData = serde_json::from_str(json).expect("parse");
        assert!(row.subagent_info.is_none());
    }

    #[test]
    fn cursor_cache_metadata_round_trips() {
        let metadata = CursorCacheMetadata {
            status: "completed".to_string(),
            is_agentic: true,
            mode: "agent".to_string(),
        };
        let encoded = serde_json::to_string(&metadata).expect("encode");
        let decoded: CursorCacheMetadata = serde_json::from_str(&encoded).expect("decode");

        assert_eq!(decoded.status, "completed");
        assert!(decoded.is_agentic);
        assert_eq!(decoded.mode, "agent");
    }
}
