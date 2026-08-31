//! Materialized turn index derived from normalized session events.

use chrono::{DateTime, Utc};
use core_types::extracted::ExtractedGitArtifactData;
use orgtrack_core::projectors::turn_metadata::{
    TurnMetadataAccumulator, TurnModifiedFile, TurnResourceInteraction,
};
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde::{Deserialize, Serialize};

use super::connection::{begin_immediate, get_connection, with_sessions_writer};
use super::crud::normalize_session_sequences;

const USER_MESSAGE_FUNCTION: &str = "user_message";
const IMPORTED_USER_MESSAGE_FUNCTION: &str = "user";
const TURN_STATUS_PENDING: &str = "pending";
const TURN_STATUS_COMPLETED: &str = "completed";
const TURN_STATUS_FAILED: &str = "failed";

/// Bump the index version every time the build_turn_drafts algorithm or
/// the status derivation changes shape — `ensure_turn_index_fresh`
/// rebuilds when the stored version is older.
///
/// v6: materialize the per-round modified-file list (`modified_files_json`).
/// v7: include patch-text fallback line stats in `modified_files_json`.
/// v8: include content fallback line stats for create/write-style tools.
/// v9: materialize exact per-round commits and pull requests.
/// v10: project provider-neutral read/search/write resource interactions via
/// Orgtrack instead of interpreting ORG2 tool names in this host crate.
/// v11: treat the normalized imported-history `user` function as the same
/// turn boundary as the native `user_message` function.
const TURN_INDEX_VERSION: i64 = 11;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTurnSummary {
    pub session_id: String,
    pub turn_id: String,
    pub start_sequence: i64,
    pub end_sequence: Option<i64>,
    pub next_turn_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub user_event_ids: Vec<String>,
    pub user_preview: String,
    pub event_count: i64,
    pub body_event_count: i64,
    pub status: String,
    pub interrupted: bool,
    /// Files this round wrote to, materialized so the frontend never
    /// re-aggregates file changes from raw events.
    #[serde(default)]
    pub modified_files: Vec<TurnModifiedFile>,
    /// Privacy-safe read/search/write/create/delete/rename aggregates for this
    /// round. Raw queries, commands, tool output, and file contents are not
    /// materialized here.
    #[serde(default)]
    pub resource_interactions: Vec<TurnResourceInteraction>,
    /// Commits and pull requests produced by successful git/gh commands in
    /// this round. Materialized for lazy historical backfill and direct UI use.
    #[serde(default)]
    pub git_artifacts: Vec<ExtractedGitArtifactData>,
}

#[derive(Debug, Clone)]
struct IndexEventRow {
    id: String,
    function_name: Option<String>,
    args_json: String,
    result_json: String,
    content: String,
    created_at: String,
    order_sequence: i64,
}

#[derive(Debug, Clone)]
struct TurnDraft {
    turn_id: String,
    start_sequence: i64,
    end_sequence: Option<i64>,
    next_turn_id: Option<String>,
    started_at: String,
    ended_at: Option<String>,
    user_event_ids: Vec<String>,
    user_preview: String,
    event_count: i64,
    body_event_count: i64,
    /// Canonical user-intent id for this turn, if the source rows carried
    /// one. Used by `build_turn_drafts` to collapse a synthetic + backend
    /// pair into a single draft.
    turn_intent_id: Option<String>,
    /// Provider-neutral Orgtrack metadata accumulated from body events.
    metadata_accumulator: TurnMetadataAccumulator,
}

#[derive(Debug, Clone)]
struct UserMessageRow {
    id: String,
    content: String,
    sequence: i64,
    created_at: String,
    images: Option<String>,
}

fn index_event_row(row: &rusqlite::Row<'_>) -> SqliteResult<IndexEventRow> {
    Ok(IndexEventRow {
        id: row.get(0)?,
        function_name: row.get(1)?,
        args_json: row.get(2)?,
        result_json: row.get(3)?,
        content: row.get(4)?,
        created_at: row.get(5)?,
        order_sequence: row.get(6)?,
    })
}

