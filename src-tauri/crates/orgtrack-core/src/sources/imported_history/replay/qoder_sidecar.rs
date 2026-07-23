//! Incremental, compact replay index for Qoder's trajectory sidecars.
//!
//! Qoder's conversation JSONL omits most tool activity. The missing data is
//! spread across per-launch `agent.log` and exthost logs shared by every
//! session. This adapter acknowledges only complete records, persists compact
//! source locators (never whole log bodies), and replays the old conservative
//! content/window attribution rules from SQLite rows.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::development_artifact::{
    attach_replay_git_artifacts, parse_git_artifacts_from_tool_payload,
};
use crate::sources::imported_history::{self, ImportedToolCall};
use crate::sources::qoder::log_enrichment::{
    self, ContentSignal, LogEvent, CALL_ID_PAIR_MS, WINDOW_PAD_MS,
};

use super::jsonl_driver::{
    compact_tool_args, content_hash, tail_preview, upsert_chunk, QODER_PRIMARY_SEQUENCE_STEP,
};
use super::payload_artifact;
use super::{
    replay_payload_body_projection, ImportedHistorySourceId, ReplayPayloadDescriptor,
    ReplayPayloadEncoding, ReplayPayloadKind, ReplaySourceSpan, ReplayStats,
    NORMAL_PAYLOAD_PREVIEW_BYTES, SHELL_PAYLOAD_PREVIEW_BYTES,
};

const SIDECAR_CURSOR_VERSION: u32 = 1;
const BOUNDARY_BYTES: u64 = 4 * 1024;
const SEQUENCE_EPOCH_MS: i64 = 1_577_836_800_000; // 2020-01-01 UTC
const SEQUENCE_TIE_SLOTS: i64 = 256;
const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;
const RAW_TABLE: &str = "imported_replay_qoder_log_events";

