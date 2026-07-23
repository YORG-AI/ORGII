//! Compact catalog refresh for external-history directory surfaces.
//!
//! Session listing itself reads only `imported_history_session_cache`. Source
//! discovery and metadata refresh are explicit operations routed through this
//! exhaustive registry, so adding a replay source cannot silently put a
//! transcript-hydrating loader back on the sidebar path.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::replay::ImportedHistorySourceId;
use super::{self as imported_history, cache as imported_cache};
use crate::projectors::turn_metadata::{metadata_projection_requirements, TurnMetadataAccumulator};

/// Small adapter-owned metadata fold persisted inside a replay driver's
/// cursor. It grows by fields, never by transcript length.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ReplayCatalogProjection {
    pub title: Option<String>,
    pub title_priority: u8,
    pub model: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub tokens_observed: bool,
    pub parent_session_id: Option<String>,
    pub parent_observed: bool,
    pub continuation_group_key: Option<String>,
    pub continuation_observed: bool,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    // Codex reports cumulative counters which can reset after compaction.
    pub last_cumulative_input: i64,
    pub last_cumulative_output: i64,
    pub last_cumulative_cache_read: i64,
    pub last_cumulative_cache_write: i64,
    pub last_usage_message_id: Option<String>,
}

/// Snapshot of the mixed-ownership imported catalog row around one replay
/// projection. Discovery-owned signature fields are included as guards: if an
/// adapter refresh changes the row after replay publication, cache eviction
/// must preserve that newer row instead of restoring an obsolete baseline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReplayCatalogRowSnapshot {
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    parser_version: i64,
    listable: i64,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    repo_path: String,
    branch: String,
    files_changed: i64,
    lines_added: i64,
    lines_removed: i64,
    touched_files_json: String,
    source_metadata_json: String,
    parent_session_id: String,
    updated_at: String,
}

impl ReplayCatalogProjection {
    pub(crate) fn observe_jsonl(
        &mut self,
        source: ImportedHistorySourceId,
        raw: &Value,
        source_session_id: &str,
    ) {
        self.observe_timestamp(
            raw.get("timestamp")
                .or_else(|| raw.get("createdAt"))
                .or_else(|| raw.get("message_summary_time")),
        );
        Self::set_nonempty_path(
            &mut self.repo_path,
            raw,
            &["cwd", "project", "workspaceRoot"],
        );
        Self::set_nonempty_path(&mut self.branch, raw, &["gitBranch", "git_branch"]);

        if source == ImportedHistorySourceId::Trae {
            if let Some(intent) = nonempty_value(raw.get("intent")) {
                self.set_title(intent, 1);
            }
        }
        for (key, priority) in [
            ("summary", 2),
            ("aiTitle", 3),
            ("ai_title", 3),
            ("customTitle", 4),
            ("custom_title", 4),
        ] {
            if let Some(title) = nonempty_value(raw.get(key)) {
                self.set_title(title, priority);
            }
        }

        let message = raw
            .get("message")
            .filter(|value| value.is_object())
            .or_else(|| {
                (raw.get("type").and_then(Value::as_str) == Some("message")).then_some(raw)
            });
        if let Some(message) = message {
            if let Some(model) = nonempty_value(
                message
                    .get("model")
                    .or_else(|| message.get("modelId"))
                    .or_else(|| raw.get("modelId")),
            ) {
                self.model = Some(model.to_string());
            }
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .or_else(|| raw.get("role").and_then(Value::as_str))
                .or_else(|| raw.get("type").and_then(Value::as_str));
            if role == Some("user") && self.title_priority < 1 {
                if let Some(text) = first_content_text(message.get("content")) {
                    self.set_title(&text, 1);
                }
            }
            self.observe_message_usage(message);
        }

        if source == ImportedHistorySourceId::ClaudeCode {
            if !self.continuation_observed
                && raw.get("type").and_then(Value::as_str) == Some("user")
            {
                self.continuation_observed = true;
                self.continuation_group_key = nonempty_value(raw.get("uuid")).map(str::to_string);
            }
            if raw.get("isSidechain").is_some() {
                self.parent_observed = true;
                self.parent_session_id = raw
                    .get("isSidechain")
                    .and_then(Value::as_bool)
                    .filter(|value| *value)
                    .and_then(|_| nonempty_value(raw.get("sessionId")))
                    .filter(|parent| *parent != source_session_id)
                    .map(|parent| format!("{}{parent}", source.descriptor().session_prefix));
            }
        }
    }