fn event_state(conn: &Connection, session_id: &str) -> SqliteResult<(i64, Option<i64>)> {
    conn.query_row(
        "SELECT COUNT(*), MAX(COALESCE(history_sequence, rowid))
         FROM events
         WHERE session_id = ?1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

fn is_synthetic_user_input(row: &IndexEventRow) -> bool {
    serde_json::from_str::<serde_json::Value>(&row.result_json)
        .ok()
        .and_then(|result| {
            result
                .get("syntheticUserInput")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(false)
}

/// Extract the canonical user-intent id from a user_message row's
/// `result_json`. Returns `None` for legacy rows (no id was minted) and
/// for malformed JSON.
fn turn_intent_id_for_row(row: &IndexEventRow) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&row.result_json)
        .ok()
        .and_then(|result| {
            result
                .get("turnIntentId")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .filter(|id| !id.is_empty())
        })
}

fn is_user_message(row: &IndexEventRow) -> bool {
    matches!(
        row.function_name.as_deref(),
        Some(USER_MESSAGE_FUNCTION | IMPORTED_USER_MESSAGE_FUNCTION)
    ) && !is_synthetic_user_input(row)
}

/// Lookup of intent ids that the indexer must treat as not yielding a
/// durable round (Stale). Built from the lifecycle store at
/// rebuild time.
type StaleIntentIds = std::collections::HashSet<String>;

/// Lifecycle status overlay for non-stale intents. Keyed by intent id;
/// the value is the durable lifecycle status (`completed`, `failed`,
/// `cancelled`, `running`, `queued`, `optimistic`). The indexer uses
/// this in preference to the legacy `body_event_count > 0` heuristic so
/// a turn that the user cancelled mid-stream is marked correctly even
/// when no body events landed.
type IntentStatusOverlay = std::collections::HashMap<String, String>;

fn load_stale_intent_ids(session_id: &str) -> StaleIntentIds {
    super::turn_intents::list_for_session(session_id)
        .map(|rows| {
            rows.into_iter()
                .filter(|row| row.status.is_pre_durable_terminal())
                .map(|row| row.turn_intent_id)
                .collect()
        })
        .unwrap_or_default()
}

fn load_intent_status_overlay(session_id: &str) -> IntentStatusOverlay {
    super::turn_intents::list_for_session(session_id)
        .map(|rows| {
            rows.into_iter()
                .filter(|row| !row.status.is_pre_durable_terminal())
                .map(|row| (row.turn_intent_id, row.status.as_str().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn user_event_id_for_message(message_id: &str) -> String {
    format!("user-message-{message_id}")
}

/// Content-dedup key for backfill matching.
///
/// Event rows store searchable content truncated to 500 bytes (see
/// `build_searchable_content` in the wire crate), while `agent_messages`
/// keeps the full text. Comparing full message content against the
/// truncated event preview never matches for long messages (e.g. the
/// synthetic "[Plan approved] …" submit carrying the whole plan body),
/// so backfill inserted a duplicate user bubble after every transcript
/// rewrite. Normalize both sides to the same 500-byte boundary.
const USER_CONTENT_DEDUP_BYTES: usize = 500;

fn user_content_dedup_key(content: &str) -> String {
    let mut end = USER_CONTENT_DEDUP_BYTES.min(content.len());
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    content[..end].to_string()
}

fn load_user_messages(conn: &Connection, session_id: &str) -> SqliteResult<Vec<UserMessageRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, content, sequence, created_at, images
         FROM agent_messages
         WHERE session_id = ?1 AND role = 'user'
         ORDER BY sequence ASC, created_at ASC, id ASC",
    )?;

    let rows = stmt
        .query_map([session_id], |row| {
            Ok(UserMessageRow {
                id: row.get(0)?,
                content: row.get(1)?,
                sequence: row.get(2)?,
                created_at: row.get(3)?,
                images: row.get(4)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

fn load_existing_user_event_keys(
    conn: &Connection,
    session_id: &str,
) -> SqliteResult<(
    std::collections::HashSet<String>,
    std::collections::HashMap<String, usize>,
)> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, content, result_json
         FROM events
         WHERE session_id = ?1 AND function_name IN ('user_message', 'user')
         ORDER BY COALESCE(history_sequence, rowid) ASC, created_at ASC, id ASC",
    )?;
    let mut ids = std::collections::HashSet::new();
    let mut content_counts = std::collections::HashMap::new();
    let rows = stmt.query_map([session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, content, result_json) = row?;
        let event_row = IndexEventRow {
            id: id.clone(),
            function_name: Some(USER_MESSAGE_FUNCTION.to_string()),
            args_json: String::new(),
            result_json,
            content: content.clone(),
            created_at: String::new(),
            order_sequence: 0,
        };
        if is_synthetic_user_input(&event_row) {
            continue;
        }
        ids.insert(id);
        let preview = content
            .strip_prefix("user_message ")
            .or_else(|| content.strip_prefix("user "))
            .unwrap_or(&content)
            .to_string();
        *content_counts
            .entry(user_content_dedup_key(&preview))
            .or_insert(0) += 1;
    }
    Ok((ids, content_counts))
}

fn backfill_missing_user_events(conn: &Connection, session_id: &str) -> SqliteResult<usize> {
    let messages = load_user_messages(conn, session_id)?;
    if messages.is_empty() {
        return Ok(0);
    }

    let (existing_ids, mut existing_content_counts) =
        load_existing_user_event_keys(conn, session_id)?;
    let mut inserted = 0;
    for message in messages {
        let event_id = user_event_id_for_message(&message.id);
        if existing_ids.contains(&event_id) {
            continue;
        }
        if let Some(count) =
            existing_content_counts.get_mut(&user_content_dedup_key(&message.content))
        {
            if *count > 0 {
                *count -= 1;
                continue;
            }
        }

        let images_value = message
            .images
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .unwrap_or(serde_json::Value::Null);
        let result = if images_value.is_null() {
            serde_json::json!({
                "type": "user",
                "message": { "content": &message.content, "role": "user" },
                "backendPersisted": true,
                "messageId": &message.id,
            })
        } else {
            serde_json::json!({
                "type": "user",
                "message": { "content": &message.content, "role": "user" },
                "images": images_value,
                "backendPersisted": true,
                "messageId": &message.id,
            })
        };
        let meta = serde_json::json!({
            "source": "user",
            "displayText": &message.content,
            "displayStatus": "completed",
            "displayVariant": "message",
            "activityStatus": "agent",
            "uiCanonical": "user_message",
            "chunk_id": event_id,
            "callId": null,
            "filePath": null,
            "command": null,
            "isDelta": false,
            "processId": null,
            "repoId": null,
            "repoPath": null,
        });
        let content = format!("user_message {}", message.content);

        let affected = conn.execute(
            "INSERT OR IGNORE INTO events
             (id, session_id, event_type, function_name, thread_id, args_json, result_json,
              content, created_at, meta_json, history_sequence)
             VALUES (?1, ?2, 'raw', 'user_message', NULL, '{}', ?3, ?4, ?5, ?6, ?7)",
            params![
                event_id,
                session_id,
                serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string()),
                content,
                message.created_at,
                serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string()),
                message.sequence,
            ],
        )?;
        inserted += affected;
    }

    Ok(inserted)
}

fn duration_ms(started_at: &str, ended_at: Option<&str>) -> Option<i64> {
    let ended_at = ended_at?;
    let start = DateTime::parse_from_rfc3339(started_at).ok()?;
    let end = DateTime::parse_from_rfc3339(ended_at).ok()?;
    Some((end - start).num_milliseconds().max(0))
}

fn max_timestamp(left: &str, right: &str) -> String {
    match (
        DateTime::parse_from_rfc3339(left),
        DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left_time), Ok(right_time)) if right_time > left_time => right.to_string(),
        (Ok(_), Ok(_)) => left.to_string(),
        _ if right > left => right.to_string(),
        _ => left.to_string(),
    }
}

struct TurnDraftBuilder<'a> {
    stale_intent_ids: &'a StaleIntentIds,
    drafts: Vec<TurnDraft>,
    current: Option<TurnDraft>,
}

impl<'a> TurnDraftBuilder<'a> {
    fn new(stale_intent_ids: &'a StaleIntentIds) -> Self {
        Self {
            stale_intent_ids,
            drafts: Vec::new(),
            current: None,
        }
    }

    fn push(&mut self, row: &IndexEventRow) {
        if is_user_message(row) {
            let row_intent_id = turn_intent_id_for_row(row);

            // Lifecycle-pre-durable terminal: this intent will never yield
            // a durable round (Stale = invalidated). Drop the row entirely
            // so the indexer does not paint a phantom turn.
            if let Some(ref intent_id) = row_intent_id {
                if self.stale_intent_ids.contains(intent_id) {
                    return;
                }
            }

            // Group-by-intent: if the row shares an intent with the open
            // turn, merge into it (the optimistic synthetic event landed
            // first; the durable backend row arrives later with the same
            // id). Adds the new event id so user_event_ids tracks both,
            // but does not open a new round.
            if let (Some(intent_id), Some(turn)) = (row_intent_id.as_ref(), self.current.as_mut()) {
                if turn.turn_intent_id.as_ref() == Some(intent_id) {
                    turn.user_event_ids.push(row.id.clone());
                    turn.event_count += 1;
                    turn.ended_at = Some(max_timestamp(&turn.started_at, &row.created_at));
                    return;
                }
            }

            if let Some(mut completed) = self.current.take() {
                completed.end_sequence = Some(row.order_sequence);
                completed.next_turn_id = Some(row.id.clone());
                self.drafts.push(completed);
            }

            self.current = Some(TurnDraft {
                turn_id: row.id.clone(),
                start_sequence: row.order_sequence,
                end_sequence: None,
                next_turn_id: None,
                started_at: row.created_at.clone(),
                ended_at: Some(row.created_at.clone()),
                user_event_ids: vec![row.id.clone()],
                user_preview: row.content.clone(),
                event_count: 1,
                body_event_count: 0,
                turn_intent_id: row_intent_id,
                metadata_accumulator: TurnMetadataAccumulator::new(),
            });
            return;
        }

        if let Some(ref mut turn) = self.current {
            turn.ended_at = Some(max_timestamp(&turn.started_at, &row.created_at));
            turn.event_count += 1;
            turn.body_event_count += 1;
            turn.metadata_accumulator.add_event_at(
                row.function_name.as_deref(),
                &row.args_json,
                &row.result_json,
                &row.created_at,
            );
        }
    }

    fn finish(mut self) -> Vec<TurnDraft> {
        if let Some(turn) = self.current.take() {
            self.drafts.push(turn);
        }
        materialized_turn_drafts(self.drafts)
    }
}

#[cfg(test)]
fn build_turn_drafts(rows: &[IndexEventRow], stale_intent_ids: &StaleIntentIds) -> Vec<TurnDraft> {
    let mut builder = TurnDraftBuilder::new(stale_intent_ids);
    for row in rows {
        builder.push(row);
    }
    builder.finish()
}

/// Aggregate directly from SQLite's cursor so a GiB-scale transcript is
/// never retained as a second in-memory vector during index construction.
fn stream_turn_drafts(
    conn: &Connection,
    session_id: &str,
    stale_intent_ids: &StaleIntentIds,
) -> SqliteResult<Vec<TurnDraft>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, function_name, args_json, result_json, content, created_at,
                history_sequence AS order_sequence
         FROM events
         WHERE session_id = ?1
         ORDER BY history_sequence ASC, created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([session_id], index_event_row)?;
    let mut builder = TurnDraftBuilder::new(stale_intent_ids);
    for row in rows {
        let row = row?;
        builder.push(&row);
    }
    Ok(builder.finish())
}

fn materialized_turn_drafts(drafts: Vec<TurnDraft>) -> Vec<TurnDraft> {
    let last_index = drafts.len().saturating_sub(1);
    drafts
        .into_iter()
        .enumerate()
        .filter_map(|(index, draft)| {
            if draft.body_event_count > 0 || index == last_index {
                Some(draft)
            } else {
                None
            }
        })
        .collect()
}

fn turn_summary_from_row(row: &rusqlite::Row<'_>) -> SqliteResult<CachedTurnSummary> {
    let user_event_ids_json: String = row.get(8)?;
    let user_event_ids = serde_json::from_str(&user_event_ids_json).unwrap_or_else(|_| Vec::new());
    let interrupted_int: i64 = row.get(13)?;
    let modified_files_json: String = row.get(14)?;
    let modified_files = serde_json::from_str(&modified_files_json).unwrap_or_else(|_| Vec::new());
    let resource_interactions_json: String = row.get(15)?;
    let resource_interactions =
        serde_json::from_str(&resource_interactions_json).unwrap_or_else(|_| Vec::new());
    let git_artifacts_json: String = row.get(16)?;
    let git_artifacts = serde_json::from_str(&git_artifacts_json).unwrap_or_else(|_| Vec::new());

    Ok(CachedTurnSummary {
        session_id: row.get(0)?,
        turn_id: row.get(1)?,
        start_sequence: row.get(2)?,
        end_sequence: row.get(3)?,
        next_turn_id: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        duration_ms: row.get(7)?,
        user_event_ids,
        user_preview: row.get(9)?,
        event_count: row.get(10)?,
        body_event_count: row.get(11)?,
        status: row.get(12)?,
        interrupted: interrupted_int != 0,
        modified_files,
        resource_interactions,
        git_artifacts,
    })
}

pub fn rebuild_turn_index(session_id: &str) -> SqliteResult<Vec<CachedTurnSummary>> {
    with_sessions_writer(|| rebuild_turn_index_inner(session_id))
}

fn rebuild_turn_index_inner(session_id: &str) -> SqliteResult<Vec<CachedTurnSummary>> {
    let conn = get_connection()?;
    backfill_missing_user_events(&conn, session_id)?;
    normalize_session_sequences(&conn, session_id)?;
    // Consult the lifecycle store so the indexer can drop rows whose
    // intent was retired before it ran (Stale). Read failure
    // falls back to an empty set, which preserves the legacy behaviour of
    // building rounds purely from events.
    let stale_intent_ids = load_stale_intent_ids(session_id);
    let intent_status_overlay = load_intent_status_overlay(session_id);
    let drafts = stream_turn_drafts(&conn, session_id, &stale_intent_ids)?;
    let (event_count, max_sequence) = event_state(&conn, session_id)?;
    let rebuilt_at = Utc::now().to_rfc3339();

    let tx = begin_immediate(&conn)?;
    tx.execute(
        "DELETE FROM session_turns WHERE session_id = ?1",
        [session_id],
    )?;

    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO session_turns
             (session_id, turn_id, start_sequence, end_sequence, next_turn_id, started_at, ended_at,
              duration_ms, user_event_ids_json, user_preview, event_count, body_event_count,
              status, interrupted, updated_at, modified_files_json, resource_interactions_json,
              git_artifacts_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        )?;

        for draft in &drafts {
            let user_event_ids_json =
                serde_json::to_string(&draft.user_event_ids).unwrap_or_else(|_| "[]".to_string());
            let modified_files_json = serde_json::to_string(draft.metadata_accumulator.files())
                .unwrap_or_else(|_| "[]".to_string());
            let resource_interactions_json =
                serde_json::to_string(draft.metadata_accumulator.resource_interactions())
                    .unwrap_or_else(|_| "[]".to_string());
            let git_artifacts_json =
                serde_json::to_string(draft.metadata_accumulator.git_artifacts())
                    .unwrap_or_else(|_| "[]".to_string());
            // Status derivation: lifecycle store wins when available.
            // Falls back to the legacy `body_event_count > 0` heuristic for
            // rows that predate the canonical intent id (no row in
            // `session_turn_intents`). The lifecycle store is the
            // authoritative source for cancelled turns that had zero body
            // events and for turns interrupted mid-stream.
            let status = draft
                .turn_intent_id
                .as_ref()
                .and_then(|intent_id| intent_status_overlay.get(intent_id))
                .map(|status| match status.as_str() {
                    "completed" => TURN_STATUS_COMPLETED,
                    "failed" | "cancelled" => TURN_STATUS_FAILED,
                    // Running / queued / optimistic all surface as pending
                    // — the round is open and we don't yet know the
                    // terminal outcome.
                    _ => TURN_STATUS_PENDING,
                })
                .unwrap_or_else(|| {
                    if draft.body_event_count > 0 {
                        TURN_STATUS_COMPLETED
                    } else {
                        TURN_STATUS_PENDING
                    }
                });
            stmt.execute(params![
                session_id,
                draft.turn_id,
                draft.start_sequence,
                draft.end_sequence,
                draft.next_turn_id,
                draft.started_at,
                draft.ended_at,
                duration_ms(&draft.started_at, draft.ended_at.as_deref()),
                user_event_ids_json,
                draft.user_preview,
                draft.event_count,
                draft.body_event_count,
                status,
                0_i64,
                rebuilt_at,
                modified_files_json,
                resource_interactions_json,
                git_artifacts_json,
            ])?;
        }
    }

    tx.execute(
        "INSERT INTO session_turn_index_state
         (session_id, indexed_event_count, indexed_max_sequence, rebuilt_at, index_version)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id) DO UPDATE SET
           indexed_event_count = excluded.indexed_event_count,
           indexed_max_sequence = excluded.indexed_max_sequence,
           rebuilt_at = excluded.rebuilt_at,
           index_version = excluded.index_version",
        params![
            session_id,
            event_count,
            max_sequence,
            rebuilt_at,
            TURN_INDEX_VERSION
        ],
    )?;
    tx.commit()?;

    load_turn_index(session_id)
}