pub(super) fn watch_paths(source_session_id: &str, transcript_path: &Path) -> Vec<PathBuf> {
    let task_dir_name = source_session_id
        .split_once('/')
        .map_or(source_session_id, |(_, task)| task);
    let mut paths = log_enrichment::replay_sidecar_watch_paths(task_dir_name);
    if let Some(project_dir) = transcript_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    {
        let spill_root = project_dir.join("agent-tools");
        if spill_root.is_dir() {
            paths.push(spill_root);
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

#[derive(Debug, Clone)]
pub(super) struct SidecarProbe {
    files: Vec<ProbedFile>,
    pub(super) signature: String,
    edit_signature: String,
}

#[derive(Debug, Clone)]
struct ProbedFile {
    path: PathBuf,
    identity: String,
    size_bytes: u64,
    mtime_ns: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct QoderSidecarCursor {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    signature: String,
    #[serde(default)]
    edit_signature: String,
    #[serde(default)]
    files: Vec<SidecarFileCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SidecarFileCursor {
    path: String,
    identity: String,
    byte_offset: u64,
    boundary_fingerprint: String,
}

#[derive(Debug)]
pub(super) struct SidecarSyncOutcome {
    pub cursor: QoderSidecarCursor,
    pub changed: bool,
}

#[derive(Debug)]
struct RawRow {
    source_key: String,
    source_path: PathBuf,
    source_start: u64,
    source_end: u64,
}

#[derive(Debug)]
struct PendingTool {
    ts_ms: i64,
    source_key: String,
    source_span: ReplaySourceSpan,
    call_id: String,
    name: String,
    args: Value,
    output: String,
}

/// A bounded stat-only probe. It reads no log contents and is therefore safe
/// on the unchanged 60-second integrity path.
pub(super) fn probe(source_session_id: &str) -> Result<SidecarProbe, String> {
    let task_dir_name = source_session_id
        .split_once('/')
        .map_or(source_session_id, |(_, task)| task);
    let mut files = Vec::new();
    for path in log_enrichment::qoder_launch_log_paths() {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "stat Qoder replay sidecar {}: {error}",
                    path.display()
                ))
            }
        };
        let canonical = fs::canonicalize(&path).unwrap_or(path);
        files.push(ProbedFile {
            identity: file_identity(&canonical, &metadata),
            size_bytes: metadata.len(),
            mtime_ns: metadata_mtime_ns(&metadata),
            path: canonical,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
    let edit_signature = log_enrichment::edit_store_signature(task_dir_name, None);
    let mut parts = Vec::with_capacity(files.len().saturating_mul(4).saturating_add(1));
    for file in &files {
        parts.push(file.path.to_string_lossy().into_owned());
        parts.push(file.identity.clone());
        parts.push(file.size_bytes.to_string());
        parts.push(file.mtime_ns.to_string());
    }
    parts.push(edit_signature.clone());
    let refs = parts.iter().map(String::as_bytes).collect::<Vec<_>>();
    Ok(SidecarProbe {
        signature: content_hash(&refs),
        edit_signature,
        files,
    })
}

pub(super) fn cursor_signature(cursor_json: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Wrapper {
        #[serde(default)]
        qoder_sidecar: QoderSidecarCursor,
    }

    serde_json::from_str::<Wrapper>(cursor_json)
        .ok()
        .map(|wrapper| wrapper.qoder_sidecar.signature)
}

/// Replacement/truncation/removal invalidates source locators and requires a
/// generation reset. Ordinary append and newly-created launch logs do not.
pub(super) fn cursor_lineage_matches(cursor_json: &str, probe: &SidecarProbe) -> bool {
    #[derive(Deserialize)]
    struct Wrapper {
        #[serde(default)]
        qoder_sidecar: QoderSidecarCursor,
    }

    let Ok(wrapper) = serde_json::from_str::<Wrapper>(cursor_json) else {
        return false;
    };
    if wrapper.qoder_sidecar.version != SIDECAR_CURSOR_VERSION {
        return false;
    }
    wrapper.qoder_sidecar.files.iter().all(|cursor| {
        let Some(current) = probe
            .files
            .iter()
            .find(|file| file.path.to_string_lossy() == cursor.path)
        else {
            return false;
        };
        current.identity == cursor.identity
            && current.size_bytes >= cursor.byte_offset
            && boundary_fingerprint(&current.path, cursor.byte_offset)
                .is_ok_and(|fingerprint| fingerprint == cursor.boundary_fingerprint)
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    previous: &QoderSidecarCursor,
    primary_changed: bool,
    stats: &mut ReplayStats,
) -> Result<SidecarSyncOutcome, String> {
    ensure_raw_table(tx)?;
    let probe = probe(source_session_id)?;
    if !primary_changed
        && previous.version == SIDECAR_CURSOR_VERSION
        && previous.signature == probe.signature
        && previous.edit_signature == probe.edit_signature
    {
        return Ok(SidecarSyncOutcome {
            cursor: previous.clone(),
            changed: false,
        });
    }

    tx.execute(
        &format!("DELETE FROM {RAW_TABLE} WHERE source_session_id=?1 AND generation<>?2"),
        params![source_session_id, generation],
    )
    .map_err(|error| format!("retire Qoder sidecar raw generation: {error}"))?;

    let previous_by_path = previous
        .files
        .iter()
        .map(|cursor| (cursor.path.as_str(), cursor))
        .collect::<HashMap<_, _>>();
    let mut file_cursors = Vec::with_capacity(probe.files.len());
    let mut raw_changed = false;
    for file in &probe.files {
        let path_text = file.path.to_string_lossy();
        let byte_offset = previous_by_path
            .get(path_text.as_ref())
            .filter(|cursor| cursor.identity == file.identity)
            .map_or(0, |cursor| cursor.byte_offset);
        let (new_offset, inserted) =
            ingest_file(tx, source_session_id, generation, file, byte_offset, stats)?;
        raw_changed |= inserted;
        file_cursors.push(SidecarFileCursor {
            path: path_text.into_owned(),
            identity: file.identity.clone(),
            byte_offset: new_offset,
            boundary_fingerprint: boundary_fingerprint(&file.path, new_offset)?,
        });
    }

    let rendered_changed =
        if raw_changed || primary_changed || previous.edit_signature != probe.edit_signature {
            fold_sidecar_events(
                tx,
                display_session_id,
                source_session_id,
                generation,
                write_revision,
                stats,
            )?
        } else {
            false
        };
    Ok(SidecarSyncOutcome {
        cursor: QoderSidecarCursor {
            version: SIDECAR_CURSOR_VERSION,
            signature: probe.signature,
            edit_signature: probe.edit_signature,
            files: file_cursors,
        },
        // Raw locator progress is persisted in the cursor, but only visible
        // replay mutations advance the public revision.
        changed: rendered_changed,
    })
}

fn ensure_raw_table(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {RAW_TABLE} (
            source_session_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            source_key TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_start INTEGER NOT NULL,
            source_end INTEGER NOT NULL,
            ts_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            task_id TEXT NOT NULL DEFAULT '',
            call_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(source_session_id,generation,source_key)
         );
         CREATE INDEX IF NOT EXISTS idx_qoder_replay_log_time
           ON {RAW_TABLE}(source_session_id,generation,ts_ms,source_key);
         CREATE INDEX IF NOT EXISTS idx_qoder_replay_log_task
           ON {RAW_TABLE}(source_session_id,generation,task_id,kind,ts_ms);"
    ))
    .map_err(|error| format!("initialize Qoder sidecar compact index: {error}"))
}

fn ingest_file(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    file: &ProbedFile,
    start_offset: u64,
    stats: &mut ReplayStats,
) -> Result<(u64, bool), String> {
    let opened = fs::File::open(&file.path)
        .map_err(|error| format!("open Qoder sidecar {}: {error}", file.path.display()))?;
    let mut reader = BufReader::new(opened);
    reader
        .seek(SeekFrom::Start(start_offset))
        .map_err(|error| format!("seek Qoder sidecar {}: {error}", file.path.display()))?;
    let mut acknowledged = start_offset;
    let mut inserted_any = false;
    loop {
        let record_start = acknowledged;
        let Some((line, line_bytes)) = read_complete_line(&mut reader)? else {
            break;
        };
        let line_text = String::from_utf8_lossy(trim_line(&line));
        let needs_following = line_text.contains(" ToolInvoke : ");
        let mut record_bytes = line_bytes;
        let following_storage = if needs_following {
            let Some((next, next_bytes)) = read_complete_line(&mut reader)? else {
                break;
            };
            if trim_line(&next).starts_with(b"{") {
                record_bytes = record_bytes.saturating_add(next_bytes);
                Some(next)
            } else {
                reader
                    .seek(SeekFrom::Current(-(next_bytes as i64)))
                    .map_err(|error| format!("rewind Qoder exthost lookahead: {error}"))?;
                None
            }
        } else {
            None
        };
        let following = following_storage
            .as_deref()
            .map(trim_line)
            .map(String::from_utf8_lossy);
        acknowledged = acknowledged.saturating_add(record_bytes as u64);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(record_bytes as u64);
        let (event, _consumed_following) =
            log_enrichment::parse_launch_log_record(&line_text, following.as_deref());
        let Some(event) = event else {
            continue;
        };
        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        let (ts_ms, kind, task_id, call_id) = event_index_fields(&event);
        let source_key = content_hash(&[
            file.identity.as_bytes(),
            &record_start.to_le_bytes(),
            &acknowledged.to_le_bytes(),
        ]);
        let inserted = tx
            .execute(
                &format!(
                    "INSERT OR IGNORE INTO {RAW_TABLE}(
                        source_session_id,generation,source_key,source_path,
                        source_start,source_end,ts_ms,kind,task_id,call_id
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
                ),
                params![
                    source_session_id,
                    generation,
                    source_key,
                    file.path.to_string_lossy(),
                    record_start as i64,
                    acknowledged as i64,
                    ts_ms,
                    kind,
                    task_id,
                    call_id,
                ],
            )
            .map_err(|error| format!("index Qoder sidecar locator: {error}"))?;
        inserted_any |= inserted > 0;
    }
    Ok((acknowledged, inserted_any))
}

fn read_complete_line(reader: &mut impl BufRead) -> Result<Option<(Vec<u8>, usize)>, String> {
    let mut bytes = Vec::new();
    let read = reader
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("read Qoder sidecar line: {error}"))?;
    if read == 0 || bytes.last() != Some(&b'\n') {
        return Ok(None);
    }
    if bytes.len() > MAX_RECORD_BYTES {
        return Ok(Some((Vec::new(), read)));
    }
    Ok(Some((bytes, read)))
}

fn trim_line(bytes: &[u8]) -> &[u8] {
    let without_newline = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    without_newline
        .strip_suffix(b"\r")
        .unwrap_or(without_newline)
}

fn event_index_fields(event: &LogEvent) -> (i64, &'static str, &str, &str) {
    match event {
        LogEvent::Acp {
            ts_ms,
            session_task_id,
            tool_call_id,
        } => (
            *ts_ms,
            "acp",
            session_task_id,
            tool_call_id.as_deref().unwrap_or_default(),
        ),
        LogEvent::Subagent {
            ts_ms,
            session_task_id,
            tool_call_id,
            ..
        } => (*ts_ms, "subagent", session_task_id, tool_call_id),
        LogEvent::ToolInvoke { ts_ms, .. } => (*ts_ms, "invoke", "", ""),
        LogEvent::FileEdit {
            ts_ms,
            session_dir_name,
            ..
        } => (*ts_ms, "file_edit", session_dir_name, ""),
    }
}

#[allow(clippy::too_many_arguments)]
fn fold_sidecar_events(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS imported_qoder_desired_events(
             event_id TEXT PRIMARY KEY
         );
         DELETE FROM imported_qoder_desired_events;",
    )
    .map_err(|error| format!("prepare Qoder desired sidecar set: {error}"))?;
    let (project_dir_name, task_dir_name) = source_session_id
        .split_once('/')
        .unwrap_or(("", source_session_id));
    let Some(task_id) = resolve_full_task_id(tx, source_session_id, generation, task_dir_name)?
    else {
        let changed =
            remove_stale_events(tx, source_session_id, generation, write_revision, stats)?;
        recompute_turn_counts(tx, source_session_id, generation)?;
        return Ok(changed);
    };
    let workspace_path = tx
        .query_row(
            "SELECT repo_path FROM imported_history_session_cache
             WHERE source=?1 AND source_session_id=?2 LIMIT 1",
            params![ImportedHistorySourceId::Qoder.as_str(), source_session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("load Qoder replay workspace: {error}"))?
        .flatten();
    let Some((our_lo, our_hi)) = activity_window(tx, source_session_id, generation, &task_id)?
    else {
        let changed =
            remove_stale_events(tx, source_session_id, generation, write_revision, stats)?;
        recompute_turn_counts(tx, source_session_id, generation)?;
        return Ok(changed);
    };
    let (base_sequence, turn_index) = final_user_anchor(tx, source_session_id, generation)?;
    let last_edit_keys = last_edit_keys(tx, source_session_id, generation, task_dir_name)?;
    let snapshots = if last_edit_keys.is_empty() {
        HashMap::new()
    } else {
        log_enrichment::edit_snapshots_for_task(&task_id)
    };

    let sql = format!(
        "SELECT source_key,source_path,source_start,source_end
         FROM {RAW_TABLE}
         WHERE source_session_id=?1 AND generation=?2
           AND (kind='invoke' OR (kind='subagent' AND task_id=?3)
                OR (kind='file_edit' AND task_id=?4))
         ORDER BY ts_ms,source_key"
    );
    let mut statement = tx
        .prepare(&sql)
        .map_err(|error| format!("prepare Qoder sidecar fold: {error}"))?;
    let mut rows = statement
        .query(params![
            source_session_id,
            generation,
            task_id,
            task_dir_name
        ])
        .map_err(|error| format!("query Qoder sidecar fold: {error}"))?;
    let mut previous_signature: Option<(i64, String)> = None;
    let mut changed = false;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read Qoder sidecar row: {error}"))?
    {
        let raw = RawRow {
            source_key: row.get(0).map_err(|error| error.to_string())?,
            source_path: PathBuf::from(row.get::<_, String>(1).map_err(|error| error.to_string())?),
            source_start: row
                .get::<_, i64>(2)
                .map_err(|error| error.to_string())?
                .max(0) as u64,
            source_end: row
                .get::<_, i64>(3)
                .map_err(|error| error.to_string())?
                .max(0) as u64,
        };
        let Some(event) = read_raw_event(&raw)? else {
            continue;
        };
        let pending = match event {
            LogEvent::Subagent {
                ts_ms,
                tool_call_id,
                agent_type,
                description,
                prompt,
                ..
            } => PendingTool {
                ts_ms,
                source_key: raw.source_key.clone(),
                source_span: ReplaySourceSpan {
                    start: raw.source_start,
                    end: raw.source_end,
                },
                call_id: tool_call_id,
                name: "subagent".to_string(),
                args: json!({
                    "agentType": agent_type,
                    "description": description,
                    "prompt": prompt,
                }),
                output: String::new(),
            },
            LogEvent::ToolInvoke { ts_ms, name, args } => {
                let owned = match log_enrichment::invoke_content_signal(
                    &args,
                    project_dir_name,
                    workspace_path.as_deref(),
                ) {
                    ContentSignal::Ours => true,
                    ContentSignal::Theirs => false,
                    ContentSignal::Silent => {
                        ts_ms >= our_lo.saturating_sub(WINDOW_PAD_MS)
                            && ts_ms <= our_hi.saturating_add(WINDOW_PAD_MS)
                            && !overlaps_other_window(
                                tx,
                                source_session_id,
                                generation,
                                &task_id,
                                ts_ms,
                            )?
                    }
                };
                if !owned {
                    continue;
                }
                PendingTool {
                    ts_ms,
                    source_key: raw.source_key.clone(),
                    source_span: ReplaySourceSpan {
                        start: raw.source_start,
                        end: raw.source_end,
                    },
                    call_id: paired_call_id(tx, source_session_id, generation, &task_id, ts_ms)?
                        .unwrap_or_else(|| format!("invoke-{ts_ms}")),
                    name,
                    output: log_enrichment::spill_file_output(&args),
                    args,
                }
            }
            LogEvent::FileEdit {
                ts_ms,
                path,
                operation,
                ..
            } => {
                let mut args = json!({ "file_path": path, "operation": operation });
                if last_edit_keys.get(&path) == Some(&raw.source_key) {
                    if let Some((old_content, new_content)) = snapshots.get(&path) {
                        if let Some(map) = args.as_object_mut() {
                            map.insert("old_string".to_string(), json!(old_content));
                            map.insert("new_string".to_string(), json!(new_content));
                        }
                    }
                }
                PendingTool {
                    ts_ms,
                    source_key: raw.source_key.clone(),
                    source_span: ReplaySourceSpan {
                        start: raw.source_start,
                        end: raw.source_end,
                    },
                    call_id: paired_call_id(tx, source_session_id, generation, &task_id, ts_ms)?
                        .unwrap_or_else(|| format!("edit-{ts_ms}")),
                    name: format!("file_{operation}"),
                    args,
                    output: String::new(),
                }
            }
            LogEvent::Acp { .. } => continue,
        };
        let signature = serde_json::to_string(&(&pending.name, &pending.args))
            .unwrap_or_else(|_| pending.name.clone());
        if previous_signature
            .as_ref()
            .is_some_and(|(previous_ts, previous)| {
                previous == &signature && (pending.ts_ms - *previous_ts).abs() <= 2_000
            })
        {
            continue;
        }
        previous_signature = Some((pending.ts_ms, signature));
        changed |= upsert_pending(
            tx,
            display_session_id,
            source_session_id,
            generation,
            write_revision,
            base_sequence,
            turn_index,
            pending,
            stats,
        )?;
    }
    drop(rows);
    drop(statement);
    changed |= remove_stale_events(tx, source_session_id, generation, write_revision, stats)?;
    recompute_turn_counts(tx, source_session_id, generation)?;
    Ok(changed)
}

fn resolve_full_task_id(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    task_dir_name: &str,
) -> Result<Option<String>, String> {
    let sql = format!(
        "SELECT DISTINCT task_id FROM {RAW_TABLE}
         WHERE source_session_id=?1 AND generation=?2
           AND kind IN ('acp','subagent') AND task_id<>''"
    );
    let mut statement = tx
        .prepare(&sql)
        .map_err(|error| format!("prepare Qoder task attribution: {error}"))?;
    let mut rows = statement
        .query(params![source_session_id, generation])
        .map_err(|error| format!("query Qoder task attribution: {error}"))?;
    let mut matched = None;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read Qoder task attribution: {error}"))?
    {
        let candidate: String = row.get(0).map_err(|error| error.to_string())?;
        if !candidate.starts_with(task_dir_name) {
            continue;
        }
        match matched.as_deref() {
            None => matched = Some(candidate),
            Some(existing) if existing == candidate => {}
            Some(_) => return Ok(None),
        }
    }
    Ok(matched)
}

fn activity_window(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    task_id: &str,
) -> Result<Option<(i64, i64)>, String> {
    let sql = format!(
        "SELECT MIN(ts_ms),MAX(ts_ms) FROM {RAW_TABLE}
         WHERE source_session_id=?1 AND generation=?2 AND kind='acp' AND task_id=?3"
    );
    tx.query_row(
        &sql,
        params![source_session_id, generation, task_id],
        |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
    )
    .map_err(|error| format!("read Qoder activity window: {error}"))
    .map(|(lo, hi)| lo.zip(hi))
}

fn overlaps_other_window(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    task_id: &str,
    ts_ms: i64,
) -> Result<bool, String> {
    let sql = format!(
        "SELECT EXISTS(
            SELECT 1 FROM (
                SELECT task_id,MIN(ts_ms) AS lo,MAX(ts_ms) AS hi
                FROM {RAW_TABLE}
                WHERE source_session_id=?1 AND generation=?2 AND kind='acp'
                  AND task_id<>?3
                GROUP BY task_id
            ) WHERE ?4 BETWEEN lo-?5 AND hi+?5
         )"
    );
    tx.query_row(
        &sql,
        params![source_session_id, generation, task_id, ts_ms, WINDOW_PAD_MS],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|error| format!("check Qoder overlapping activity: {error}"))
}

fn paired_call_id(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    task_id: &str,
    ts_ms: i64,
) -> Result<Option<String>, String> {
    let sql = format!(
        "SELECT call_id FROM {RAW_TABLE}
         WHERE source_session_id=?1 AND generation=?2 AND kind='acp'
           AND task_id=?3 AND call_id<>'' AND ts_ms<=?4 AND ts_ms>=?5
         ORDER BY ts_ms DESC,source_key DESC LIMIT 1"
    );
    tx.query_row(
        &sql,
        params![
            source_session_id,
            generation,
            task_id,
            ts_ms,
            ts_ms.saturating_sub(CALL_ID_PAIR_MS)
        ],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("pair Qoder tool call id: {error}"))
}

fn final_user_anchor(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
) -> Result<(i64, i64), String> {
    tx.query_row(
        "SELECT sequence,turn_index FROM imported_replay_events
         WHERE source=?1 AND source_session_id=?2 AND generation=?3
           AND function_name=?4
         ORDER BY sequence DESC LIMIT 1",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            generation,
            imported_history::FUNCTION_USER_MESSAGE
        ],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| format!("read Qoder final user anchor: {error}"))
    .map(|anchor| anchor.unwrap_or((0, 0)))
}

fn last_edit_keys(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    task_dir_name: &str,
) -> Result<HashMap<String, String>, String> {
    let sql = format!(
        "SELECT source_key,source_path,source_start,source_end FROM {RAW_TABLE}
         WHERE source_session_id=?1 AND generation=?2
           AND kind='file_edit' AND task_id=?3
         ORDER BY ts_ms,source_key"
    );
    let mut statement = tx
        .prepare(&sql)
        .map_err(|error| format!("prepare Qoder last edits: {error}"))?;
    let mut rows = statement
        .query(params![source_session_id, generation, task_dir_name])
        .map_err(|error| format!("query Qoder last edits: {error}"))?;
    let mut last = HashMap::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read Qoder last edit: {error}"))?
    {
        let raw = RawRow {
            source_key: row.get(0).map_err(|error| error.to_string())?,
            source_path: PathBuf::from(row.get::<_, String>(1).map_err(|error| error.to_string())?),
            source_start: row
                .get::<_, i64>(2)
                .map_err(|error| error.to_string())?
                .max(0) as u64,
            source_end: row
                .get::<_, i64>(3)
                .map_err(|error| error.to_string())?
                .max(0) as u64,
        };
        if let Some(LogEvent::FileEdit { path, .. }) = read_raw_event(&raw)? {
            last.insert(path, raw.source_key);
        }
    }
    Ok(last)
}

fn read_raw_event(raw: &RawRow) -> Result<Option<LogEvent>, String> {
    let length = raw.source_end.saturating_sub(raw.source_start) as usize;
    if length == 0 || length > MAX_RECORD_BYTES.saturating_mul(2) {
        return Ok(None);
    }
    let mut file = fs::File::open(&raw.source_path).map_err(|error| {
        format!(
            "open Qoder indexed log {}: {error}",
            raw.source_path.display()
        )
    })?;
    file.seek(SeekFrom::Start(raw.source_start))
        .map_err(|error| format!("seek Qoder indexed log: {error}"))?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("read Qoder indexed log record: {error}"))?;
    let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
    let first = lines.next().unwrap_or_default();
    let second = lines.next();
    let first = String::from_utf8_lossy(trim_line(first));
    let second = second.map(|line| String::from_utf8_lossy(trim_line(line)));
    Ok(log_enrichment::parse_launch_log_record(&first, second.as_deref()).0)
}