    pub(crate) fn observe_codex(
        &mut self,
        line_type: &str,
        timestamp: Option<&str>,
        payload: &Value,
        source_session_id: &str,
    ) {
        self.observe_timestamp(timestamp.map(Value::from).as_ref());
        if let Some(title) = ["title", "name", "threadName", "thread_name"]
            .into_iter()
            .find_map(|key| nonempty_value(payload.get(key)))
        {
            self.set_title(title, 3);
        }
        if let Some(model) = nonempty_value(payload.get("model")) {
            self.model = Some(model.to_string());
        }
        if let Some(cwd) = nonempty_value(payload.get("cwd")) {
            self.repo_path = Some(cwd.to_string());
        }
        if payload.get("type").and_then(Value::as_str) == Some("user_message") {
            if let Some(message) = nonempty_value(payload.get("message")) {
                let message = imported_history::strip_orgii_exec_mode_bridge(message);
                if !message.trim().is_empty() {
                    self.set_title(message, 1);
                }
            }
        }
        if line_type == "session_meta" {
            let is_subagent = payload.get("thread_source").and_then(Value::as_str)
                == Some("subagent")
                || payload.pointer("/source/subagent").is_some();
            if is_subagent {
                self.parent_observed = true;
                self.parent_session_id = [
                    payload.get("parent_thread_id"),
                    payload.pointer("/source/subagent/thread_spawn/parent_thread_id"),
                    payload.get("forked_from_id"),
                ]
                .into_iter()
                .flatten()
                .find_map(Value::as_str)
                .map(str::trim)
                .filter(|parent| !parent.is_empty() && *parent != source_session_id)
                .map(|parent| {
                    format!(
                        "{}{parent}",
                        ImportedHistorySourceId::CodexApp
                            .descriptor()
                            .session_prefix
                    )
                });
            }
        }
        if payload.get("type").and_then(Value::as_str) == Some("token_count") {
            if let Some(total) = payload
                .pointer("/info/total_token_usage")
                .or_else(|| payload.get("total_token_usage"))
            {
                let field = |name| total.get(name).and_then(Value::as_i64).unwrap_or(0);
                let current_input = field("input_tokens");
                let current_cache_read = field("cached_input_tokens");
                let current_cache_write = field("cache_write_input_tokens");
                let current_output = field("output_tokens") + field("reasoning_output_tokens");
                self.input_tokens += cumulative_delta(current_input, self.last_cumulative_input);
                self.cache_read_tokens +=
                    cumulative_delta(current_cache_read, self.last_cumulative_cache_read);
                self.cache_write_tokens +=
                    cumulative_delta(current_cache_write, self.last_cumulative_cache_write);
                self.output_tokens += cumulative_delta(current_output, self.last_cumulative_output);
                self.last_cumulative_input = current_input;
                self.last_cumulative_cache_read = current_cache_read;
                self.last_cumulative_cache_write = current_cache_write;
                self.last_cumulative_output = current_output;
                self.tokens_observed = true;
            }
        }
    }

    fn observe_timestamp(&mut self, value: Option<&Value>) {
        let Some(ms) = value.and_then(value_epoch_ms) else {
            return;
        };
        self.created_at_ms = Some(self.created_at_ms.map_or(ms, |old| old.min(ms)));
        self.updated_at_ms = Some(self.updated_at_ms.map_or(ms, |old| old.max(ms)));
    }

    fn observe_message_usage(&mut self, message: &Value) {
        let Some(usage) = message.get("usage") else {
            return;
        };
        let message_id = nonempty_value(message.get("id")).map(str::to_string);
        if message_id.is_some() && message_id == self.last_usage_message_id {
            return;
        }
        self.last_usage_message_id = message_id;
        let field = |name| usage.get(name).and_then(Value::as_i64).unwrap_or(0);
        let cache_read = field("cache_read_input_tokens");
        let cache_write = field("cache_creation_input_tokens");
        self.input_tokens +=
            field("input_tokens") + field("prompt_tokens") + cache_read + cache_write;
        self.output_tokens += field("output_tokens") + field("completion_tokens");
        self.cache_read_tokens += cache_read;
        self.cache_write_tokens += cache_write;
        self.tokens_observed = true;
    }

    fn set_title(&mut self, value: &str, priority: u8) {
        let value = imported_history::truncate_name(value.trim(), 200);
        if !value.is_empty() && priority >= self.title_priority {
            self.title = Some(value);
            self.title_priority = priority;
        }
    }

    fn set_nonempty_path(slot: &mut Option<String>, raw: &Value, keys: &[&str]) {
        if slot.is_none() {
            *slot = keys
                .iter()
                .find_map(|key| nonempty_value(raw.get(*key)))
                .map(str::to_string);
        }
    }
}