pub fn ensure_turn_index_fresh(session_id: &str) -> SqliteResult<()> {
    // `backfill_missing_user_events` and `normalize_session_sequences`
    // are writers, so the freshness check and the optional rebuild all
    // run under one writer-lock acquisition. The lock is cheap to take
    // and easier to reason about than splitting the check across
    // multiple guard scopes.
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let inserted_user_events = backfill_missing_user_events(&conn, session_id)?;
        if inserted_user_events > 0 {
            normalize_session_sequences(&conn, session_id)?;
        }
        let (event_count, max_sequence) = event_state(&conn, session_id)?;
        let state = conn
            .query_row(
                "SELECT indexed_event_count, indexed_max_sequence, index_version
                 FROM session_turn_index_state
                 WHERE session_id = ?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;

        let fresh = inserted_user_events == 0
            && state
                .map(
                    |(indexed_event_count, indexed_max_sequence, index_version)| {
                        indexed_event_count == event_count
                            && indexed_max_sequence == max_sequence
                            && index_version == TURN_INDEX_VERSION
                    },
                )
                .unwrap_or(false);

        if fresh {
            return Ok(());
        }

        drop(conn);
        rebuild_turn_index_inner(session_id).map(|_| ())
    })
}

pub fn load_turn_index(session_id: &str) -> SqliteResult<Vec<CachedTurnSummary>> {
    ensure_turn_index_fresh(session_id)?;
    let conn = get_connection()?;
    select_turn_index(&conn, session_id)
}