#[allow(clippy::too_many_arguments)]
fn upsert_pending(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    base_sequence: i64,
    turn_index: i64,
    pending: PendingTool,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    let normalized = log_enrichment::normalized_args(&pending.name, &pending.args);
    let call = ImportedToolCall {
        call_id: pending.call_id.clone(),
        raw_name: pending.name.clone(),
        canonical_name: log_enrichment::canonical_tool_name(&pending.name),
        args: normalized.clone(),
        created_at: imported_history::epoch_ms_to_iso(pending.ts_ms),
    };
    let semantic_hash = content_hash(&[
        pending.call_id.as_bytes(),
        pending.name.as_bytes(),
        serde_json::to_string(&normalized)
            .unwrap_or_default()
            .as_bytes(),
    ]);
    let event_id = format!("qoder-log-{semantic_hash}");
    tx.execute(
        "INSERT OR IGNORE INTO imported_qoder_desired_events(event_id) VALUES(?1)",
        params![event_id],
    )
    .map_err(|error| format!("mark desired Qoder replay event: {error}"))?;

    let mut chunk = imported_history::tool_call_chunk(
        display_session_id,
        "qoder-log",
        0,
        &call,
        &pending.output,
    );
    chunk.chunk_id = event_id.clone();
    if let Some(result) = chunk.result.as_object_mut() {
        result.insert("recovered_from".to_string(), json!("agent_log"));
    }
    if call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
        let args_json = serde_json::to_string(&chunk.args).unwrap_or_else(|_| "null".to_string());
        let result_json =
            serde_json::to_string(&chunk.result).unwrap_or_else(|_| "null".to_string());
        let git_artifacts = parse_git_artifacts_from_tool_payload(&args_json, &result_json);
        attach_replay_git_artifacts(&mut chunk.result, &git_artifacts);
    }
    let args_text = serde_json::to_string(&normalized).unwrap_or_else(|_| "{}".to_string());
    let args_limit = if call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    let mut payloads = Vec::new();
    if args_text.len() > args_limit {
        let body_projection = replay_payload_body_projection(
            "args",
            &normalized,
            Some(&args_text),
            args_limit,
            false,
        );
        chunk.args = compact_tool_args(&normalized, &call.canonical_name);
        store_artifact(
            tx,
            source_session_id,
            generation,
            &event_id,
            "args",
            args_text.as_bytes(),
        )?;
        payloads.push(ReplayPayloadDescriptor {
            field_path: "args".to_string(),
            kind: ReplayPayloadKind::ToolArguments,
            encoding: ReplayPayloadEncoding::JsonValue,
            body_projection,
            spans: Vec::new(),
            total_bytes: args_text.len() as u64,
            source_ordinal: None,
            source_key: Some(pending.source_key.clone()),
        });
    } else {
        delete_artifact_ref(tx, source_session_id, generation, &event_id, "args")?;
    }
    let output_limit = if call.canonical_name == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    if pending.output.len() > output_limit {
        let (preview, _) = tail_preview(&pending.output, output_limit);
        if let Some(result) = chunk.result.as_object_mut() {
            result.insert("output".to_string(), json!(preview));
            result.insert("observation".to_string(), json!(preview));
        }
        store_artifact(
            tx,
            source_session_id,
            generation,
            &event_id,
            "result.output",
            pending.output.as_bytes(),
        )?;
        payloads.push(ReplayPayloadDescriptor {
            field_path: "result.output".to_string(),
            kind: ReplayPayloadKind::ToolOutput,
            encoding: ReplayPayloadEncoding::Utf8Text,
            body_projection: None,
            spans: Vec::new(),
            total_bytes: pending.output.len() as u64,
            source_ordinal: None,
            source_key: Some(pending.source_key.clone()),
        });
    } else {
        delete_artifact_ref(
            tx,
            source_session_id,
            generation,
            &event_id,
            "result.output",
        )?;
    }
    let sequence = sidecar_sequence(
        tx,
        source_session_id,
        generation,
        base_sequence,
        pending.ts_ms,
        &event_id,
    )?;
    upsert_chunk(
        tx,
        ImportedHistorySourceId::Qoder,
        source_session_id,
        generation,
        write_revision,
        turn_index,
        sequence,
        &chunk,
        &payloads,
        pending.source_span,
        stats,
    )
}

