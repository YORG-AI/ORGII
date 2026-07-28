//! Agent Org Group Chat history and message send.
//!
//! Group Chat is the user's durable message channel into a run. This module
//! owns the cursor-paged history surface (`agent_org_group_chat_history_page`),
//! the message-send command, and the single-transaction persistence that writes
//! an inbox row while clearing the target member's direct intervention.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, USER_SENDER_ID,
};
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::state::AgentAppState;

use super::context::session_org_read_context;
use super::lifecycle::{
    clear_active_org_cancel_flags, resume_agent_org_context, schedule_run_progress_wakes,
    wake_agent_org_member,
};
use super::run_view::{agent_org_session_run_view_impl, enrich_inbox_row, AgentOrgInboxRuntimeRow};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupChatMessageResponse {
    pub target_member_id: String,
    pub target_member_name: String,
    pub inbox_row: AgentOrgInboxRuntimeRow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupChatHistoryRow {
    pub inbox_id: i64,
    pub target_member_id: Option<String>,
    pub target_member_name: String,
    pub text: String,
    pub display_text: String,
    pub created_at: String,
    pub read_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgGroupChatHistoryPage {
    pub rows: Vec<AgentOrgGroupChatHistoryRow>,
    pub has_more: bool,
    pub next_before_id: Option<i64>,
}

const GROUP_CHAT_HISTORY_PAGE_LIMIT: usize = 100;
const GROUP_CHAT_HISTORY_PAGE_MAX_BYTES: usize = 1024 * 1024;

/// Read-only, cursor-paged source of truth for user messages sent through the
/// Agent Org Group Chat. Run View deliberately carries only previews; this
/// command is the durable reload/history surface and remains readable after a
/// run reaches a terminal state.
#[tauri::command]
pub async fn agent_org_group_chat_history_page(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    before_id: Option<i64>,
    limit: Option<usize>,
) -> Result<AgentOrgGroupChatHistoryPage, String> {
    agent_org_group_chat_history_page_impl(&state, &session_id, before_id, limit).await
}

pub async fn agent_org_group_chat_history_page_impl(
    state: &AgentAppState,
    session_id: &str,
    before_id: Option<i64>,
    limit: Option<usize>,
) -> Result<AgentOrgGroupChatHistoryPage, String> {
    if before_id.is_some_and(|id| id <= 0) {
        return Err("before_id must be a positive Inbox row id".to_string());
    }
    let Some(read_context) = session_org_read_context(state, session_id).await? else {
        return Err(format!(
            "Session {session_id} is not part of an Agent Org run"
        ));
    };
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let bounded_limit = limit
        .unwrap_or(GROUP_CHAT_HISTORY_PAGE_LIMIT)
        .clamp(1, GROUP_CHAT_HISTORY_PAGE_LIMIT);
    tokio::task::spawn_blocking(move || {
        load_group_chat_history_page(&context, before_id, bounded_limit)
    })
    .await
    .map_err(|error| format!("Agent Org Group Chat history worker failed: {error}"))?
}

pub(super) fn load_group_chat_history_page(
    context: &AgentOrgRunContext,
    before_id: Option<i64>,
    limit: usize,
) -> Result<AgentOrgGroupChatHistoryPage, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT inbox.id,
                    CASE WHEN inbox.recipient_member_id IS NULL THEN NULL
                         WHEN length(CAST(inbox.recipient_member_id AS BLOB))<=?7
                         THEN substr(inbox.recipient_member_id, 1, ?8)
                         ELSE NULL END AS recipient_member_id,
                    CASE
                      WHEN length(CAST(inbox.payload_json AS BLOB))<=?4
                       AND json_valid(inbox.payload_json)
                       AND json_extract(inbox.payload_json, '$.kind')='plain'
                       AND json_type(inbox.payload_json, '$.text')='text'
                      THEN substr(json_extract(inbox.payload_json, '$.text'), 1, ?5)
                      ELSE NULL
                    END AS message_text,
                    CASE WHEN inbox.display_text IS NOT NULL
                                   AND length(CAST(inbox.display_text AS BLOB))<=?6
                         THEN substr(inbox.display_text, 1, ?5)
                         ELSE NULL END AS display_text,
                    substr(inbox.created_at, 1, 64),
                    CASE WHEN inbox.read_at IS NULL THEN NULL ELSE substr(inbox.read_at, 1, 64) END,
                    resolution.resolution_kind
             FROM agent_inbox inbox
             LEFT JOIN agent_inbox_delivery_resolutions resolution
               ON resolution.inbox_id=inbox.id
             WHERE inbox.org_run_id=?1
               AND inbox.sender_agent_id=?2
               AND inbox.payload_kind='plain'
               AND (?3 IS NULL OR inbox.id<?3)
             ORDER BY inbox.id DESC
             LIMIT ?9",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                &context.run_id,
                USER_SENDER_ID,
                before_id,
                crate::coordination::agent_org_payload_limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
                (crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_CHARS + 1) as i64,
                crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_BYTES as i64,
                crate::coordination::agent_org_payload_limits::MESSAGE_IDENTIFIER_MAX_BYTES as i64,
                (crate::coordination::agent_org_payload_limits::MESSAGE_IDENTIFIER_MAX_CHARS + 1)
                    as i64,
                (limit + 1) as i64,
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;

    let mut newest_first = Vec::new();
    let mut serialized_bytes = 2usize;
    let mut has_more = false;
    for row in rows {
        let (
            inbox_id,
            target_member_id,
            text,
            stored_display_text,
            created_at,
            read_at,
            delivery_resolution,
        ) = row.map_err(|err| err.to_string())?;
        if newest_first.len() == limit {
            has_more = true;
            break;
        }
        let target_member_id = target_member_id.filter(|value| {
            crate::coordination::agent_org_payload_limits::validate_message_identifier(
                "group_chat_history.target_member_id",
                value,
            )
            .is_ok()
        });
        let target_member_name = target_member_id
            .as_deref()
            .and_then(|member_id| context.participant_display_name(member_id))
            .or_else(|| target_member_id.clone())
            .filter(|value| {
                crate::coordination::agent_org_payload_limits::validate_text_len(
                    "group_chat_history.target_member_name",
                    value,
                    crate::coordination::agent_org_payload_limits::MEMBER_DISPLAY_NAME_MAX_CHARS,
                    crate::coordination::agent_org_payload_limits::MEMBER_DISPLAY_NAME_MAX_BYTES,
                )
                .is_ok()
            })
            .unwrap_or_else(|| "Unknown recipient".to_string());
        let text = text
            .filter(|value| {
                crate::coordination::agent_org_payload_limits::validate_text_len(
                    "group_chat_history.text",
                    value,
                    crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_CHARS,
                    crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_BYTES,
                )
                .is_ok()
            })
            .unwrap_or_else(|| {
                format!(
                    "[Inbox row {inbox_id} contains an unreadable or oversized historical Group Chat message]"
                )
            });
        let display_text = stored_display_text.unwrap_or_else(|| {
            if target_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID) {
                text.clone()
            } else {
                format!("@{target_member_name} {text}")
            }
        });
        let history_row = AgentOrgGroupChatHistoryRow {
            inbox_id,
            target_member_id,
            target_member_name,
            text,
            display_text,
            created_at,
            read_at,
            delivery_resolution,
        };
        let row_bytes = serde_json::to_vec(&history_row)
            .map_err(|err| format!("serialize Group Chat history row failed: {err}"))?
            .len();
        let separator = usize::from(!newest_first.is_empty());
        if serialized_bytes
            .saturating_add(separator)
            .saturating_add(row_bytes)
            > GROUP_CHAT_HISTORY_PAGE_MAX_BYTES
        {
            has_more = true;
            break;
        }
        serialized_bytes = serialized_bytes
            .saturating_add(separator)
            .saturating_add(row_bytes);
        newest_first.push(history_row);
    }
    newest_first.reverse();
    let next_before_id = has_more
        .then(|| newest_first.first().map(|row| row.inbox_id))
        .flatten();
    Ok(AgentOrgGroupChatHistoryPage {
        rows: newest_first,
        has_more,
        next_before_id,
    })
}