/// Read the materialized turn index as it is, on the caller's connection:
/// no freshness check, no writer lock, no user-event backfill, no rebuild.
///
/// Listing surfaces that only summarize already-indexed rounds (the session
/// directory's impact columns) read here. Transcript readers keep
/// `load_turn_index`, whose freshness check is the thing that made a full
/// session listing cost a writer-lock round trip per session.
pub fn load_cached_turn_index(
    conn: &Connection,
    session_id: &str,
) -> SqliteResult<Vec<CachedTurnSummary>> {
    select_turn_index(conn, session_id)
}

fn select_turn_index(conn: &Connection, session_id: &str) -> SqliteResult<Vec<CachedTurnSummary>> {
    let mut stmt = conn.prepare_cached(
        "SELECT session_id, turn_id, start_sequence, end_sequence, next_turn_id, started_at, ended_at,
                duration_ms, user_event_ids_json, user_preview, event_count, body_event_count,
                status, interrupted, modified_files_json, resource_interactions_json,
                git_artifacts_json
         FROM session_turns
         WHERE session_id = ?1
         ORDER BY started_at ASC, start_sequence ASC",
    )?;

    let rows = stmt
        .query_map([session_id], turn_summary_from_row)?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(rows)
}

/// Load only the requested materialized rounds. This is the low-memory read
/// path used by a paged/virtualized transcript; the durable index remains the
/// source of truth and no session-wide summary vector is constructed.
pub fn load_turn_summaries(
    session_id: &str,
    turn_ids: &[String],
) -> SqliteResult<Vec<CachedTurnSummary>> {
    ensure_turn_index_fresh(session_id)?;
    let conn = get_connection()?;
    let mut summaries = Vec::with_capacity(turn_ids.len());
    let mut statement = conn.prepare_cached(
        "SELECT session_id, turn_id, start_sequence, end_sequence, next_turn_id, started_at, ended_at,
                duration_ms, user_event_ids_json, user_preview, event_count, body_event_count,
                status, interrupted, modified_files_json, resource_interactions_json,
                git_artifacts_json
         FROM session_turns
         WHERE session_id = ?1 AND turn_id = ?2",
    )?;
    for turn_id in turn_ids {
        if let Some(summary) = statement
            .query_row(params![session_id, turn_id], turn_summary_from_row)
            .optional()?
        {
            summaries.push(summary);
        }
    }
    Ok(summaries)
}