fn sidecar_sequence(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    base_sequence: i64,
    ts_ms: i64,
    event_id: &str,
) -> Result<i64, String> {
    let elapsed = ts_ms.saturating_sub(SEQUENCE_EPOCH_MS).max(0);
    let hash = content_hash(&[event_id.as_bytes()]);
    let tie = u8::from_str_radix(hash.get(..2).unwrap_or("00"), 16).unwrap_or_default() as i64;
    let mut offset = elapsed
        .saturating_mul(SEQUENCE_TIE_SLOTS)
        .saturating_add(tie)
        .saturating_add(1);
    if offset >= QODER_PRIMARY_SEQUENCE_STEP {
        return Err("Qoder sidecar timestamp exceeds reserved replay sequence range".to_string());
    }
    loop {
        let sequence = base_sequence.saturating_add(offset);
        let occupied = tx
            .query_row(
                "SELECT event_id FROM imported_replay_events
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND sequence=?4",
                params![
                    ImportedHistorySourceId::Qoder.as_str(),
                    source_session_id,
                    generation,
                    sequence
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("allocate Qoder sidecar sequence: {error}"))?;
        if occupied
            .as_deref()
            .is_none_or(|occupied| occupied == event_id)
        {
            return Ok(sequence);
        }
        offset = offset.saturating_add(1);
        if offset % SEQUENCE_TIE_SLOTS == 0 || offset >= QODER_PRIMARY_SEQUENCE_STEP {
            return Err("Too many Qoder sidecar events share one timestamp".to_string());
        }
    }
}

fn store_artifact(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    payload: &[u8],
) -> Result<(), String> {
    payload_artifact::store_bytes(
        tx,
        ImportedHistorySourceId::Qoder,
        source_session_id,
        generation,
        event_id,
        field_path,
        payload,
    )
    .map_err(|error| format!("store Qoder replay payload artifact: {error}"))?;
    Ok(())
}

fn delete_artifact_ref(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_payload_artifact_refs
         WHERE source=?1 AND source_session_id=?2 AND generation=?3
           AND event_id=?4 AND field_path=?5",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            generation,
            event_id,
            field_path
        ],
    )
    .map_err(|error| format!("delete stale Qoder payload reference: {error}"))?;
    Ok(())
}

