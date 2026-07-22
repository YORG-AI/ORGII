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
