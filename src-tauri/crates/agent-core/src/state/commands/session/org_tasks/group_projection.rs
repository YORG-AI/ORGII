//! Bounded, backend-authoritative Agent Org Group timeline projection.
//!
//! One page is assembled with four SQL statements regardless of Team size:
//! canonical run resolution, Turn contexts, exact source messages, and exact
//! assistant replies. Direct Member work is excluded by the context predicate.

use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use database::db::get_connection;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::coordination::agent_org_runs::{context_for_run_record, row_to_run, AgentOrgRunContext};
use crate::state::AgentAppState;

const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 100;
const MAX_PAGE_BYTES: usize = 1024 * 1024;
const MAX_CURSOR_BYTES: usize = 256;
const MAX_EVENT_JSON_BYTES: usize = 256 * 1024;
const MAX_VISIBLE_TEXT_CHARS: usize = 32_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgGroupRoute {
    Coordinator,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgGroupItemKind {
    UserMessage,
    AssistantReply,
    Diagnostic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgGroupDisplayState {
    Queued,
    Running,
    Answered,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgGroupRetryMode {
    Rekick,
    NewTurn,
    NewTurnWithConfirmation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentOrgGroupSourceRef {
    Event { id: String },
    Inbox { id: i64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupProjectionItem {
    pub id: String,
    pub kind: AgentOrgGroupItemKind,
    pub turn_intent_id: String,
    pub route: AgentOrgGroupRoute,
    pub target_member_id: String,
    pub target_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responder_member_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responder_name: Option<String>,
    pub source_ref: AgentOrgGroupSourceRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_item_id: Option<String>,
    pub text: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<AgentOrgGroupDisplayState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub can_stop: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_mode: Option<AgentOrgGroupRetryMode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupProjectionPage {
    pub run_id: String,
    pub items: Vec<AgentOrgGroupProjectionItem>,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct GroupProjectionCursor {
    version: u8,
    context_id: i64,
    item_ordinal: u8,
}

#[derive(Debug, Clone)]
struct ContextRow {
    context_id: i64,
    session_id: String,
    turn_intent_id: String,
    source_kind: String,
    source_id: String,
    participant_id: String,
    intent_status: String,
    delivery_status: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone)]
struct SourceRow {
    result_json: Option<String>,
    payload_json: Option<String>,
    created_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ReplyRow {
    result_json: String,
    content: String,
    created_at: String,
}

#[derive(Debug, Clone)]
struct KeyedItem {
    context_id: i64,
    ordinal: u8,
    item: AgentOrgGroupProjectionItem,
}

#[tauri::command]
pub async fn agent_org_group_projection_page(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<AgentOrgGroupProjectionPage, String> {
    agent_org_group_projection_page_impl(&state, &session_id, cursor.as_deref(), limit).await
}

pub async fn agent_org_group_projection_page_impl(
    _state: &AgentAppState,
    session_id: &str,
    cursor: Option<&str>,
    limit: Option<usize>,
) -> Result<AgentOrgGroupProjectionPage, String> {
    crate::coordination::agent_org_runs::require_agent_org_redesign()?;
    let cursor = cursor.map(decode_cursor).transpose()?;
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).clamp(1, MAX_PAGE_LIMIT);
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || load_projection_page(&session_id, cursor, limit))
        .await
        .map_err(|error| format!("Agent Org Group projection worker failed: {error}"))?
}

fn decode_cursor(raw: &str) -> Result<GroupProjectionCursor, String> {
    if raw.is_empty() || raw.len() > MAX_CURSOR_BYTES {
        return Err("invalid_group_projection_cursor".to_string());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| "invalid_group_projection_cursor".to_string())?;
    let cursor: GroupProjectionCursor = serde_json::from_slice(&bytes)
        .map_err(|_| "invalid_group_projection_cursor".to_string())?;
    if cursor.version != 1 || cursor.context_id <= 0 || cursor.item_ordinal > 1 {
        return Err("invalid_group_projection_cursor".to_string());
    }
    Ok(cursor)
}

fn encode_cursor(context_id: i64, item_ordinal: u8) -> Result<String, String> {
    let raw = serde_json::to_vec(&GroupProjectionCursor {
        version: 1,
        context_id,
        item_ordinal,
    })
    .map_err(|_| "group_projection_cursor_encode_failed".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn load_projection_page(
    session_id: &str,
    cursor: Option<GroupProjectionCursor>,
    limit: usize,
) -> Result<AgentOrgGroupProjectionPage, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    let context = resolve_context(&conn, session_id)?;
    let contexts = load_context_rows(&conn, &context.run_id, cursor, limit)?;
    let sources = load_source_rows(&conn, &context.run_id, &contexts)?;
    let replies = load_reply_rows(&conn, &contexts)?;

    let mut keyed = Vec::with_capacity(contexts.len() * 2);
    for row in &contexts {
        append_context_items(
            &context,
            row,
            sources.get(&row.context_id),
            replies.get(&row.context_id),
            &mut keyed,
        );
    }
    keyed.sort_by_key(|item| (item.context_id, item.ordinal));
    if let Some(cursor) = cursor {
        keyed.retain(|item| {
            (item.context_id, item.ordinal) < (cursor.context_id, cursor.item_ordinal)
        });
    }
    keyed.reverse();
    let mut has_more = keyed.len() > limit;
    keyed.truncate(limit);
    keyed.reverse();

    let mut page = AgentOrgGroupProjectionPage {
        run_id: context.run_id,
        items: keyed.iter().map(|entry| entry.item.clone()).collect(),
        has_more,
        next_cursor: None,
    };
    finalize_page_bounds(&mut page, &mut keyed, &mut has_more)?;
    Ok(page)
}

fn finalize_page_bounds(
    page: &mut AgentOrgGroupProjectionPage,
    keyed: &mut Vec<KeyedItem>,
    has_more: &mut bool,
) -> Result<(), String> {
    loop {
        page.has_more = *has_more;
        page.next_cursor = if *has_more {
            keyed
                .first()
                .map(|entry| encode_cursor(entry.context_id, entry.ordinal))
                .transpose()?
        } else {
            None
        };
        let serialized = serde_json::to_vec(page)
            .map_err(|_| "group_projection_serialize_failed".to_string())?;
        if serialized.len() <= MAX_PAGE_BYTES {
            return Ok(());
        }
        if page.items.len() <= 1 || keyed.len() <= 1 {
            return Err("group_projection_item_too_large".to_string());
        }
        page.items.remove(0);
        keyed.remove(0);
        *has_more = true;
    }
}

/// Query 1/4: resolve the supplied Session to the canonical immutable run.
fn resolve_context(conn: &Connection, session_id: &str) -> Result<AgentOrgRunContext, String> {
    let run = conn
        .query_row(
            "WITH RECURSIVE ancestry(session_id,parent_session_id,depth) AS (
               SELECT session_id,parent_session_id,0
               FROM agent_sessions WHERE session_id=?1
               UNION ALL
               SELECT parent.session_id,parent.parent_session_id,ancestry.depth+1
               FROM agent_sessions parent
               JOIN ancestry ON parent.session_id=ancestry.parent_session_id
               WHERE ancestry.depth<64
             )
             SELECT run.id,run.org_id,run.coordinator_agent_id,run.root_session_id,
                    run.org_snapshot_json,run.entry_mode,run.status,
                    run.activation_generation,run.has_initial_work,run.work_item_id,
                    run.project_slug,run.routine_fire_id,run.summary,run.last_error,
                    run.failure_json,run.last_activity_outcome,run.created_at,
                    run.updated_at,run.idled_at,run.archived_at,run.archive_receipt_id
             FROM agent_org_runtime_runs run
             JOIN ancestry ON ancestry.session_id=run.root_session_id
             ORDER BY ancestry.depth ASC,run.created_at DESC
             LIMIT 1",
            params![session_id],
            row_to_run,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "agent_org_group_projection_not_found".to_string())?;
    context_for_run_record(&run).map_err(|_| "agent_org_group_projection_invalid_run".to_string())
}

/// Query 2/4: page only Group-owned Turn contexts. Direct work is impossible
/// to materialize because it is absent from this SQL predicate.
fn load_context_rows(
    conn: &Connection,
    run_id: &str,
    cursor: Option<GroupProjectionCursor>,
    limit: usize,
) -> Result<Vec<ContextRow>, String> {
    // A cursor on ordinal 0 excludes that whole context. Fetch one additional
    // context in that case so `has_more` is derived from an actual extra item
    // instead of producing a conservative empty follow-up page.
    let fetch_limit = limit + 1 + usize::from(cursor.is_some_and(|value| value.item_ordinal == 0));
    let mut stmt = conn
        .prepare(
            "SELECT context.context_id,context.session_id,context.turn_intent_id,
                    context.source_kind,context.source_id,context.participant_id,
                    intent.status,delivery.status,context.created_at
             FROM agent_org_runtime_turn_contexts context
             JOIN session_turn_intents intent
               ON intent.session_id=context.session_id
              AND intent.turn_intent_id=context.turn_intent_id
             LEFT JOIN agent_org_runtime_user_directed_deliveries delivery
               ON delivery.session_id=context.session_id
              AND delivery.turn_intent_id=context.turn_intent_id
             WHERE context.org_run_id=?1
               AND context.source_kind IN ('group_root','group_mention')
               AND (?2 IS NULL OR context.context_id<=?2)
             ORDER BY context.context_id DESC
             LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![
                run_id,
                cursor.map(|value| value.context_id),
                fetch_limit as i64
            ],
            |row| {
                Ok(ContextRow {
                    context_id: row.get(0)?,
                    session_id: row.get(1)?,
                    turn_intent_id: row.get(2)?,
                    source_kind: row.get(3)?,
                    source_id: row.get(4)?,
                    participant_id: row.get(5)?,
                    intent_status: row.get(6)?,
                    delivery_status: row.get(7)?,
                    created_at: row.get(8)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

/// Query 3/4: fetch every source row in this page in one batch.
fn load_source_rows(
    conn: &Connection,
    run_id: &str,
    contexts: &[ContextRow],
) -> Result<HashMap<i64, SourceRow>, String> {
    if contexts.is_empty() {
        // Preserve the fixed query budget in production telemetry even for an
        // empty page; this is one bounded no-row SQL statement.
        conn.query_row("SELECT 1", [], |_| Ok(()))
            .map_err(|error| error.to_string())?;
        return Ok(HashMap::new());
    }
    let values = std::iter::repeat_n("(?,?,?,?,?,?)", contexts.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH requested(context_id,source_kind,source_id,session_id,participant_id,org_run_id) AS (VALUES {values})
         SELECT requested.context_id,
                event.result_json,
                inbox.payload_json,
                COALESCE(event.created_at,inbox.created_at)
         FROM requested
         LEFT JOIN events event
           ON requested.source_kind='group_root'
          AND event.id=requested.source_id
          AND event.session_id=requested.session_id
          AND event.function_name='user_message'
         LEFT JOIN agent_org_runtime_inbox inbox
           ON requested.source_kind='group_mention'
          AND inbox.id=CAST(requested.source_id AS INTEGER)
          AND inbox.org_run_id=requested.org_run_id
          AND inbox.recipient_member_id=requested.participant_id
          AND inbox.sender_agent_id='_user'
          AND inbox.delivery_class='user_directed'"
    );
    let mut values = Vec::with_capacity(contexts.len() * 6);
    for row in contexts {
        values.push(SqlValue::Integer(row.context_id));
        values.push(SqlValue::Text(row.source_kind.clone()));
        values.push(SqlValue::Text(row.source_id.clone()));
        values.push(SqlValue::Text(row.session_id.clone()));
        values.push(SqlValue::Text(row.participant_id.clone()));
        values.push(SqlValue::Text(run_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                SourceRow {
                    result_json: row.get(1)?,
                    payload_json: row.get(2)?,
                    created_at: row.get(3)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|error| error.to_string())
}

/// Query 4/4: exact indexed reply lookup for both Group source kinds.
fn load_reply_rows(
    conn: &Connection,
    contexts: &[ContextRow],
) -> Result<HashMap<i64, ReplyRow>, String> {
    if contexts.is_empty() {
        conn.query_row("SELECT 1", [], |_| Ok(()))
            .map_err(|error| error.to_string())?;
        return Ok(HashMap::new());
    }
    let values = std::iter::repeat_n("(?,?,?,?)", contexts.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH requested(context_id,source_kind,source_id,session_id) AS (VALUES {values})
         SELECT requested.context_id,event.result_json,event.content,event.created_at
         FROM requested
         JOIN events event ON event.id=(
           SELECT candidate.id
           FROM events candidate INDEXED BY idx_events_agent_org_group_root_reply
           WHERE requested.source_kind='group_root'
             AND candidate.session_id=requested.session_id
             AND CASE WHEN json_valid(candidate.result_json)
                      THEN json_type(candidate.result_json,'$.agent_org_group_root_reply.source_event_id')='text'
                      ELSE 0 END
             AND json_extract(
                   candidate.result_json,
                   '$.agent_org_group_root_reply.source_event_id'
                 )=requested.source_id
           ORDER BY candidate.history_sequence DESC,candidate.rowid DESC,candidate.id DESC
           LIMIT 1
         )
         WHERE requested.source_kind='group_root'
         UNION ALL
         SELECT requested.context_id,event.result_json,event.content,event.created_at
         FROM requested
         JOIN events event ON event.id=(
           SELECT candidate.id
           FROM events candidate INDEXED BY idx_events_agent_org_group_mention_reply
           WHERE requested.source_kind='group_mention'
             AND candidate.session_id=requested.session_id
             AND CASE WHEN json_valid(candidate.result_json)
                      THEN json_extract(candidate.result_json,'$.agent_org_user_directed_reply.source_kind')='group_mention'
                      ELSE 0 END
             AND CAST(json_extract(
                   candidate.result_json,
                   '$.agent_org_user_directed_reply.source_inbox_id'
                 ) AS INTEGER)=CAST(requested.source_id AS INTEGER)
           ORDER BY candidate.history_sequence DESC,candidate.rowid DESC,candidate.id DESC
           LIMIT 1
         )
         WHERE requested.source_kind='group_mention'"
    );
    let mut values = Vec::with_capacity(contexts.len() * 4);
    for row in contexts {
        values.push(SqlValue::Integer(row.context_id));
        values.push(SqlValue::Text(row.source_kind.clone()));
        values.push(SqlValue::Text(row.source_id.clone()));
        values.push(SqlValue::Text(row.session_id.clone()));
    }
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                ReplyRow {
                    result_json: row.get(1)?,
                    content: row.get(2)?,
                    created_at: row.get(3)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|error| error.to_string())
}

fn append_context_items(
    context: &AgentOrgRunContext,
    row: &ContextRow,
    source: Option<&SourceRow>,
    reply: Option<&ReplyRow>,
    out: &mut Vec<KeyedItem>,
) {
    let route = if row.source_kind == "group_root" {
        AgentOrgGroupRoute::Coordinator
    } else {
        AgentOrgGroupRoute::Member
    };
    let target_name = context
        .participant_display_name(&row.participant_id)
        .unwrap_or_default();
    let source_ref = if row.source_kind == "group_root" {
        AgentOrgGroupSourceRef::Event {
            id: row.source_id.clone(),
        }
    } else {
        AgentOrgGroupSourceRef::Inbox {
            id: row.source_id.parse().unwrap_or_default(),
        }
    };
    let (source_text, source_created_at, source_error) = decode_source(row, source);
    let (state, can_stop, retry_mode) = display_state(row, reply.is_some());
    let user_id = format!("group:{}:0", row.context_id);
    out.push(KeyedItem {
        context_id: row.context_id,
        ordinal: 0,
        item: AgentOrgGroupProjectionItem {
            id: user_id.clone(),
            kind: if source_error.is_some() {
                AgentOrgGroupItemKind::Diagnostic
            } else {
                AgentOrgGroupItemKind::UserMessage
            },
            turn_intent_id: row.turn_intent_id.clone(),
            route,
            target_member_id: row.participant_id.clone(),
            target_name: target_name.clone(),
            responder_member_id: None,
            responder_name: None,
            source_ref: source_ref.clone(),
            reply_to_item_id: None,
            text: source_text,
            created_at: source_created_at,
            state: Some(state),
            error_code: source_error,
            can_stop,
            retry_mode,
        },
    });
    if let Some(reply) = reply {
        let (reply_text, reply_error) = decode_reply(reply);
        out.push(KeyedItem {
            context_id: row.context_id,
            ordinal: 1,
            item: AgentOrgGroupProjectionItem {
                id: format!("group:{}:1", row.context_id),
                kind: if reply_error.is_some() {
                    AgentOrgGroupItemKind::Diagnostic
                } else {
                    AgentOrgGroupItemKind::AssistantReply
                },
                turn_intent_id: row.turn_intent_id.clone(),
                route,
                target_member_id: row.participant_id.clone(),
                target_name: target_name.clone(),
                responder_member_id: Some(row.participant_id.clone()),
                responder_name: Some(target_name),
                source_ref,
                reply_to_item_id: Some(user_id),
                text: reply_text,
                created_at: reply.created_at.clone(),
                // A tool preamble is still a causally exact assistant event,
                // but it does not make the Turn successful. Keep partial
                // reply text visible while inheriting the authoritative Turn
                // state (running/cancelled/failed) from the source item.
                state: Some(state),
                error_code: reply_error,
                can_stop: false,
                retry_mode: None,
            },
        });
    }
}

fn decode_source(row: &ContextRow, source: Option<&SourceRow>) -> (String, String, Option<String>) {
    let Some(source) = source else {
        return (
            String::new(),
            row.created_at.clone(),
            Some("source_unavailable".to_string()),
        );
    };
    let raw = if row.source_kind == "group_root" {
        source.result_json.as_deref()
    } else {
        source.payload_json.as_deref()
    };
    let Some(raw) = raw.filter(|raw| raw.len() <= MAX_EVENT_JSON_BYTES) else {
        return (
            String::new(),
            source
                .created_at
                .clone()
                .unwrap_or_else(|| row.created_at.clone()),
            Some("source_unavailable".to_string()),
        );
    };
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            return (
                String::new(),
                source
                    .created_at
                    .clone()
                    .unwrap_or_else(|| row.created_at.clone()),
                Some("source_unavailable".to_string()),
            )
        }
    };
    let text = if row.source_kind == "group_root" {
        parsed
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str)
    } else {
        parsed.get("text").and_then(serde_json::Value::as_str)
    };
    let Some(text) = bounded_text(text) else {
        return (
            String::new(),
            source
                .created_at
                .clone()
                .unwrap_or_else(|| row.created_at.clone()),
            Some("source_unavailable".to_string()),
        );
    };
    (
        text.to_string(),
        source
            .created_at
            .clone()
            .unwrap_or_else(|| row.created_at.clone()),
        None,
    )
}

fn decode_reply(reply: &ReplyRow) -> (String, Option<String>) {
    if reply.result_json.len() <= MAX_EVENT_JSON_BYTES {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&reply.result_json) {
            if let Some(text) =
                bounded_text(parsed.get("content").and_then(serde_json::Value::as_str))
            {
                return (text.to_string(), None);
            }
        }
    }
    if let Some(text) = bounded_text(Some(&reply.content)) {
        return (text.to_string(), None);
    }
    (String::new(), Some("reply_unavailable".to_string()))
}

fn bounded_text(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_VISIBLE_TEXT_CHARS)
}

fn display_state(
    row: &ContextRow,
    has_reply: bool,
) -> (
    AgentOrgGroupDisplayState,
    bool,
    Option<AgentOrgGroupRetryMode>,
) {
    let status = row.delivery_status.as_deref().unwrap_or(&row.intent_status);
    match status {
        "pending" | "queued" | "optimistic" => (
            AgentOrgGroupDisplayState::Queued,
            true,
            Some(AgentOrgGroupRetryMode::Rekick),
        ),
        "started" | "running" => (AgentOrgGroupDisplayState::Running, true, None),
        "completed" if has_reply => (AgentOrgGroupDisplayState::Answered, false, None),
        "completed" => (
            AgentOrgGroupDisplayState::Failed,
            false,
            Some(AgentOrgGroupRetryMode::NewTurn),
        ),
        "cancelled" | "stale" => (
            AgentOrgGroupDisplayState::Cancelled,
            false,
            Some(AgentOrgGroupRetryMode::NewTurn),
        ),
        "unknown" => (
            AgentOrgGroupDisplayState::Unknown,
            false,
            Some(AgentOrgGroupRetryMode::NewTurnWithConfirmation),
        ),
        _ => (
            AgentOrgGroupDisplayState::Failed,
            false,
            Some(AgentOrgGroupRetryMode::NewTurn),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projection_connection() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open projection database");
        crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        conn.execute_batch(
            "CREATE TABLE events (
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               event_type TEXT NOT NULL,
               function_name TEXT,
               args_json TEXT NOT NULL DEFAULT '{}',
               result_json TEXT NOT NULL DEFAULT '{}',
               content TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL,
               history_sequence INTEGER
             );
             CREATE INDEX idx_events_agent_org_group_mention_reply
             ON events(
               CAST(json_extract(result_json, '$.agent_org_user_directed_reply.source_inbox_id') AS INTEGER),
               session_id,
               history_sequence
             )
             WHERE CASE WHEN json_valid(result_json)
                        THEN json_extract(result_json, '$.agent_org_user_directed_reply.source_kind')='group_mention'
                        ELSE 0 END;
             CREATE INDEX idx_events_agent_org_group_root_reply
             ON events(
               json_extract(result_json, '$.agent_org_group_root_reply.source_event_id'),
               session_id,
               history_sequence
             )
             WHERE CASE WHEN json_valid(result_json)
                        THEN json_type(result_json, '$.agent_org_group_root_reply.source_event_id')='text'
                        ELSE 0 END;
             CREATE TABLE session_turn_intents (
               session_id TEXT NOT NULL,
               turn_intent_id TEXT NOT NULL,
               client_message_id TEXT,
               org_run_id TEXT,
               source TEXT NOT NULL,
               status TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (session_id,turn_intent_id)
             );",
        )
        .expect("create projection EventStore fixture");
        crate::coordination::init_agent_org_schemas(&conn).expect("create Agent Org schemas");
        conn
    }

    fn projection_context() -> AgentOrgRunContext {
        AgentOrgRunContext {
            run_id: "run-projection".into(),
            org_id: "org-projection".into(),
            org_name: "Projection Team".into(),
            org_role: "Test bounded projection".into(),
            coordinator_agent_id: "agent-coordinator".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "Lead".into(),
            members: vec![crate::coordination::agent_org_runs::AgentOrgContextMember {
                member_id: "reviewer".into(),
                name: "Reviewer".into(),
                role: "Review".into(),
                agent_id: "agent-reviewer".into(),
            }],
            plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
            capability_index: Default::default(),
            root_session_id: Some("session-root".into()),
        }
    }

    fn seed_projection(conn: &rusqlite::Connection) -> i64 {
        let now = "2026-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
               id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
               entry_mode,status,created_at,updated_at
             ) VALUES ('run-projection','org-projection','agent-coordinator',
                       'session-root',NULL,'standalone_session','running',?1,?1)",
            [now],
        )
        .expect("insert run");
        for (session_id, member_id) in [
            ("session-root", "coordinator"),
            ("session-reviewer", "reviewer"),
            ("session-direct", "reviewer"),
        ] {
            conn.execute(
                "INSERT INTO agent_sessions (
                   session_id,name,status,created_at,updated_at,org_member_id,
                   parent_session_id
                 ) VALUES (?1,?1,'idle',?3,?3,?2,
                           CASE WHEN ?2='coordinator' THEN NULL ELSE 'session-root' END)",
                params![session_id, member_id, now],
            )
            .expect("insert session");
        }
        conn.execute(
            "INSERT INTO events (
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             ) VALUES (
               'event-root','session-root','raw','user_message','{}',
               '{\"message\":{\"content\":\"root question\"},\"turnIntentId\":\"turn-root\"}',
               'root question',?1,1
             )",
            [now],
        )
        .expect("insert root source");
        conn.execute(
            "INSERT INTO agent_org_runtime_inbox (
               delivery_class,recipient_agent_id,recipient_member_id,
               sender_agent_id,org_run_id,payload_kind,payload_json,created_at
             ) VALUES ('user_directed','agent-reviewer','reviewer','_user',
                       'run-projection','plain',
                       '{\"kind\":\"plain\",\"summary\":\"group\",\"text\":\"member question\"}',?1)",
            [now],
        )
        .expect("insert Member source");
        let inbox_id = conn.last_insert_rowid();
        for (session_id, turn_id, status) in [
            ("session-root", "turn-root", "completed"),
            ("session-reviewer", "turn-member", "completed"),
            ("session-direct", "turn-direct", "completed"),
        ] {
            conn.execute(
                "INSERT INTO session_turn_intents (
                   session_id,turn_intent_id,client_message_id,org_run_id,
                   source,status,created_at,updated_at
                 ) VALUES (?1,?2,?2,'run-projection','agent_org',?3,?4,?4)",
                params![session_id, turn_id, status, now],
            )
            .expect("insert intent");
        }
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts (
               session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
               source_kind,source_id,activation_generation,created_at
             ) VALUES ('session-root','turn-root','run-projection','coordinator',
                       'coordinator','group_root','event-root',1,?1)",
            [now],
        )
        .expect("insert GroupRoot context");
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts (
               session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
               dispatch_member_id,member_dispatch_sequence,source_kind,source_id,
               root_authority_turn_id,actor_version,created_at
             ) VALUES ('session-reviewer','turn-member','run-projection','reviewer',
                       'user_directed_work','reviewer',1,'group_mention',?1,
                       'turn-member',1,?2)",
            params![inbox_id.to_string(), now],
        )
        .expect("insert GroupMention context");
        conn.execute(
            "INSERT INTO events (
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             ) VALUES
               ('reply-root','session-root','raw','assistant','{}',
                '{\"content\":\"root answer\",\"agent_org_group_root_reply\":{\"source_event_id\":\"event-root\"}}',
                'root answer',?1,2),
               ('reply-member','session-reviewer','raw','assistant','{}',
                json_object('content','member answer','agent_org_user_directed_reply',
                  json_object('source_kind','group_mention','source_inbox_id',?2)),
                'member answer',?1,2),
               ('reply-direct','session-direct','raw','assistant','{}',
                json_object('content','direct answer','agent_org_user_directed_reply',
                  json_object('source_kind','direct_member','source_inbox_id',999)),
                'direct answer',?1,2)",
            params![now, inbox_id],
        )
        .expect("insert exact replies");
        inbox_id
    }

    #[test]
    fn cursor_round_trip_is_opaque_and_strict() {
        let encoded = encode_cursor(42, 1).expect("encode cursor");
        let decoded = decode_cursor(&encoded).expect("decode cursor");
        assert_eq!(decoded.context_id, 42);
        assert_eq!(decoded.item_ordinal, 1);
        assert_eq!(
            decode_cursor("not a cursor"),
            Err("invalid_group_projection_cursor".to_string())
        );
    }

    #[test]
    fn direct_status_projection_never_exposes_raw_failure_text() {
        let row = ContextRow {
            context_id: 1,
            session_id: "member".into(),
            turn_intent_id: "turn".into(),
            source_kind: "group_mention".into(),
            source_id: "1".into(),
            participant_id: crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.into(),
            intent_status: "failed: provider secret".into(),
            delivery_status: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        };
        let (state, can_stop, retry) = display_state(&row, false);
        assert_eq!(state, AgentOrgGroupDisplayState::Failed);
        assert!(!can_stop);
        assert_eq!(retry, Some(AgentOrgGroupRetryMode::NewTurn));
    }

    #[test]
    fn running_turn_wins_over_an_intermediate_exact_reply() {
        let row = ContextRow {
            context_id: 1,
            session_id: "coordinator".into(),
            turn_intent_id: "turn".into(),
            source_kind: "group_root".into(),
            source_id: "event".into(),
            participant_id: crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.into(),
            intent_status: "running".into(),
            delivery_status: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        };

        let (state, can_stop, retry) = display_state(&row, true);

        assert_eq!(state, AgentOrgGroupDisplayState::Running);
        assert!(can_stop);
        assert_eq!(retry, None);
    }

    #[test]
    fn cancelled_turn_wins_over_an_intermediate_exact_reply() {
        let row = ContextRow {
            context_id: 1,
            session_id: "member".into(),
            turn_intent_id: "turn".into(),
            source_kind: "group_mention".into(),
            source_id: "1".into(),
            participant_id: "reviewer".into(),
            intent_status: "cancelled".into(),
            delivery_status: Some("cancelled".into()),
            created_at: "2026-01-01T00:00:00Z".into(),
        };
        let reply = ReplyRow {
            result_json: serde_json::json!({ "content": "tool preamble" }).to_string(),
            content: "tool preamble".into(),
            created_at: "2026-01-01T00:00:01Z".into(),
        };
        let mut items = Vec::new();

        append_context_items(&projection_context(), &row, None, Some(&reply), &mut items);

        assert_eq!(
            items[0].item.state,
            Some(AgentOrgGroupDisplayState::Cancelled)
        );
        assert_eq!(
            items[0].item.retry_mode,
            Some(AgentOrgGroupRetryMode::NewTurn)
        );
        assert_eq!(items[1].item.text, "tool preamble");
        assert_eq!(
            items[1].item.state,
            Some(AgentOrgGroupDisplayState::Cancelled)
        );
    }

    #[test]
    fn serialized_payload_cap_includes_cursor_and_preserves_older_pagination() {
        let text = "x".repeat(MAX_VISIBLE_TEXT_CHARS);
        let mut keyed = (1_i64..=100)
            .map(|context_id| KeyedItem {
                context_id,
                ordinal: 0,
                item: AgentOrgGroupProjectionItem {
                    id: format!("group:{context_id}:0"),
                    kind: AgentOrgGroupItemKind::UserMessage,
                    turn_intent_id: format!("turn-{context_id}"),
                    route: AgentOrgGroupRoute::Member,
                    target_member_id: "reviewer".to_string(),
                    target_name: "Reviewer".to_string(),
                    responder_member_id: None,
                    responder_name: None,
                    source_ref: AgentOrgGroupSourceRef::Inbox { id: context_id },
                    reply_to_item_id: None,
                    text: text.clone(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    state: Some(AgentOrgGroupDisplayState::Queued),
                    error_code: None,
                    can_stop: true,
                    retry_mode: Some(AgentOrgGroupRetryMode::Rekick),
                },
            })
            .collect::<Vec<_>>();
        let mut page = AgentOrgGroupProjectionPage {
            run_id: "run-large-page".to_string(),
            items: keyed.iter().map(|entry| entry.item.clone()).collect(),
            has_more: false,
            next_cursor: None,
        };
        let mut has_more = false;

        finalize_page_bounds(&mut page, &mut keyed, &mut has_more)
            .expect("enforce exact serialized payload cap");

        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_PAGE_BYTES);
        assert!(page.items.len() < 100);
        assert!(page.has_more);
        let cursor = decode_cursor(page.next_cursor.as_deref().expect("older-page cursor"))
            .expect("decode emitted cursor");
        assert_eq!(cursor.context_id, keyed.first().unwrap().context_id);
        assert_eq!(cursor.item_ordinal, keyed.first().unwrap().ordinal);
    }

    #[test]
    fn projection_is_bounded_exact_and_read_only() {
        let conn = projection_connection();
        seed_projection(&conn);
        let before_changes = conn.total_changes();
        let rows =
            load_context_rows(&conn, "run-projection", None, 50).expect("load Group contexts");
        assert_eq!(
            rows.len(),
            2,
            "DirectMember context must be excluded in SQL"
        );
        let sources = load_source_rows(&conn, "run-projection", &rows).expect("load exact sources");
        let replies = load_reply_rows(&conn, &rows).expect("load exact replies");
        assert_eq!(replies.len(), 2);

        let context = projection_context();
        let mut items = Vec::new();
        for row in &rows {
            append_context_items(
                &context,
                row,
                sources.get(&row.context_id),
                replies.get(&row.context_id),
                &mut items,
            );
        }
        let visible = items
            .iter()
            .map(|item| item.item.text.as_str())
            .collect::<Vec<_>>();
        assert!(visible.contains(&"root question"));
        assert!(visible.contains(&"root answer"));
        assert!(visible.contains(&"member question"));
        assert!(visible.contains(&"member answer"));
        assert!(!visible.contains(&"direct answer"));
        assert_eq!(
            conn.total_changes(),
            before_changes,
            "projection reads must not mutate SQLite"
        );
    }

    #[test]
    fn malformed_source_becomes_bounded_diagnostic_without_reply_guessing() {
        let conn = projection_connection();
        seed_projection(&conn);
        conn.execute(
            "UPDATE events SET result_json='not-json' WHERE id='event-root'",
            [],
        )
        .expect("corrupt isolated source");
        let rows =
            load_context_rows(&conn, "run-projection", None, 50).expect("load Group contexts");
        let sources = load_source_rows(&conn, "run-projection", &rows).expect("load exact sources");
        let replies = load_reply_rows(&conn, &rows).expect("load exact replies");
        let root = rows
            .iter()
            .find(|row| row.source_kind == "group_root")
            .expect("root context");
        let mut items = Vec::new();
        append_context_items(
            &projection_context(),
            root,
            sources.get(&root.context_id),
            replies.get(&root.context_id),
            &mut items,
        );
        assert_eq!(items[0].item.kind, AgentOrgGroupItemKind::Diagnostic);
        assert_eq!(
            items[0].item.error_code.as_deref(),
            Some("source_unavailable")
        );
        assert_eq!(items[1].item.text, "root answer");
    }

    #[test]
    fn duplicate_reply_markers_choose_one_latest_exact_row() {
        let conn = projection_connection();
        let inbox_id = seed_projection(&conn);
        conn.execute(
            "INSERT INTO events (
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,history_sequence
             ) VALUES
               ('reply-root-latest','session-root','raw','assistant','{}',
                json_object('content','root answer latest','agent_org_group_root_reply',
                  json_object('source_event_id','event-root')),
                'root answer latest','2026-01-01T00:00:01Z',3),
               ('reply-member-latest','session-reviewer','raw','assistant','{}',
                json_object('content','member answer latest','agent_org_user_directed_reply',
                  json_object('source_kind','group_mention','source_inbox_id',?1)),
                'member answer latest','2026-01-01T00:00:01Z',3)",
            [inbox_id],
        )
        .expect("insert duplicate exact reply markers");

        let rows =
            load_context_rows(&conn, "run-projection", None, 50).expect("load Group contexts");
        let replies = load_reply_rows(&conn, &rows).expect("load one exact reply per context");

        assert_eq!(replies.len(), 2);
        let root = rows
            .iter()
            .find(|row| row.source_kind == "group_root")
            .expect("root context");
        let member = rows
            .iter()
            .find(|row| row.source_kind == "group_mention")
            .expect("member context");
        assert_eq!(replies[&root.context_id].content, "root answer latest");
        assert_eq!(replies[&member.context_id].content, "member answer latest");
    }

    #[test]
    #[ignore = "machine-local Group projection performance gate; run with --ignored --nocapture"]
    fn projection_p90_stays_bounded_for_fifty_members_and_ten_thousand_events() {
        const MEMBER_COUNT: usize = 50;
        const GROUP_CONTEXT_COUNT: usize = 1_000;
        const TOTAL_EVENT_COUNT: usize = 10_000;
        const PAGE_LIMIT: usize = 100;
        const SAMPLE_COUNT: usize = 30;

        let conn = projection_connection();
        let now = "2026-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
               id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
               entry_mode,status,created_at,updated_at
             ) VALUES ('run-projection','org-projection','agent-coordinator',
                       'session-root',NULL,'standalone_session','running',?1,?1)",
            [now],
        )
        .expect("insert performance run");
        conn.execute(
            "INSERT INTO agent_sessions (
               session_id,name,status,created_at,updated_at,org_member_id,parent_session_id
             ) VALUES ('session-root','Coordinator','idle',?1,?1,'coordinator',NULL)",
            [now],
        )
        .expect("insert performance root");
        for member_index in 0..MEMBER_COUNT {
            conn.execute(
                "INSERT INTO agent_sessions (
                   session_id,name,status,created_at,updated_at,org_member_id,parent_session_id
                 ) VALUES (?1,?2,'idle',?3,?3,?2,'session-root')",
                params![
                    format!("session-member-{member_index}"),
                    format!("member-{member_index}"),
                    now
                ],
            )
            .expect("insert performance member session");
        }

        conn.execute_batch("BEGIN IMMEDIATE")
            .expect("begin performance fixture transaction");
        for context_index in 0..GROUP_CONTEXT_COUNT {
            let member_index = context_index % MEMBER_COUNT;
            let member_id = format!("member-{member_index}");
            let session_id = format!("session-member-{member_index}");
            let turn_id = format!("turn-{context_index}");
            conn.execute(
                "INSERT INTO agent_org_runtime_inbox (
                   delivery_class,recipient_agent_id,recipient_member_id,
                   sender_agent_id,org_run_id,payload_kind,payload_json,created_at
                 ) VALUES ('user_directed',?1,?2,'_user','run-projection','plain',?3,?4)",
                params![
                    format!("agent-{member_index}"),
                    member_id,
                    serde_json::json!({
                        "kind": "plain",
                        "summary": "performance fixture",
                        "text": format!("question-{context_index}"),
                    })
                    .to_string(),
                    now
                ],
            )
            .expect("insert performance inbox source");
            let inbox_id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO session_turn_intents (
                   session_id,turn_intent_id,client_message_id,org_run_id,
                   source,status,created_at,updated_at
                 ) VALUES (?1,?2,?2,'run-projection','agent_org','completed',?3,?3)",
                params![session_id, turn_id, now],
            )
            .expect("insert performance intent");
            conn.execute(
                "INSERT INTO agent_org_runtime_turn_contexts (
                   session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
                   dispatch_member_id,member_dispatch_sequence,source_kind,source_id,
                   root_authority_turn_id,actor_version,created_at
                 ) VALUES (?1,?2,'run-projection',?3,'user_directed_work',?3,?4,
                           'group_mention',?5,?2,1,?6)",
                params![
                    session_id,
                    turn_id,
                    member_id,
                    (context_index / MEMBER_COUNT + 1) as i64,
                    inbox_id.to_string(),
                    now
                ],
            )
            .expect("insert performance GroupMention context");
            conn.execute(
                "INSERT INTO events (
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,history_sequence
                 ) VALUES (?1,?2,'raw','assistant','{}',?3,?4,?5,?6)",
                params![
                    format!("reply-{context_index}"),
                    session_id,
                    serde_json::json!({
                        "content": format!("answer-{context_index}"),
                        "agent_org_user_directed_reply": {
                            "source_kind": "group_mention",
                            "source_inbox_id": inbox_id,
                        }
                    })
                    .to_string(),
                    format!("answer-{context_index}"),
                    now,
                    (context_index + 1) as i64,
                ],
            )
            .expect("insert performance exact reply");
        }
        for noise_index in GROUP_CONTEXT_COUNT..TOTAL_EVENT_COUNT {
            conn.execute(
                "INSERT INTO events (
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,history_sequence
                 ) VALUES (?1,'session-root','raw','assistant','{}','{}','noise',?2,?3)",
                params![format!("noise-{noise_index}"), now, noise_index as i64],
            )
            .expect("insert performance event noise");
        }
        conn.execute_batch("COMMIT")
            .expect("commit performance fixture");

        let context = AgentOrgRunContext {
            members: (0..MEMBER_COUNT)
                .map(
                    |member_index| crate::coordination::agent_org_runs::AgentOrgContextMember {
                        member_id: format!("member-{member_index}"),
                        name: format!("Member {member_index}"),
                        role: "Worker".to_string(),
                        agent_id: format!("agent-{member_index}"),
                    },
                )
                .collect(),
            ..projection_context()
        };

        let sample = || {
            let started = std::time::Instant::now();
            let rows = load_context_rows(&conn, "run-projection", None, PAGE_LIMIT)
                .expect("load performance context page");
            let sources =
                load_source_rows(&conn, "run-projection", &rows).expect("load performance sources");
            let replies = load_reply_rows(&conn, &rows).expect("load performance replies");
            let mut items = Vec::with_capacity(rows.len() * 2);
            for row in &rows {
                append_context_items(
                    &context,
                    row,
                    sources.get(&row.context_id),
                    replies.get(&row.context_id),
                    &mut items,
                );
            }
            assert!(rows.len() <= PAGE_LIMIT + 1);
            assert!(rows.len() + sources.len() + replies.len() <= PAGE_LIMIT * 5);
            assert!(items.len() <= (PAGE_LIMIT + 1) * 2);
            let serialized = serde_json::to_vec(
                &items
                    .iter()
                    .take(PAGE_LIMIT)
                    .map(|item| &item.item)
                    .collect::<Vec<_>>(),
            )
            .expect("serialize performance page");
            assert!(serialized.len() <= MAX_PAGE_BYTES);
            started.elapsed()
        };

        for _ in 0..3 {
            let _ = sample();
        }
        let before_changes = conn.total_changes();
        let mut samples = (0..SAMPLE_COUNT).map(|_| sample()).collect::<Vec<_>>();
        samples.sort_unstable();
        let p90_index = ((SAMPLE_COUNT as f64 * 0.9).ceil() as usize).saturating_sub(1);
        let p90 = samples[p90_index];
        eprintln!(
            "Group projection fixture: members={MEMBER_COUNT} events={TOTAL_EVENT_COUNT} samples={SAMPLE_COUNT} p90_ms={:.3}",
            p90.as_secs_f64() * 1_000.0
        );
        assert!(
            p90 <= std::time::Duration::from_millis(200),
            "projection P90 exceeded 200 ms: {p90:?}"
        );
        assert_eq!(
            conn.total_changes(),
            before_changes,
            "performance reads must not mutate SQLite"
        );
    }
}