fn remove_stale_events(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
    write_revision: u64,
    stats: &mut ReplayStats,
) -> Result<bool, String> {
    // Upserts are published immediately after the driver returns. Reserve the
    // following revisions for tombstones now, one row at a time, so an
    // attribution back-off never builds a session-sized removal vector.
    let base_revision = write_revision.saturating_sub(1);
    let pending_upserts = tx
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
               AND event_revision=?4",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                generation,
                write_revision.min(i64::MAX as u64) as i64
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("count pending Qoder replay upserts: {error}"))?
        .max(0) as u64;
    let mut next_revision = base_revision.saturating_add(pending_upserts);
    let mut removed = 0_u64;
    loop {
        let event_id = tx
            .query_row(
                "SELECT event_id FROM imported_replay_events AS event
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3
                   AND event_id LIKE 'qoder-log-%'
                   AND NOT EXISTS(
                     SELECT 1 FROM imported_qoder_desired_events AS desired
                     WHERE desired.event_id=event.event_id
                   )
                 ORDER BY sequence,event_id LIMIT 1",
                params![
                    ImportedHistorySourceId::Qoder.as_str(),
                    source_session_id,
                    generation
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read stale Qoder replay event: {error}"))?;
        let Some(event_id) = event_id else {
            break;
        };
        next_revision = next_revision.saturating_add(1);
        tx.execute(
            "INSERT INTO imported_replay_changes(
                 source,source_session_id,generation,change_revision,
                 event_id,change_kind,sequence
             ) VALUES(?1,?2,?3,?4,?5,'remove',NULL)",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                generation,
                next_revision.min(i64::MAX as u64) as i64,
                event_id
            ],
        )
        .map_err(|error| format!("stage Qoder replay tombstone: {error}"))?;
        tx.execute(
            "DELETE FROM imported_replay_payload_artifact_refs
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                generation,
                event_id
            ],
        )
        .map_err(|error| format!("delete stale Qoder payload refs: {error}"))?;
        tx.execute(
            "DELETE FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                generation,
                event_id
            ],
        )
        .map_err(|error| format!("delete stale Qoder replay event: {error}"))?;
        removed = removed.saturating_add(1);
    }
    tx.execute(
        "DELETE FROM imported_replay_payload_artifacts AS artifact
         WHERE source=?1 AND source_session_id=?2 AND generation=?3
           AND NOT EXISTS(
             SELECT 1 FROM imported_replay_payload_artifact_refs AS ref
             WHERE ref.source=artifact.source
               AND ref.source_session_id=artifact.source_session_id
               AND ref.generation=artifact.generation
               AND ref.content_hash=artifact.content_hash
           )
           AND NOT EXISTS(
             SELECT 1 FROM imported_replay_shell_segments AS shell
             WHERE shell.source=artifact.source
               AND shell.source_session_id=artifact.source_session_id
               AND shell.generation=artifact.generation
               AND shell.content_hash=artifact.content_hash
           )",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            generation
        ],
    )
    .map_err(|error| format!("delete orphan Qoder payload artifacts: {error}"))?;
    stats.removed_events = stats.removed_events.saturating_add(removed);
    Ok(removed > 0)
}