#[tauri::command]
pub async fn agent_org_send_group_chat_message(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    target_member_id: Option<String>,
    content: String,
    display_text: Option<String>,
) -> Result<AgentOrgGroupChatMessageResponse, String> {
    agent_org_send_group_chat_message_impl_with_display(
        app_handle,
        &state,
        session_id,
        target_member_id,
        content,
        display_text,
    )
    .await
}

pub async fn agent_org_send_group_chat_message_impl(
    app_handle: tauri::AppHandle,
    state: &AgentAppState,
    session_id: String,
    target_member_id: Option<String>,
    content: String,
) -> Result<AgentOrgGroupChatMessageResponse, String> {
    agent_org_send_group_chat_message_impl_with_display(
        app_handle,
        state,
        session_id,
        target_member_id,
        content,
        None,
    )
    .await
}

async fn agent_org_send_group_chat_message_impl_with_display(
    app_handle: tauri::AppHandle,
    state: &AgentAppState,
    session_id: String,
    target_member_id: Option<String>,
    content: String,
    display_text: Option<String>,
) -> Result<AgentOrgGroupChatMessageResponse, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Agent Org group chat message content is required".to_string());
    }

    let view = agent_org_session_run_view_impl(state, &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} is not part of an Agent Org run"))?;
    let target_member_id = target_member_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(COORDINATOR_MEMBER_ID);
    let target = view
        .members
        .iter()
        .find(|candidate| candidate.member_id == target_member_id)
        .ok_or_else(|| {
            format!("Agent Org member {target_member_id} was not found for session {session_id}")
        })?;

    let durable_context = view.context.clone();
    let durable_target_agent_id = target.agent_id.clone();
    let durable_target_member_id = target.member_id.clone();
    let durable_content = content.to_string();
    let durable_display_text = display_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if let Some(display_text) = durable_display_text.as_deref() {
        crate::coordination::agent_org_payload_limits::validate_required_text(
            "display_text",
            display_text,
            crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::PLAIN_TEXT_MAX_BYTES,
        )?;
    }
    let row = tokio::task::spawn_blocking(move || {
        persist_group_chat_message(
            &durable_context,
            &durable_target_agent_id,
            &durable_target_member_id,
            &durable_content,
            durable_display_text.as_deref(),
        )
    })
    .await
    .map_err(|err| format!("Agent Org group message worker failed: {err}"))??;

    // The inbox row is already committed. Everything below is an acceleration
    // hint; reporting a post-commit wake/resume error as "message failed"
    // encourages callers to retry and duplicate the user's durable message.
    match resume_agent_org_context(&view.context, false).await {
        Ok(outcome) if outcome.transitioned => {
            if let Err(err) = clear_active_org_cancel_flags(state, &view.context).await {
                tracing::warn!(
                    run_id = %view.context.run_id,
                    error = %err,
                    "group message committed, but clearing stale cancel flags failed"
                );
            }
            schedule_run_progress_wakes(app_handle.clone(), &view.context);
        }
        Ok(outcome) if outcome.run_is_running => {
            wake_agent_org_member(app_handle, &target.member_id, &view.context.run_id);
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(
                run_id = %view.context.run_id,
                error = %err,
                "group message committed, but automatic run resume failed"
            );
            wake_agent_org_member(app_handle, &target.member_id, &view.context.run_id);
        }
    }

    let inbox_row = enrich_inbox_row(&view.context, row);

    Ok(AgentOrgGroupChatMessageResponse {
        target_member_id: target.member_id.clone(),
        target_member_name: target.name.clone(),
        inbox_row,
    })
}