pub fn get_turn_summary(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
) -> SqliteResult<Option<CachedTurnSummary>> {
    conn.query_row(
        "SELECT session_id, turn_id, start_sequence, end_sequence, next_turn_id, started_at, ended_at,
                duration_ms, user_event_ids_json, user_preview, event_count, body_event_count,
                status, interrupted, modified_files_json, resource_interactions_json,
                git_artifacts_json
         FROM session_turns
         WHERE session_id = ?1 AND turn_id = ?2",
        params![session_id, turn_id],
        turn_summary_from_row,
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        id: &str,
        function_name: Option<&str>,
        result_json: &str,
        sequence: i64,
    ) -> IndexEventRow {
        IndexEventRow {
            id: id.to_string(),
            function_name: function_name.map(str::to_string),
            args_json: "{}".to_string(),
            result_json: result_json.to_string(),
            content: id.to_string(),
            created_at: "2026-05-27T00:00:00Z".to_string(),
            order_sequence: sequence,
        }
    }

    fn create_backfill_test_tables(conn: &Connection) {
        crate::schema::init_session_tables(conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                images TEXT
            );",
        )
        .unwrap();
    }

    #[test]
    fn load_cached_turn_index_reads_without_backfilling() {
        // The listing path must be a pure read: a session whose persisted
        // user message has not been backfilled into `events` yet stays
        // untouched (no inserted user event, no index state row), and the
        // read reports whatever rounds are materialized — here none.
        let conn = Connection::open_in_memory().unwrap();
        create_backfill_test_tables(&conn);
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at, images)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, NULL)",
            params![
                "message-1",
                "session-1",
                "hello from persisted user",
                1_i64,
                "2026-05-27T00:00:00Z",
            ],
        )
        .unwrap();

        let turns = load_cached_turn_index(&conn, "session-1").unwrap();
        assert!(turns.is_empty());

        let events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE session_id = ?1",
                params!["session-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 0);
        let index_states: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_turn_index_state WHERE session_id = ?1",
                params!["session-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_states, 0);
    }

    #[test]
    fn backfill_missing_user_events_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        create_backfill_test_tables(&conn);
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at, images)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, NULL)",
            params![
                "message-1",
                "session-1",
                "hello from persisted user",
                1_i64,
                "2026-05-27T00:00:00Z",
            ],
        )
        .unwrap();

        assert_eq!(backfill_missing_user_events(&conn, "session-1").unwrap(), 1);
        assert_eq!(backfill_missing_user_events(&conn, "session-1").unwrap(), 0);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE session_id = ?1 AND id = ?2",
                params!["session-1", "user-message-message-1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn backfill_dedups_long_messages_against_truncated_event_previews() {
        // After a transcript rewrite (compaction) agent_messages rows get
        // fresh ids, so id-based dedup misses and we fall back to content
        // matching. Event rows store content truncated to 500 bytes; the
        // full agent_messages content must still match instead of
        // re-inserting a duplicate "[Plan approved] …" user bubble.
        let conn = Connection::open_in_memory().unwrap();
        create_backfill_test_tables(&conn);

        let long_content = format!(
            "[Plan approved] Implement the approved plan now. 计划正文 {}",
            "非常长的计划内容 plan body ".repeat(200)
        );
        assert!(long_content.len() > 1_000);

        conn.execute(
            "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at, images)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, NULL)",
            params![
                "rewritten-id",
                "session-1",
                &long_content,
                1_i64,
                "2026-05-27T00:00:00Z",
            ],
        )
        .unwrap();

        // Pre-existing event row from the original submit (different
        // message id, content truncated like build_searchable_content).
        let truncated = user_content_dedup_key(&long_content);
        conn.execute(
            "INSERT INTO events
             (id, session_id, event_type, function_name, thread_id, args_json, result_json,
              content, created_at, meta_json, history_sequence)
             VALUES (?1, ?2, 'raw', 'user_message', NULL, '{}', ?3, ?4, ?5, '{}', 1)",
            params![
                "user-message-original-id",
                "session-1",
                r#"{"backendPersisted":true}"#,
                format!("user_message {truncated}"),
                "2026-05-27T00:00:00Z",
            ],
        )
        .unwrap();

        assert_eq!(backfill_missing_user_events(&conn, "session-1").unwrap(), 0);
    }

    #[test]
    fn synthetic_user_input_does_not_start_turn() {
        let rows = vec![
            row(
                "user-input-optimistic",
                Some(USER_MESSAGE_FUNCTION),
                r#"{"syntheticUserInput":true}"#,
                1,
            ),
            row("assistant-event", Some("assistant_message"), "{}", 2),
            row(
                "user-message-authoritative",
                Some(USER_MESSAGE_FUNCTION),
                r#"{"backendPersisted":true}"#,
                3,
            ),
        ];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].turn_id, "user-message-authoritative");
        assert_eq!(drafts[0].start_sequence, 3);
    }

    #[test]
    fn imported_user_alias_starts_turn() {
        let rows = vec![
            row(
                "imported-user",
                Some(IMPORTED_USER_MESSAGE_FUNCTION),
                "{}",
                1,
            ),
            row("assistant-event", Some("assistant"), "{}", 2),
        ];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].turn_id, "imported-user");
        assert_eq!(drafts[0].body_event_count, 1);
    }

    #[test]
    fn consecutive_user_messages_do_not_materialize_ghost_pending_turns() {
        let rows = vec![
            row(
                "user-message-queued-ghost",
                Some(USER_MESSAGE_FUNCTION),
                r#"{"backendPersisted":true}"#,
                1,
            ),
            row(
                "user-message-authoritative",
                Some(USER_MESSAGE_FUNCTION),
                r#"{"backendPersisted":true}"#,
                2,
            ),
            row("assistant-event", Some("assistant_message"), "{}", 3),
        ];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].turn_id, "user-message-authoritative");
        assert_eq!(drafts[0].start_sequence, 2);
        assert_eq!(drafts[0].body_event_count, 1);
    }

    #[test]
    fn latest_user_only_turn_still_materializes_as_pending() {
        let rows = vec![row(
            "user-message-latest",
            Some(USER_MESSAGE_FUNCTION),
            r#"{"backendPersisted":true}"#,
            1,
        )];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].turn_id, "user-message-latest");
        assert_eq!(drafts[0].body_event_count, 0);
    }

    #[test]
    fn two_rows_with_same_turn_intent_id_collapse_into_one_round() {
        // The optimistic synthetic event is normally filtered out by
        // `is_synthetic_user_input`, but a backend can also legitimately
        // persist two user_message rows under the same intent (inbox
        // transcript followed by main submit). The indexer must collapse
        // them into a single round so the user sees one bubble, not two.
        let intent = r#"{"backendPersisted":true,"turnIntentId":"intent-A"}"#;
        let rows = vec![
            row("user-message-1", Some(USER_MESSAGE_FUNCTION), intent, 1),
            row("user-message-2", Some(USER_MESSAGE_FUNCTION), intent, 2),
            row("assistant-event", Some("assistant_message"), "{}", 3),
        ];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 1);
        // The first user_message that opened the round wins as turn_id;
        // both user event ids are tracked.
        assert_eq!(drafts[0].turn_id, "user-message-1");
        assert_eq!(
            drafts[0].user_event_ids,
            vec!["user-message-1".to_string(), "user-message-2".to_string()]
        );
        assert_eq!(drafts[0].event_count, 3);
        assert_eq!(drafts[0].body_event_count, 1);
    }

    #[test]
    fn rows_with_stale_intent_are_dropped() {
        // Reproduces the Stop + model switch + Send Now path: the first
        // submit's intent was retired (stale) before its user_message
        // row was even persisted. The indexer must not paint a phantom
        // round for it.
        let stale = r#"{"backendPersisted":true,"turnIntentId":"intent-stale"}"#;
        let fresh = r#"{"backendPersisted":true,"turnIntentId":"intent-fresh"}"#;
        let rows = vec![
            row("user-message-stale", Some(USER_MESSAGE_FUNCTION), stale, 1),
            row("user-message-fresh", Some(USER_MESSAGE_FUNCTION), fresh, 2),
            row("assistant-event", Some("assistant_message"), "{}", 3),
        ];

        let mut stale_ids = StaleIntentIds::new();
        stale_ids.insert("intent-stale".to_string());
        let drafts = build_turn_drafts(&rows, &stale_ids);

        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].turn_id, "user-message-fresh");
    }

    #[test]
    fn rows_with_distinct_turn_intent_ids_stay_separate() {
        let intent_a = r#"{"backendPersisted":true,"turnIntentId":"intent-A"}"#;
        let intent_b = r#"{"backendPersisted":true,"turnIntentId":"intent-B"}"#;
        let rows = vec![
            row("user-message-a", Some(USER_MESSAGE_FUNCTION), intent_a, 1),
            row("assistant-1", Some("assistant_message"), "{}", 2),
            row("user-message-b", Some(USER_MESSAGE_FUNCTION), intent_b, 3),
            row("assistant-2", Some("assistant_message"), "{}", 4),
        ];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].turn_id, "user-message-a");
        assert_eq!(drafts[1].turn_id, "user-message-b");
    }

    #[test]
    fn round_metadata_is_projected_by_orgtrack_from_normalized_provider_events() {
        let mut read = row("read-1", Some("Read"), "{}", 2);
        read.args_json = r#"{"file_path":"src/lib.rs"}"#.to_string();
        let mut search = row(
            "search-1",
            Some("Grep"),
            r#"{"matches":[{"file":"src/lib.rs"},{"file":"src/main.rs"}]}"#,
            3,
        );
        search.args_json = r#"{"path":"src"}"#.to_string();
        let rows = vec![
            row(
                "user-message-1",
                Some(USER_MESSAGE_FUNCTION),
                r#"{"backendPersisted":true}"#,
                1,
            ),
            read,
            search,
        ];

        let drafts = build_turn_drafts(&rows, &StaleIntentIds::new());

        assert_eq!(drafts.len(), 1);
        assert!(drafts[0]
            .metadata_accumulator
            .resource_interactions()
            .iter()
            .any(|item| item.path == "src/lib.rs" && item.action.as_str() == "read"));
        // search-rows: the Grep is projected away entirely, so `src/main.rs` —
        // named only by that search's matches — never reaches the index.
        assert!(!drafts[0]
            .metadata_accumulator
            .resource_interactions()
            .iter()
            .any(|item| item.action.as_str() == "search"));
        assert!(!drafts[0]
            .metadata_accumulator
            .resource_interactions()
            .iter()
            .any(|item| item.path == "src/main.rs"));
    }
}