/// Refresh one source's compact session catalog.
///
/// Implementations may inspect source-owned indexes or stream lightweight
/// metadata, but must not return or retain a session-sized `ActivityChunk`
/// vector. Transcript bodies remain owned by the bounded replay adapters.
pub fn refresh_source(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
) -> Result<(), String> {
    match source {
        ImportedHistorySourceId::ClaudeCode => {
            crate::sources::claude_code::history::refresh_catalog(conn)
        }
        ImportedHistorySourceId::CodexApp => crate::sources::codex::app::refresh_catalog(conn),
        ImportedHistorySourceId::CursorIde => crate::sources::cursor_ide::db::refresh_catalog(conn),
        ImportedHistorySourceId::CursorCli => {
            crate::sources::cursor_cli::history::refresh_catalog(conn)
        }
        ImportedHistorySourceId::OpenCode => {
            crate::sources::opencode::history::refresh_catalog(conn)
        }
        ImportedHistorySourceId::Windsurf => {
            crate::sources::windsurf::history::refresh_catalog(conn)
        }
        ImportedHistorySourceId::WorkBuddy => crate::sources::workbuddy::refresh_catalog(conn),
        ImportedHistorySourceId::Trae => crate::sources::trae::history::refresh_catalog(conn),
        ImportedHistorySourceId::Cline => crate::sources::cline::history::refresh_catalog(conn),
        ImportedHistorySourceId::Warp => crate::sources::warp::history::refresh_catalog(conn),
        ImportedHistorySourceId::ZCode => crate::sources::zcode::history::refresh_catalog(conn),
        ImportedHistorySourceId::Qoder => crate::sources::qoder::history::refresh_catalog(conn),
        ImportedHistorySourceId::MimoCode => {
            crate::sources::mimo_code::history::refresh_catalog(conn)
        }
        ImportedHistorySourceId::Omp => crate::sources::omp::history::refresh_catalog(conn),
        ImportedHistorySourceId::QoderCli => {
            crate::sources::qoder_cli::history::refresh_catalog(conn)
        }
    }
}