/// Persist the user's Group Chat message and clear the target member's direct
/// intervention as one state transition. The Run status is re-read inside the
/// same IMMEDIATE transaction so a stale Run View can never write into a Run
/// that became terminal before submission.
pub(super) fn persist_group_chat_message(
    context: &AgentOrgRunContext,
    target_agent_id: &str,
    target_member_id: &str,
    content: &str,
    display_text: Option<&str>,
) -> Result<AgentInboxRecord, String> {
    with_sessions_writer(|| -> Result<AgentInboxRecord, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let run_status: Option<String> = tx
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id=?1",
                params![&context.run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        match run_status.as_deref() {
            Some("running" | "paused") => {}
            Some(status) => {
                return Err(format!(
                    "Agent Org run {} is {status}; terminal runs do not accept new group messages",
                    context.run_id
                ));
            }
            None => {
                return Err(format!("Agent Org run {} no longer exists", context.run_id));
            }
        }

        let row = AgentInboxStore::insert_in_tx(
            &tx,
            InsertInboxParams {
                recipient_agent_id: target_agent_id.to_string(),
                recipient_member_id: Some(target_member_id.to_string()),
                sender_agent_id: USER_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(context.run_id.clone()),
                message: AgentMessage::Plain {
                    summary: "User group chat message".to_string(),
                    text: content.to_string(),
                },
            },
        )?;
        if let Some(display_text) = display_text {
            tx.execute(
                "UPDATE agent_inbox SET display_text=?1 WHERE id=?2",
                params![display_text, row.id],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.execute(
            "UPDATE agent_member_interventions
             SET cleared_at=?3
             WHERE org_run_id=?1 AND member_id=?2 AND cleared_at IS NULL",
            params![
                &context.run_id,
                target_member_id,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(row)
    })
}