fn recompute_turn_counts(
    tx: &Transaction<'_>,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "UPDATE imported_replay_turns AS turn SET event_count=(
             SELECT COUNT(*) FROM imported_replay_events AS event
             WHERE event.source=turn.source
               AND event.source_session_id=turn.source_session_id
               AND event.generation=turn.generation
               AND event.turn_index=turn.turn_index
         ) WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![
            ImportedHistorySourceId::Qoder.as_str(),
            source_session_id,
            generation
        ],
    )
    .map_err(|error| format!("recount Qoder replay turns: {error}"))?;
    Ok(())
}

fn boundary_fingerprint(path: &Path, offset: u64) -> Result<String, String> {
    if offset == 0 {
        return Ok(content_hash(&[b"empty"]));
    }
    let start = offset.saturating_sub(BOUNDARY_BYTES);
    let mut file = fs::File::open(path)
        .map_err(|error| format!("open Qoder sidecar boundary {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("seek Qoder sidecar boundary: {error}"))?;
    let mut bytes = vec![0; offset.saturating_sub(start) as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("read Qoder sidecar boundary: {error}"))?;
    Ok(content_hash(&[&start.to_le_bytes(), &bytes]))
}

fn file_identity(path: &Path, metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}:{}", path.display(), metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn metadata_mtime_ns(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    use crate::store::sqlite::SqliteRecordStore;

    fn unique_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "orgii-qoder-sidecar-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn fixture_log() -> String {
        [
            r#"2026-07-16 19:42:04.351 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=current_model_update"#,
            r#"2026-07-16 19:42:09.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=tool_call, toolCallId=call-a"#,
            r#"2026-07-16 19:42:09.200 [info] [SubAgentService] Registered SubAgent: {"parentToolCallId":"call-a","parentSessionId":"task-aaa111.session.execution","agentType":"GeneralPurpose","rawInputDescription":"inspect","prompt":"inspect memory"}"#,
            r#"2026-07-16 19:42:09.500 [info] ToolInvoke : run_in_terminal"#,
            r#"{"command":"vm_stat","cwd":"/workspace/a"}"#,
            r#"2026-07-16 19:42:09.600 [info] [ChatSessionService] ACP progress: task-bbb222.session.execution, rid=u, type=current_model_update"#,
            // No path signal while both windows overlap: must stay unowned.
            r#"2026-07-16 19:42:10.000 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-x, grep_search, {"query":"ambiguous"}"#,
            r#"2026-07-16 19:42:11.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=chat_finish"#,
            r#"2026-07-16 19:42:12.000 [info] [ChatSessionService] ACP progress: task-bbb222.session.execution, rid=u, type=chat_finish"#,
        ]
        .join("\n")
            + "\n"
    }

    fn prepare_replay_db(
        conn: &mut rusqlite::Connection,
        source_session_id: &str,
        display_session_id: &str,
    ) {
        SqliteRecordStore::init_tables(conn).expect("replay schema");
        SqliteRecordStore::init_source_cache_tables(conn).expect("source cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,repo_path
             ) VALUES(?1,?2,?3,?4)",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                display_session_id,
                "/workspace/a"
            ],
        )
        .expect("cache row");
        let tx = conn.transaction().expect("primary tx");
        tx.execute(
            "INSERT INTO imported_replay_turns(
                 source,source_session_id,generation,turn_index,turn_id,
                 start_sequence,end_sequence,started_at,event_count
             ) VALUES(?1,?2,'g',0,'qoder-turn-0',0,?3,'2026-07-16T00:00:00Z',0)",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                QODER_PRIMARY_SEQUENCE_STEP - 1
            ],
        )
        .expect("turn");
        let mut stats = ReplayStats::default();
        let user = imported_history::user_message_chunk(
            display_session_id,
            "qoder",
            0,
            "2026-07-16T00:00:00Z",
            "check memory",
        );
        upsert_chunk(
            &tx,
            ImportedHistorySourceId::Qoder,
            source_session_id,
            "g",
            1,
            0,
            0,
            &user,
            &[],
            ReplaySourceSpan { start: 0, end: 1 },
            &mut stats,
        )
        .expect("user");
        let assistant = imported_history::assistant_message_chunk(
            display_session_id,
            "qoder",
            QODER_PRIMARY_SEQUENCE_STEP as usize,
            "2026-07-16T00:00:01Z",
            "done",
        );
        upsert_chunk(
            &tx,
            ImportedHistorySourceId::Qoder,
            source_session_id,
            "g",
            1,
            0,
            QODER_PRIMARY_SEQUENCE_STEP,
            &assistant,
            &[],
            ReplaySourceSpan { start: 2, end: 3 },
            &mut stats,
        )
        .expect("assistant");
        tx.commit().expect("primary commit");
    }

    fn probed_file(path: &Path) -> ProbedFile {
        let metadata = fs::metadata(path).expect("fixture metadata");
        let canonical = fs::canonicalize(path).expect("fixture canonical path");
        ProbedFile {
            identity: file_identity(&canonical, &metadata),
            size_bytes: metadata.len(),
            mtime_ns: metadata_mtime_ns(&metadata),
            path: canonical,
        }
    }

    #[test]
    fn reserved_sequence_is_stable_and_inside_primary_gap() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
        conn.execute_batch(
            "CREATE TABLE imported_replay_events(
                source TEXT,source_session_id TEXT,generation TEXT,sequence INTEGER,event_id TEXT
             );",
        )
        .expect("schema");
        let tx = conn.transaction().expect("tx");
        let first = sidecar_sequence(
            &tx,
            "p/task",
            "g",
            QODER_PRIMARY_SEQUENCE_STEP,
            1_784_691_200_000,
            "qoder-log-a",
        )
        .expect("sequence");
        let second = sidecar_sequence(
            &tx,
            "p/task",
            "g",
            QODER_PRIMARY_SEQUENCE_STEP,
            1_784_691_200_001,
            "qoder-log-b",
        )
        .expect("sequence");
        assert!(first > QODER_PRIMARY_SEQUENCE_STEP);
        assert!(first < QODER_PRIMARY_SEQUENCE_STEP * 2);
        assert!(second > first);
    }

    #[test]
    fn torn_tail_is_not_acknowledged() {
        let mut reader = BufReader::new(&b"complete\npartial"[..]);
        let (_, bytes) = read_complete_line(&mut reader)
            .expect("line")
            .expect("complete");
        assert_eq!(bytes, 9);
        assert!(read_complete_line(&mut reader).expect("tail").is_none());
    }

    #[test]
    fn compact_sidecar_matches_legacy_attribution_and_order() {
        let path = unique_path("differential.log");
        fs::write(&path, fixture_log()).expect("fixture");
        let source_session_id = "project-a/task-aaa";
        let display_session_id = "qoderapp-project-a/task-aaa";
        let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
        prepare_replay_db(&mut conn, source_session_id, display_session_id);
        let tx = conn.transaction().expect("sidecar tx");
        ensure_raw_table(&tx).expect("raw table");
        let mut stats = ReplayStats::default();
        let file = probed_file(&path);
        let (offset, inserted) =
            ingest_file(&tx, source_session_id, "g", &file, 0, &mut stats).expect("ingest");
        assert!(inserted);
        assert_eq!(offset, file.size_bytes);
        assert!(fold_sidecar_events(
            &tx,
            display_session_id,
            source_session_id,
            "g",
            2,
            &mut stats,
        )
        .expect("fold"));
        tx.commit().expect("commit");

        let mut statement = conn
            .prepare(
                "SELECT function_name,args_preview_json,result_preview_json,sequence
                 FROM imported_replay_events
                 WHERE event_id LIKE 'qoder-log-%' ORDER BY sequence",
            )
            .expect("query");
        let indexed = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    serde_json::from_str::<Value>(&row.get::<_, String>(1)?).unwrap(),
                    serde_json::from_str::<Value>(&row.get::<_, String>(2)?).unwrap(),
                    row.get::<_, i64>(3)?,
                ))
            })
            .expect("rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("indexed events");
        assert_eq!(indexed.len(), 2);
        assert_eq!(indexed[0].0, "subagent");
        assert_eq!(indexed[0].1["agentType"], "GeneralPurpose");
        assert_eq!(indexed[0].2["call_id"], "call-a");
        assert_eq!(indexed[1].0, imported_history::FUNCTION_RUN_COMMAND_LINE);
        assert_eq!(indexed[1].1["cmd"], "vm_stat");
        assert!(indexed
            .iter()
            .all(|event| { event.3 > 0 && event.3 < QODER_PRIMARY_SEQUENCE_STEP }));

        let base = vec![
            imported_history::user_message_chunk(
                display_session_id,
                "qoder",
                0,
                "",
                "check memory",
            ),
            imported_history::assistant_message_chunk(display_session_id, "qoder", 1, "", "done"),
        ];
        let legacy = log_enrichment::enrich_chunks_from_log_fixture(
            display_session_id,
            "task-aaa",
            "project-a",
            Some("/workspace/a"),
            base,
            &fixture_log(),
        );
        let legacy_tools = legacy
            .iter()
            .filter(|chunk| chunk.action_type == imported_history::ACTION_TYPE_TOOL_CALL)
            .collect::<Vec<_>>();
        assert_eq!(legacy_tools.len(), indexed.len());
        for (legacy, current) in legacy_tools.iter().zip(indexed.iter()) {
            assert_eq!(legacy.function, current.0);
            assert_eq!(legacy.args, current.1);
            assert_eq!(legacy.result["call_id"], current.2["call_id"]);
            assert_eq!(legacy.result["raw_tool_name"], current.2["raw_tool_name"]);
            assert_eq!(legacy.result["recovered_from"], current.2["recovered_from"]);
        }
        drop(statement);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn append_reads_only_new_complete_bytes_and_upserts_only_new_tool() {
        let path = unique_path("append.log");
        fs::write(&path, fixture_log()).expect("fixture");
        let source_session_id = "project-a/task-aaa";
        let display_session_id = "qoderapp-project-a/task-aaa";
        let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
        prepare_replay_db(&mut conn, source_session_id, display_session_id);
        let first_offset;
        {
            let tx = conn.transaction().expect("initial tx");
            ensure_raw_table(&tx).expect("raw table");
            let mut stats = ReplayStats::default();
            let file = probed_file(&path);
            first_offset = ingest_file(&tx, source_session_id, "g", &file, 0, &mut stats)
                .expect("initial ingest")
                .0;
            fold_sidecar_events(
                &tx,
                display_session_id,
                source_session_id,
                "g",
                2,
                &mut stats,
            )
            .expect("initial fold");
            tx.commit().expect("initial commit");
        }
        let append = [
            r#"2026-07-16 19:42:13.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=tool_call, toolCallId=call-new"#,
            r#"2026-07-16 19:42:13.100 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-new, read_file, {"file_path":"/workspace/a/src/lib.rs"}"#,
        ]
        .join("\n")
            + "\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open append")
            .write_all(append.as_bytes())
            .expect("append");
        let tx = conn.transaction().expect("append tx");
        let mut stats = ReplayStats::default();
        let file = probed_file(&path);
        let (next_offset, inserted) =
            ingest_file(&tx, source_session_id, "g", &file, first_offset, &mut stats)
                .expect("append ingest");
        assert!(inserted);
        assert_eq!(stats.parsed_bytes, append.len() as u64);
        assert_eq!(next_offset, first_offset + append.len() as u64);
        fold_sidecar_events(
            &tx,
            display_session_id,
            source_session_id,
            "g",
            3,
            &mut stats,
        )
        .expect("append fold");
        assert_eq!(stats.upserted_events, 1);
        tx.commit().expect("append commit");

        let tx = conn.transaction().expect("unchanged tx");
        let mut unchanged = ReplayStats::default();
        let file = probed_file(&path);
        let (same_offset, inserted) = ingest_file(
            &tx,
            source_session_id,
            "g",
            &file,
            next_offset,
            &mut unchanged,
        )
        .expect("unchanged ingest");
        assert_eq!(same_offset, next_offset);
        assert!(!inserted);
        assert_eq!(unchanged.parsed_bytes, 0);
        assert_eq!(unchanged.parsed_rows, 0);
        tx.rollback().expect("rollback unchanged");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rotation_or_truncation_breaks_lineage_but_new_log_does_not() {
        let original_path = unique_path("lineage-original.log");
        fs::write(&original_path, fixture_log()).expect("original");
        let original = probed_file(&original_path);
        let cursor = QoderSidecarCursor {
            version: SIDECAR_CURSOR_VERSION,
            signature: "old".to_string(),
            edit_signature: String::new(),
            files: vec![SidecarFileCursor {
                path: original.path.to_string_lossy().into_owned(),
                identity: original.identity.clone(),
                byte_offset: original.size_bytes,
                boundary_fingerprint: boundary_fingerprint(&original.path, original.size_bytes)
                    .expect("boundary"),
            }],
        };
        let cursor_json = json!({ "qoder_sidecar": cursor }).to_string();
        let new_path = unique_path("lineage-new.log");
        fs::write(&new_path, "new launch\n").expect("new log");
        let with_new = SidecarProbe {
            files: vec![original.clone(), probed_file(&new_path)],
            signature: "new".to_string(),
            edit_signature: String::new(),
        };
        assert!(cursor_lineage_matches(&cursor_json, &with_new));

        fs::write(&original_path, "short\n").expect("truncate");
        let truncated = SidecarProbe {
            files: vec![probed_file(&original_path), probed_file(&new_path)],
            signature: "truncated".to_string(),
            edit_signature: String::new(),
        };
        assert!(!cursor_lineage_matches(&cursor_json, &truncated));

        let missing = SidecarProbe {
            files: vec![probed_file(&new_path)],
            signature: "missing".to_string(),
            edit_signature: String::new(),
        };
        assert!(!cursor_lineage_matches(&cursor_json, &missing));
        let _ = fs::remove_file(original_path);
        let _ = fs::remove_file(new_path);
    }

    #[test]
    fn backend_watch_paths_include_transcript_and_project_spill_root_without_duplicates() {
        let root = unique_path("watch-root");
        let transcript = root
            .join("project-a")
            .join("conversation-history")
            .join("task-aaa")
            .join("task-aaa.jsonl");
        let spill_root = root.join("project-a").join("agent-tools");
        fs::create_dir_all(transcript.parent().expect("transcript parent")).expect("history dirs");
        fs::create_dir_all(&spill_root).expect("spill root");
        fs::write(&transcript, "{}\n").expect("transcript");
        let conn = rusqlite::Connection::open_in_memory().expect("DB");
        SqliteRecordStore::init_tables(&conn).expect("schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path
             ) VALUES(?1,?2,?3,?4)",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                "project-a/task-aaa",
                "qoderapp-project-a/task-aaa",
                transcript.to_string_lossy()
            ],
        )
        .expect("cache row");
        let paths = super::super::watch_paths(
            &conn,
            ImportedHistorySourceId::Qoder,
            "qoderapp-project-a/task-aaa",
        )
        .expect("watch paths");
        assert!(paths.contains(&fs::canonicalize(&transcript).expect("canonical transcript")));
        assert!(paths.contains(&fs::canonicalize(&spill_root).expect("canonical spill")));
        let mut unique = paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(paths.len(), unique.len());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unchanged_transcript_sidecar_append_is_delta_and_rotation_is_reset() {
        let transcript_path = unique_path("e2e.jsonl");
        let log_path = unique_path("e2e.log");
        fs::write(
            &transcript_path,
            concat!(
                "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"<user_query>check memory</user_query>\"}]}}\n",
                "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n"
            ),
        )
        .expect("transcript");
        fs::write(&log_path, fixture_log()).expect("log");
        let source_session_id = "project-a/task-aaa";
        let display_session_id = "qoderapp-project-a/task-aaa";
        let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
        SqliteRecordStore::init_tables(&conn).expect("schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                 source,source_session_id,session_id,source_path,repo_path
             ) VALUES(?1,?2,?3,?4,?5)",
            params![
                ImportedHistorySourceId::Qoder.as_str(),
                source_session_id,
                display_session_id,
                transcript_path.to_string_lossy(),
                "/workspace/a"
            ],
        )
        .expect("cache row");
        log_enrichment::with_qoder_log_paths_for_test(vec![log_path.clone()], || {
            let opened = super::super::open_window(
                &mut conn,
                ImportedHistorySourceId::Qoder,
                display_session_id,
                super::super::ReplayLimits::default(),
            )
            .expect("initial open");
            let functions = opened
                .chunks
                .iter()
                .map(|chunk| chunk.chunk.function.as_str())
                .collect::<Vec<_>>();
            assert_eq!(
                functions,
                vec![
                    imported_history::FUNCTION_USER_MESSAGE,
                    "subagent",
                    imported_history::FUNCTION_RUN_COMMAND_LINE,
                    imported_history::FUNCTION_ASSISTANT,
                ]
            );

            let append = [
                r#"2026-07-16 19:42:13.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=tool_call, toolCallId=call-new"#,
                r#"2026-07-16 19:42:13.100 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-new, read_file, {"file_path":"/workspace/a/src/lib.rs"}"#,
            ]
            .join("\n")
                + "\n";
            fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .expect("open append")
                .write_all(append.as_bytes())
                .expect("append");
            let delta = super::super::poll_delta(
                &mut conn,
                ImportedHistorySourceId::Qoder,
                display_session_id,
                &opened.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("append delta");
            assert!(!delta.reset_required);
            assert_eq!(delta.stats.parsed_bytes, append.len() as u64);
            assert_eq!(delta.stats.upserted_events, 1);
            assert_eq!(delta.chunks.len(), 1);
            assert_eq!(
                delta.chunks[0].chunk.function,
                imported_history::FUNCTION_READ_FILE
            );

            let unchanged = super::super::poll_delta(
                &mut conn,
                ImportedHistorySourceId::Qoder,
                display_session_id,
                &delta.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("unchanged poll");
            assert!(!unchanged.reset_required);
            assert!(unchanged.chunks.is_empty());
            assert_eq!(unchanged.stats.parsed_bytes, 0);
            assert_eq!(unchanged.stats.parsed_rows, 0);
            assert_eq!(unchanged.stats.normalized_events, 0);
            assert_eq!(unchanged.stats.upserted_events, 0);

            let ambiguous =
                "2026-07-16 19:42:14.000 [info] [ChatSessionService] ACP progress: task-aaa222.session.execution, rid=u, type=current_model_update\n";
            fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .expect("open ambiguous append")
                .write_all(ambiguous.as_bytes())
                .expect("append ambiguous task");
            let conservative = super::super::poll_delta(
                &mut conn,
                ImportedHistorySourceId::Qoder,
                display_session_id,
                &unchanged.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("ambiguous task delta");
            assert!(!conservative.reset_required);
            assert!(conservative.chunks.is_empty());
            assert_eq!(conservative.stats.removed_events, 3);
            assert_eq!(conservative.removed_event_ids.len(), 3);

            fs::write(
                &log_path,
                concat!(
                    "2026-07-16 20:00:00.000 [info] [ChatSessionService] ACP progress: task-aaa111.session.execution, rid=u, type=current_model_update\n",
                    "2026-07-16 20:00:00.100 [info] [ToolInvokeHandlerContribution] Tool invoke request: rid-r, read_file, {\"file_path\":\"/workspace/a/rotated.rs\"}\n"
                ),
            )
            .expect("rotate");
            let reset = super::super::poll_delta(
                &mut conn,
                ImportedHistorySourceId::Qoder,
                display_session_id,
                &conservative.cursor,
                super::super::ReplayLimits::default(),
            )
            .expect("rotation reset");
            assert!(reset.reset_required);
            assert_ne!(reset.cursor.generation, conservative.cursor.generation);
        });
        let _ = fs::remove_file(transcript_path);
        let _ = fs::remove_file(log_path);
    }

    #[test]
    #[ignore = "30 MiB deterministic sidecar streaming stress"]
    fn large_log_streams_without_materializing_irrelevant_rows() {
        let path = unique_path("large.log");
        let mut file = fs::File::create(&path).expect("large fixture");
        let irrelevant = "2026-07-16 19:42:00.000 [info] heartbeat heartbeat heartbeat\n";
        let block = irrelevant.repeat(1024);
        let mut written = 0_usize;
        while written < 30 * 1024 * 1024 {
            file.write_all(block.as_bytes()).expect("write large log");
            written = written.saturating_add(block.len());
        }
        file.write_all(fixture_log().as_bytes())
            .expect("write events");
        drop(file);
        let mut conn = rusqlite::Connection::open_in_memory().expect("DB");
        prepare_replay_db(
            &mut conn,
            "project-a/task-aaa",
            "qoderapp-project-a/task-aaa",
        );
        let tx = conn.transaction().expect("tx");
        ensure_raw_table(&tx).expect("table");
        let mut stats = ReplayStats::default();
        let probed = probed_file(&path);
        ingest_file(&tx, "project-a/task-aaa", "g", &probed, 0, &mut stats).expect("stream large");
        let rows: i64 = tx
            .query_row(&format!("SELECT COUNT(*) FROM {RAW_TABLE}"), [], |row| {
                row.get(0)
            })
            .expect("raw count");
        assert_eq!(stats.parsed_bytes, probed.size_bytes);
        assert_eq!(rows, 8);
        tx.rollback().expect("rollback");
        let _ = fs::remove_file(path);
    }
}