fn read_replay_catalog_row(
    tx: &Transaction<'_>,
    source: &str,
    source_session_id: &str,
) -> Result<Option<ReplayCatalogRowSnapshot>, String> {
    tx.query_row(
        "SELECT session_id,source_path,source_record_key,source_mtime_ms,
                source_size_bytes,source_fingerprint,parser_version,listable,
                name,created_at_ms,updated_at_ms,model,input_tokens,output_tokens,
                cache_read_tokens,cache_write_tokens,repo_path,branch,files_changed,
                lines_added,lines_removed,touched_files_json,source_metadata_json,
                parent_session_id,updated_at
         FROM imported_history_session_cache
         WHERE source=?1 AND source_session_id=?2",
        params![source, source_session_id],
        |row| {
            Ok(ReplayCatalogRowSnapshot {
                session_id: row.get(0)?,
                source_path: row.get(1)?,
                source_record_key: row.get(2)?,
                source_mtime_ms: row.get(3)?,
                source_size_bytes: row.get(4)?,
                source_fingerprint: row.get(5)?,
                parser_version: row.get(6)?,
                listable: row.get(7)?,
                name: row.get(8)?,
                created_at_ms: row.get(9)?,
                updated_at_ms: row.get(10)?,
                model: row.get(11)?,
                input_tokens: row.get(12)?,
                output_tokens: row.get(13)?,
                cache_read_tokens: row.get(14)?,
                cache_write_tokens: row.get(15)?,
                repo_path: row.get(16)?,
                branch: row.get(17)?,
                files_changed: row.get(18)?,
                lines_added: row.get(19)?,
                lines_removed: row.get(20)?,
                touched_files_json: row.get(21)?,
                source_metadata_json: row.get(22)?,
                parent_session_id: row.get(23)?,
                updated_at: row.get(24)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("read imported replay catalog row: {err}"))
}

fn replay_catalog_baseline(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    current: &ReplayCatalogRowSnapshot,
) -> Result<ReplayCatalogRowSnapshot, String> {
    let stored = tx
        .query_row(
            "SELECT baseline_json,applied_json
             FROM imported_replay_catalog_derivations
             WHERE source=?1 AND source_session_id=?2",
            params![source.as_str(), source_session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("read replay catalog derivation: {err}"))?;
    let Some((baseline_json, applied_json)) = stored else {
        return Ok(current.clone());
    };
    let baseline = serde_json::from_str::<ReplayCatalogRowSnapshot>(&baseline_json)
        .map_err(|err| format!("decode replay catalog baseline: {err}"))?;
    let applied = serde_json::from_str::<ReplayCatalogRowSnapshot>(&applied_json)
        .map_err(|err| format!("decode applied replay catalog snapshot: {err}"))?;
    // Equality includes adapter-owned signature fields. Any intervening source
    // refresh rebases the baseline before the next replay overlay.
    Ok(if &applied == current {
        baseline
    } else {
        current.clone()
    })
}

fn store_replay_catalog_derivation(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    baseline: &ReplayCatalogRowSnapshot,
    applied: &ReplayCatalogRowSnapshot,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO imported_replay_catalog_derivations(
             source,source_session_id,baseline_json,applied_json,updated_at
         ) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(source,source_session_id) DO UPDATE SET
             baseline_json=excluded.baseline_json,
             applied_json=excluded.applied_json,
             updated_at=excluded.updated_at",
        params![
            source.as_str(),
            source_session_id,
            serde_json::to_string(baseline)
                .map_err(|err| format!("encode replay catalog baseline: {err}"))?,
            serde_json::to_string(applied)
                .map_err(|err| format!("encode applied replay catalog snapshot: {err}"))?,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map(|_| ())
    .map_err(|err| format!("store replay catalog derivation: {err}"))
}

/// Remove one replay-owned catalog overlay without rolling back a newer
/// adapter refresh. This runs in the same transaction as compact-index prune.
pub(crate) fn clear_replay_projection_tx(
    tx: &Transaction<'_>,
    source: &str,
    source_session_id: &str,
) -> Result<(), String> {
    let stored = tx
        .query_row(
            "SELECT baseline_json,applied_json
             FROM imported_replay_catalog_derivations
             WHERE source=?1 AND source_session_id=?2",
            params![source, source_session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("read replay catalog projection for prune: {err}"))?;
    let Some((baseline_json, applied_json)) = stored else {
        return Ok(());
    };
    let baseline = serde_json::from_str::<ReplayCatalogRowSnapshot>(&baseline_json)
        .map_err(|err| format!("decode replay catalog prune baseline: {err}"))?;
    let applied = serde_json::from_str::<ReplayCatalogRowSnapshot>(&applied_json)
        .map_err(|err| format!("decode replay catalog prune snapshot: {err}"))?;
    let current = read_replay_catalog_row(tx, source, source_session_id)?;
    if current.as_ref() == Some(&applied) {
        tx.execute(
            "UPDATE imported_history_session_cache SET
                 name=?3,created_at_ms=?4,updated_at_ms=?5,model=?6,
                 input_tokens=?7,output_tokens=?8,cache_read_tokens=?9,
                 cache_write_tokens=?10,repo_path=?11,branch=?12,
                 files_changed=?13,lines_added=?14,lines_removed=?15,
                 touched_files_json=?16,source_metadata_json=?17,
                 parent_session_id=?18,updated_at=?19
             WHERE source=?1 AND source_session_id=?2",
            params![
                source,
                source_session_id,
                baseline.name,
                baseline.created_at_ms,
                baseline.updated_at_ms,
                baseline.model,
                baseline.input_tokens,
                baseline.output_tokens,
                baseline.cache_read_tokens,
                baseline.cache_write_tokens,
                baseline.repo_path,
                baseline.branch,
                baseline.files_changed,
                baseline.lines_added,
                baseline.lines_removed,
                baseline.touched_files_json,
                baseline.source_metadata_json,
                baseline.parent_session_id,
                baseline.updated_at,
            ],
        )
        .map_err(|err| format!("restore adapter catalog baseline: {err}"))?;
    }
    tx.execute(
        "DELETE FROM imported_replay_catalog_derivations
         WHERE source=?1 AND source_session_id=?2",
        params![source, source_session_id],
    )
    .map(|_| ())
    .map_err(|err| format!("delete replay catalog derivation: {err}"))
}

/// Publish replay-derived card metadata inside the same transaction that
/// publishes the replay generation. A crash therefore exposes either the old
/// replay+catalog pair or the new pair, never a mixed state.
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_from_replay_tx(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    total_events: u64,
    fold_event_metadata: bool,
    source_mtime_ns: i64,
    driver_cursor_json: &str,
) -> Result<(), String> {
    let catalog_before = read_replay_catalog_row(tx, source.as_str(), source_session_id)?;
    let catalog_baseline = catalog_before
        .as_ref()
        .map(|current| replay_catalog_baseline(tx, source, source_session_id, current))
        .transpose()?;
    let projection = serde_json::from_str::<Value>(driver_cursor_json)
        .ok()
        .and_then(|cursor| cursor.get("catalog").cloned())
        .and_then(|value| serde_json::from_value::<ReplayCatalogProjection>(value).ok())
        .unwrap_or_default();
    let complete_projection = if fold_event_metadata {
        let indexed_events = tx
            .query_row(
                "SELECT COUNT(*) FROM imported_replay_events
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3",
                params![source.as_str(), source_session_id, generation],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| format!("count replay catalog events: {err}"))?
            .max(0) as u64;
        indexed_events == total_events
    } else {
        false
    };
    let mut impact = imported_history::metadata::ImportedHistoryImpactStats::default();
    let mut first_user_title = None;

    if complete_projection {
        let mut statement = tx
            .prepare(
                "SELECT function_name,created_at,args_preview_json,result_preview_json
                 FROM imported_replay_events
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3
                 ORDER BY sequence ASC",
            )
            .map_err(|err| format!("prepare compact replay catalog projection: {err}"))?;
        let mut rows = statement
            .query(params![source.as_str(), source_session_id, generation])
            .map_err(|err| format!("query compact replay catalog projection: {err}"))?;
        let mut metadata = TurnMetadataAccumulator::new();
        while let Some(row) = rows
            .next()
            .map_err(|err| format!("stream compact replay catalog row: {err}"))?
        {
            let function_name: String = row.get(0).map_err(|err| err.to_string())?;
            let created_at: String = row.get(1).map_err(|err| err.to_string())?;
            if function_name == imported_history::FUNCTION_USER_MESSAGE {
                if first_user_title.is_none() {
                    let args: String = row.get(2).map_err(|err| err.to_string())?;
                    let result: String = row.get(3).map_err(|err| err.to_string())?;
                    first_user_title = compact_user_title(&args, &result);
                }
                continue;
            }
            let requirements = metadata_projection_requirements(Some(&function_name));
            if requirements.is_empty() {
                continue;
            }
            let args = if requirements.needs_args_json() {
                row.get::<_, String>(2).map_err(|err| err.to_string())?
            } else {
                String::new()
            };
            let result = if requirements.needs_result_json() {
                row.get::<_, String>(3).map_err(|err| err.to_string())?
            } else {
                String::new()
            };
            metadata.add_event_at(Some(&function_name), &args, &result, &created_at);
        }
        let modified_files = metadata.modified_files();
        impact.touched_files = modified_files
            .iter()
            .map(|file| file.path.clone())
            .collect();
        impact.files_changed = impact.touched_files.len() as i64;
        impact.lines_added = modified_files
            .iter()
            .map(|file| i64::from(file.additions))
            .sum();
        impact.lines_removed = modified_files
            .iter()
            .map(|file| i64::from(file.deletions))
            .sum();
    }

    let title = projection.title.as_deref().or(first_user_title.as_deref());
    let title_priority = if projection.title.is_some() {
        projection.title_priority
    } else if first_user_title.is_some() {
        1
    } else {
        0
    };
    let source_mtime_ms = source_mtime_ns.saturating_div(1_000_000);
    let projected_updated_at = projection.updated_at_ms.unwrap_or_default();
    let updated_at_ms = source_mtime_ms.max(projected_updated_at);
    let metadata_json = merged_continuation_metadata(tx, source, source_session_id, &projection)?;

    tx.execute(
        "UPDATE imported_history_session_cache SET
            name = CASE
                WHEN COALESCE(?3, '') = '' THEN name
                WHEN ?4 >= 2 THEN ?3
                WHEN name = '' OR name = source_record_key OR name = source_session_id
                     OR name = 'New Agent' THEN ?3
                ELSE name END,
            model = CASE WHEN COALESCE(?5, '') != '' THEN ?5 ELSE model END,
            repo_path = CASE WHEN COALESCE(?6, '') != '' THEN ?6 ELSE repo_path END,
            branch = CASE WHEN COALESCE(?7, '') != '' THEN ?7 ELSE branch END,
            input_tokens = CASE WHEN ?8 != 0 THEN ?9 ELSE input_tokens END,
            output_tokens = CASE WHEN ?8 != 0 THEN ?10 ELSE output_tokens END,
            cache_read_tokens = CASE WHEN ?8 != 0 THEN ?11 ELSE cache_read_tokens END,
            cache_write_tokens = CASE WHEN ?8 != 0 THEN ?12 ELSE cache_write_tokens END,
            files_changed = CASE WHEN ?13 != 0 THEN ?14 ELSE files_changed END,
            lines_added = CASE WHEN ?13 != 0 THEN ?15 ELSE lines_added END,
            lines_removed = CASE WHEN ?13 != 0 THEN ?16 ELSE lines_removed END,
            touched_files_json = CASE WHEN ?13 != 0 THEN ?17 ELSE touched_files_json END,
            parent_session_id = CASE WHEN ?18 != 0 THEN COALESCE(?19, '') ELSE parent_session_id END,
            source_metadata_json = CASE WHEN ?20 != 0 THEN ?21 ELSE source_metadata_json END,
            created_at_ms = CASE WHEN created_at_ms <= 0 AND ?22 > 0 THEN ?22 ELSE created_at_ms END,
            updated_at_ms = MAX(updated_at_ms, ?23),
            updated_at = ?24
         WHERE source=?1 AND source_session_id=?2",
        params![
            source.as_str(),
            source_session_id,
            title,
            title_priority as i64,
            projection.model,
            projection.repo_path,
            projection.branch,
            i64::from(projection.tokens_observed),
            projection.input_tokens,
            projection.output_tokens,
            projection.cache_read_tokens,
            projection.cache_write_tokens,
            i64::from(complete_projection),
            impact.files_changed,
            impact.lines_added,
            impact.lines_removed,
            serde_json::to_string(&impact.touched_files)
                .map_err(|err| format!("encode replay catalog touched files: {err}"))?,
            i64::from(projection.parent_observed),
            projection.parent_session_id,
            i64::from(projection.continuation_observed),
            metadata_json,
            projection.created_at_ms.unwrap_or_default(),
            updated_at_ms,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|err| format!("publish compact replay catalog metadata: {err}"))?;
    if let Some(baseline) = catalog_baseline.as_ref() {
        let applied =
            read_replay_catalog_row(tx, source.as_str(), source_session_id)?.ok_or_else(|| {
                "Imported replay catalog row disappeared while publishing projection".to_string()
            })?;
        store_replay_catalog_derivation(tx, source, source_session_id, baseline, &applied)?;
    }
    Ok(())
}

fn merged_continuation_metadata(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    projection: &ReplayCatalogProjection,
) -> Result<String, String> {
    if !projection.continuation_observed {
        return Ok(String::new());
    }
    let existing = tx
        .query_row(
            "SELECT source_metadata_json FROM imported_history_session_cache
             WHERE source=?1 AND source_session_id=?2",
            params![source.as_str(), source_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read replay catalog metadata JSON: {err}"))?
        .unwrap_or_default();
    let mut object = serde_json::from_str::<Value>(&existing)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(key) = projection.continuation_group_key.as_deref() {
        object.insert(
            imported_cache::CONTINUATION_GROUP_KEY_FIELD.to_string(),
            Value::String(key.to_string()),
        );
    } else {
        object.remove(imported_cache::CONTINUATION_GROUP_KEY_FIELD);
    }
    Ok(Value::Object(object).to_string())
}

fn compact_user_title(args_json: &str, result_json: &str) -> Option<String> {
    let args = serde_json::from_str::<Value>(args_json).unwrap_or(Value::Null);
    let result = serde_json::from_str::<Value>(result_json).unwrap_or(Value::Null);
    let title = [
        args.get("content"),
        args.get("message"),
        args.get("prompt"),
        args.get("text"),
        result.pointer("/message/content"),
        result.get("content"),
        result.get("message"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(imported_history::strip_orgii_exec_mode_bridge)
    .map(str::trim)
    .filter(|title| !title.is_empty())
    .map(|title| imported_history::truncate_name(title, 200));
    title
}

fn nonempty_value(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn first_content_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => items.iter().find_map(|item| {
            let kind = item.get("type").and_then(Value::as_str);
            if kind.is_some_and(|kind| !matches!(kind, "text" | "input_text")) {
                return None;
            }
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        _ => None,
    }
}

fn value_epoch_ms(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| {
            value
                .as_str()
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        })
}

fn cumulative_delta(current: i64, previous: i64) -> i64 {
    if current >= previous {
        current - previous
    } else {
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteRecordStore;

    fn catalog_fixture() -> Connection {
        let conn = Connection::open_in_memory().expect("catalog DB");
        SqliteRecordStore::init_tables(&conn).expect("core schema");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("catalog schema");
        conn.execute(
            "INSERT INTO imported_history_session_cache(
                source,source_session_id,session_id,source_record_key,name,
                model,repo_path,branch,input_tokens,files_changed,lines_added,
                lines_removed,touched_files_json,source_metadata_json,
                source_mtime_ms,source_size_bytes
             ) VALUES('codex_app','fixture','codexapp-fixture','fixture','fixture',
                'old-model','/old','old',7,9,9,9,'[\"old.rs\"]','{\"keep\":true}',
                999,999)",
            [],
        )
        .expect("cache row");
        for (sequence, function, args, result) in [
            (
                0_i64,
                imported_history::FUNCTION_USER_MESSAGE,
                "{}",
                r#"{"message":{"content":"bounded replay title"}}"#,
            ),
            (
                1_i64,
                imported_history::FUNCTION_EDIT_FILE,
                r#"{"file_path":"src/new.rs","old_content":"old","new_content":"new\nextra"}"#,
                r#"{"status":"completed","linesAdded":2,"linesRemoved":1}"#,
            ),
        ] {
            conn.execute(
                "INSERT INTO imported_replay_events(
                    source,source_session_id,generation,sequence,event_id,turn_index,
                    action_type,function_name,created_at,args_preview_json,
                    result_preview_json,content_hash
                 ) VALUES('codex_app','fixture','g1',?1,?2,0,'raw',?3,
                    '2026-07-22T00:00:00Z',?4,?5,?2)",
                params![
                    sequence,
                    format!("event-{sequence}"),
                    function,
                    args,
                    result
                ],
            )
            .expect("replay event");
        }
        conn
    }

    fn current_catalog_snapshot(conn: &mut Connection) -> ReplayCatalogRowSnapshot {
        let tx = conn
            .transaction()
            .expect("read catalog snapshot transaction");
        let snapshot = read_replay_catalog_row(&tx, "codex_app", "fixture")
            .expect("read catalog snapshot")
            .expect("fixture catalog row");
        tx.commit().expect("finish catalog snapshot transaction");
        snapshot
    }

    fn derivation_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_catalog_derivations
             WHERE source='codex_app' AND source_session_id='fixture'",
            [],
            |row| row.get(0),
        )
        .expect("count catalog derivations")
    }

    fn publish_fixture_projection(conn: &mut Connection) {
        let cursor = serde_json::json!({
            "catalog": ReplayCatalogProjection {
                model: Some("gpt-5".to_string()),
                repo_path: Some("/work/orgii".to_string()),
                branch: Some("develop".to_string()),
                input_tokens: 100,
                output_tokens: 20,
                tokens_observed: true,
                continuation_group_key: Some("first-user".to_string()),
                continuation_observed: true,
                updated_at_ms: Some(1_774_137_600_000),
                ..ReplayCatalogProjection::default()
            }
        })
        .to_string();
        let tx = conn.transaction().expect("catalog transaction");
        publish_from_replay_tx(
            &tx,
            ImportedHistorySourceId::CodexApp,
            "fixture",
            "g1",
            2,
            true,
            1_774_137_600_000_000_000,
            &cursor,
        )
        .expect("publish catalog projection");
        tx.commit().expect("commit catalog projection");
    }

    #[test]
    fn catalog_registry_is_exhaustive_for_replay_sources() {
        // The exhaustive match in `refresh_source` is the compile-time guard;
        // this assertion also documents the external-history contract count.
        assert_eq!(ImportedHistorySourceId::ALL.len(), 15);
    }

    #[test]
    fn replay_catalog_publish_updates_only_projected_fields() {
        let mut conn = catalog_fixture();
        let projection = ReplayCatalogProjection {
            model: Some("gpt-5".to_string()),
            repo_path: Some("/work/orgii".to_string()),
            branch: Some("develop".to_string()),
            input_tokens: 100,
            output_tokens: 20,
            tokens_observed: true,
            continuation_group_key: Some("first-user".to_string()),
            continuation_observed: true,
            updated_at_ms: Some(1_774_137_600_000),
            ..ReplayCatalogProjection::default()
        };
        let cursor = serde_json::json!({"catalog": projection}).to_string();
        let tx = conn.transaction().expect("catalog transaction");
        publish_from_replay_tx(
            &tx,
            ImportedHistorySourceId::CodexApp,
            "fixture",
            "g1",
            2,
            true,
            1_774_137_600_000_000_000,
            &cursor,
        )
        .expect("publish catalog");
        tx.commit().expect("commit catalog");

        let row = conn
            .query_row(
                "SELECT name,model,repo_path,branch,input_tokens,output_tokens,
                        files_changed,lines_added,lines_removed,touched_files_json,
                        source_metadata_json
                 FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .expect("published row");
        assert_eq!(row.0, "bounded replay title");
        assert_eq!(row.1, "gpt-5");
        assert_eq!(row.2, "/work/orgii");
        assert_eq!(row.3, "develop");
        assert_eq!((row.4, row.5), (100, 20));
        assert_eq!((row.6, row.7, row.8), (1, 2, 1));
        assert_eq!(row.9, r#"["src/new.rs"]"#);
        let metadata: Value = serde_json::from_str(&row.10).expect("metadata JSON");
        assert_eq!(metadata.get("keep"), Some(&Value::Bool(true)));
        assert_eq!(
            metadata
                .get(imported_cache::CONTINUATION_GROUP_KEY_FIELD)
                .and_then(Value::as_str),
            Some("first-user")
        );
    }

    #[test]
    fn replay_catalog_publish_rolls_back_with_replay_transaction() {
        let mut conn = catalog_fixture();
        let cursor = serde_json::json!({
            "catalog": ReplayCatalogProjection {
                model: Some("must-rollback".to_string()),
                ..ReplayCatalogProjection::default()
            }
        })
        .to_string();
        {
            let tx = conn.transaction().expect("catalog transaction");
            publish_from_replay_tx(
                &tx,
                ImportedHistorySourceId::CodexApp,
                "fixture",
                "g1",
                2,
                true,
                1,
                &cursor,
            )
            .expect("publish then rollback");
            // Dropping an uncommitted transaction rolls back both replay and
            // catalog publication.
        }
        let model: String = conn
            .query_row(
                "SELECT model FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
                [],
                |row| row.get(0),
            )
            .expect("rolled-back model");
        assert_eq!(model, "old-model");
        assert_eq!(
            derivation_count(&conn),
            0,
            "the baseline/applied guard must roll back with its projection"
        );
    }

    #[test]
    fn replay_catalog_prune_restores_unchanged_adapter_baseline() {
        let mut conn = catalog_fixture();
        let baseline = current_catalog_snapshot(&mut conn);
        publish_fixture_projection(&mut conn);
        let applied = current_catalog_snapshot(&mut conn);
        assert_ne!(applied, baseline, "fixture must exercise a real overlay");
        assert_eq!(derivation_count(&conn), 1);

        let tx = conn.transaction().expect("catalog prune transaction");
        clear_replay_projection_tx(&tx, "codex_app", "fixture")
            .expect("clear unchanged replay projection");
        tx.commit().expect("commit catalog prune");

        assert_eq!(current_catalog_snapshot(&mut conn), baseline);
        assert_eq!(derivation_count(&conn), 0);
    }

    #[test]
    fn replay_catalog_prune_preserves_newer_adapter_refresh() {
        let mut conn = catalog_fixture();
        publish_fixture_projection(&mut conn);
        conn.execute(
            "UPDATE imported_history_session_cache SET
                 source_fingerprint='adapter-new-fingerprint',
                 source_mtime_ms=123456,
                 name='adapter-title',
                 model='adapter-model',
                 repo_path='/adapter/repo',
                 source_metadata_json='{\"adapter\":true}',
                 updated_at='2026-07-23T12:00:00Z'
             WHERE source='codex_app' AND source_session_id='fixture'",
            [],
        )
        .expect("simulate adapter refresh");
        let refreshed = current_catalog_snapshot(&mut conn);

        let tx = conn.transaction().expect("catalog prune transaction");
        clear_replay_projection_tx(&tx, "codex_app", "fixture")
            .expect("clear replay projection after adapter refresh");
        tx.commit().expect("commit catalog prune");

        assert_eq!(
            current_catalog_snapshot(&mut conn),
            refreshed,
            "eviction must not roll a newer adapter row back to the old baseline"
        );
        assert_eq!(derivation_count(&conn), 0);
    }

    #[test]
    fn replay_catalog_prune_rolls_back_atomically() {
        let mut conn = catalog_fixture();
        publish_fixture_projection(&mut conn);
        let applied = current_catalog_snapshot(&mut conn);
        assert_eq!(derivation_count(&conn), 1);

        {
            let tx = conn.transaction().expect("catalog prune transaction");
            clear_replay_projection_tx(&tx, "codex_app", "fixture")
                .expect("clear replay projection before rollback");
            // Simulate an interrupted prune by dropping the transaction.
        }

        assert_eq!(current_catalog_snapshot(&mut conn), applied);
        assert_eq!(
            derivation_count(&conn),
            1,
            "projection and guard must remain visible together after rollback"
        );
    }

    #[test]
    fn replay_catalog_publish_never_clears_unavailable_fields() {
        let mut conn = catalog_fixture();
        let cursor = serde_json::json!({
            "catalog": ReplayCatalogProjection::default()
        })
        .to_string();
        let tx = conn.transaction().expect("catalog transaction");
        publish_from_replay_tx(
            &tx,
            ImportedHistorySourceId::CodexApp,
            "fixture",
            "g1",
            99,
            true,
            123_000_000,
            &cursor,
        )
        .expect("publish partial catalog");
        tx.commit().expect("commit partial catalog");

        let row = conn
            .query_row(
                "SELECT name,model,repo_path,branch,input_tokens,files_changed,
                        lines_added,lines_removed,touched_files_json,
                        source_metadata_json,source_mtime_ms,source_size_bytes
                 FROM imported_history_session_cache
                 WHERE source='codex_app' AND source_session_id='fixture'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                    ))
                },
            )
            .expect("preserved catalog row");
        assert_eq!(row.0, "fixture");
        assert_eq!(row.1, "old-model");
        assert_eq!(row.2, "/old");
        assert_eq!(row.3, "old");
        assert_eq!(row.4, 7);
        assert_eq!((row.5, row.6, row.7), (9, 9, 9));
        assert_eq!(row.8, r#"["old.rs"]"#);
        assert_eq!(row.9, r#"{"keep":true}"#);
        assert_eq!(
            (row.10, row.11),
            (999, 999),
            "replay snapshots must not overwrite adapter-owned discovery signatures"
        );
    }
}
