//! Session lifecycle RPC adapters.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::Manager;

use crate::agent_sessions::event_pipeline::ingestion::types::RawActivityChunk;
use crate::agent_sessions::event_pipeline::types::{
    EventDisplayVariant, EventSource, SessionEvent,
};
use crate::agent_sessions::session_directory::aggregation::list_all_sessions;
use crate::agent_sessions::session_directory::types::{SessionCategory, SessionFilter};
use crate::api::mobile_bridge::commands::{
    current_mobile_sidebar_sessions, MobileSidebarSessionSnapshotRow,
};
use crate::api::mobile_bridge::fanout;
use crate::api::mobile_bridge::rpc::{RpcError, RpcErrorCode};

use super::external_send;

const MAX_CONCURRENT_SUBSCRIPTIONS: usize = 4;
const MAX_MOBILE_HISTORY_EVENTS: usize = 1_000;
const MAX_MOBILE_SEND_CONTENT_BYTES: usize = 64 * 1024;
const MAX_MOBILE_UPSERT_BYTES: usize = 512 * 1024;
const MAX_MOBILE_MESSAGE_TEXT_BYTES: usize = 16 * 1024;
const MAX_MOBILE_TOOL_TEXT_BYTES: usize = 2 * 1024;
const MAX_MOBILE_TOOL_SUMMARY_BYTES: usize = 512;
const MAX_MOBILE_TOOL_DATA_BYTES: usize = 12 * 1024;
const MAX_MOBILE_TOOL_DATA_STRING_BYTES: usize = 2 * 1024;
const MAX_MOBILE_TOOL_DATA_ARRAY_ITEMS: usize = 16;
const MAX_MOBILE_TOOL_DATA_OBJECT_FIELDS: usize = 32;
const MAX_MOBILE_TOOL_DATA_DEPTH: usize = 5;
const MAX_MOBILE_REMOVED_IDS: usize = 1_000;
const MAX_MOBILE_ID_BYTES: usize = 256;
const MAX_MOBILE_ROUND_ID_BYTES: usize = 1_024;
const MAX_MOBILE_ROUNDS: usize = 500;
const MAX_MOBILE_ROUNDS_BYTES: usize = 192 * 1024;
const MAX_MOBILE_ROUND_PREVIEW_BYTES: usize = 512;
const MAX_MOBILE_REMOVED_ID_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSendParams {
    pub session_id: String,
    pub content: String,
    pub turn_intent_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCancelParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRoundParams {
    pub session_id: String,
    pub round_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileRoundSummary {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_intent_id: Option<String>,
    next_round_id: Option<String>,
    started_at: String,
    ended_at: Option<String>,
    duration_ms: Option<i64>,
    user_preview: String,
    event_count: i64,
    body_event_count: i64,
    status: String,
}

struct MobileHistoryWindow {
    rounds: Vec<MobileRoundSummary>,
    rounds_complete: bool,
    latest_round_id: Option<String>,
    events: Vec<SessionEvent>,
    events_truncated: bool,
}

struct LoadedMobileEvents {
    events: Vec<SessionEvent>,
    truncated: bool,
}

struct MobileUpsertBudget {
    upserts: Vec<Value>,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MobileSessionExecution {
    ManagedCli,
    ImportedHistory,
    NativeAgent,
}

/// Select the same execution owner that the desktop chat adapter uses.
///
/// Managed `cliagent-*` sessions live in `code_sessions` and must be resumed
/// through `cli_agent_message`; they intentionally have no `agent_sessions`
/// row. Imported provider history has its own continuation bridge, while the
/// remaining native sessions are owned by agent-core.
fn mobile_session_execution(session_id: &str) -> MobileSessionExecution {
    if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
        MobileSessionExecution::ManagedCli
    } else if orgtrack_core::sources::imported_history::is_imported_history_session_id(session_id) {
        MobileSessionExecution::ImportedHistory
    } else {
        MobileSessionExecution::NativeAgent
    }
}

fn managed_cli_mobile_message_request(
    parsed: SessionSendParams,
    turn_intent_id: String,
) -> crate::agent_sessions::cli::commands::CliMessageRequest {
    crate::agent_sessions::cli::commands::CliMessageRequest {
        session_id: parsed.session_id,
        content: parsed.content,
        model: parsed.model,
        // This stable identity is shared by RPC retries and the EventStore row.
        client_message_id: Some(format!("mobile-{turn_intent_id}")),
        turn_intent_id: Some(turn_intent_id),
        // Unlike the desktop composer, Mobile Remote has no local EventStore
        // placeholder in the desktop process. The accepted turn must create
        // its authoritative user row before the CLI can emit a response.
        materialize_user_message_event: true,
        ..Default::default()
    }
}

/// Map aggregate session status to the mobile wire shape (`running` | `idle`).
pub fn map_session_status_to_mobile(status: &str) -> &'static str {
    match status {
        "running" | "pending" | "waiting_for_user" | "waiting_for_funds" | "paused" => "running",
        _ => "idle",
    }
}

/// Resolve the canonical UI label carried over the mobile wire.
///
/// `name` is raw provider provenance and can contain an imported prompt
/// envelope. The session directory owns the human-readable projection in
/// `display_label`; mobile must not bypass it.
pub fn mobile_session_name(name: &str, display_label: Option<&str>) -> String {
    display_label
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(name)
        .to_string()
}

fn is_mobile_list_category(category: SessionCategory) -> bool {
    matches!(
        category,
        SessionCategory::Agent | SessionCategory::Os | SessionCategory::Cli
    )
}

fn session_list_from_sidebar_snapshot(
    snapshot: Vec<MobileSidebarSessionSnapshotRow>,
    status_filter: &str,
    limit: usize,
    writable_codex_session_ids: &HashSet<String>,
) -> Value {
    let sessions = snapshot
        .into_iter()
        .filter(|session| status_filter != "running" || session.status == "running")
        .take(limit)
        .map(|session| {
            let send_capability =
                external_send::mobile_send_capability(&session.id, writable_codex_session_ids);
            json!({
                "id": session.id,
                "name": session.name,
                "status": session.status,
                "category": "live",
                "sendCapability": send_capability,
            })
        })
        .collect::<Vec<_>>();

    json!({ "sessions": sessions, "source": "desktop_sidebar" })
}

/// Validate `session/send` params without touching desktop state.
pub fn parse_session_send_params(params: &Value) -> Result<SessionSendParams, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?
        .to_string();

    let content = params
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| RpcError::invalid_params("content is required"))?
        .to_string();
    if content.trim().is_empty() {
        return Err(RpcError::invalid_params("content must not be empty"));
    }
    if content.len() > MAX_MOBILE_SEND_CONTENT_BYTES {
        return Err(RpcError::invalid_params("content is too large"));
    }

    let turn_intent_id = params
        .get("turnIntentId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let model = params
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Ok(SessionSendParams {
        session_id,
        content,
        turn_intent_id,
        model,
    })
}

/// Validate `session/cancel` params without touching desktop state.
pub fn parse_session_cancel_params(params: &Value) -> Result<SessionCancelParams, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?
        .to_string();

    Ok(SessionCancelParams { session_id })
}

/// Validate `session/round` params without reading provider state.
pub fn parse_session_round_params(params: &Value) -> Result<SessionRoundParams, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?
        .to_string();
    let round_id = params
        .get("roundId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("roundId is required"))?;
    if round_id.len() > MAX_MOBILE_ROUND_ID_BYTES {
        return Err(RpcError::invalid_params("roundId is too long"));
    }

    Ok(SessionRoundParams {
        session_id,
        round_id: round_id.to_string(),
    })
}

/// List sessions from the cross-backend directory, mapped to the mobile wire shape.
pub async fn session_list(params: &Value) -> Result<Value, RpcError> {
    let limit = params
        .get("limit")
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .unwrap_or(50)
        .clamp(1, 200);

    let status_filter = params
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("all");
    if status_filter != "all" && status_filter != "running" {
        return Err(RpcError::invalid_params(
            "status must be \"all\" or \"running\"",
        ));
    }

    if let Some(snapshot) = current_mobile_sidebar_sessions()
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?
    {
        let candidate_ids = snapshot
            .iter()
            .filter(|session| status_filter != "running" || session.status == "running")
            .take(limit)
            .filter(|session| {
                session
                    .id
                    .starts_with(orgtrack_core::sources::codex::SESSION_PREFIX)
            })
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let writable_codex_session_ids =
            crate::orgtrack::history_commands::external_history_mobile_writable_codex_session_ids(
                candidate_ids,
            )
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        return Ok(session_list_from_sidebar_snapshot(
            snapshot,
            status_filter,
            limit,
            &writable_codex_session_ids,
        ));
    }

    let filter = SessionFilter {
        limit: Some(limit),
        ..Default::default()
    };

    let response = tokio::task::spawn_blocking(move || list_all_sessions(Some(&filter)))
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, format!("task join: {err}")))?
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;

    let session_rows = response
        .sessions
        .into_iter()
        .filter(|record| is_mobile_list_category(record.category))
        .filter_map(|record| {
            let mobile_status = map_session_status_to_mobile(&record.status);
            if status_filter == "running" && mobile_status != "running" {
                return None;
            }
            let mobile_name = mobile_session_name(&record.name, record.display_label.as_deref());
            Some((record.session_id, mobile_name, mobile_status))
        })
        .take(limit)
        .collect::<Vec<_>>();

    let writable_codex_session_ids =
        crate::orgtrack::history_commands::external_history_mobile_writable_codex_session_ids(
            session_rows
                .iter()
                .filter(|(id, _, _)| id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX))
                .map(|(id, _, _)| id.clone())
                .collect(),
        )
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
    let sessions = session_rows
        .into_iter()
        .map(|(session_id, mobile_name, mobile_status)| {
            let send_capability =
                external_send::mobile_send_capability(&session_id, &writable_codex_session_ids);
            json!({
                "id": session_id,
                "name": mobile_name,
                "status": mobile_status,
                "sendCapability": send_capability,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({ "sessions": sessions }))
}

/// Submit a user message from mobile — enqueues a turn and returns immediately.
pub async fn session_send(params: &Value) -> Result<Value, RpcError> {
    let parsed = parse_session_send_params(params)?;

    let turn_intent_id = parsed
        .turn_intent_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    match mobile_session_execution(&parsed.session_id) {
        MobileSessionExecution::ManagedCli => {
            let receipt = crate::agent_sessions::cli::commands::cli_agent_message(
                managed_cli_mobile_message_request(parsed, turn_intent_id),
            )
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;

            Ok(json!({
                "accepted": true,
                "execution": "managed_cli",
                "turnIntentId": receipt.turn_intent_id,
                "sessionId": receipt.session_id,
            }))
        }
        MobileSessionExecution::ImportedHistory => external_send::try_send_imported_session(
            &parsed.session_id,
            &parsed.content,
            &turn_intent_id,
        )
        .await?
        .ok_or_else(|| {
            RpcError::new(
                RpcErrorCode::InvalidRequest,
                "imported conversation execution route was not available",
            )
        }),
        MobileSessionExecution::NativeAgent => {
            let handle = crate::api::get_app_handle().ok_or_else(|| {
                RpcError::new(RpcErrorCode::InvalidRequest, "desktop agent not ready")
            })?;
            let state = handle.state::<agent_core::state::AgentAppState>();
            agent_core::state::commands::session::message::send_message_impl_for_mobile_remote(
                state.inner(),
                parsed.session_id.clone(),
                parsed.content,
                Some(turn_intent_id.clone()),
                parsed.model,
            )
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;

            Ok(json!({
                "accepted": true,
                "execution": "native_agent",
                "turnIntentId": turn_intent_id,
                "sessionId": parsed.session_id,
            }))
        }
    }
}

/// Cancel the active turn for a session (maps to `agent_session_cancel` / UserStop).
pub async fn session_cancel(params: &Value) -> Result<Value, RpcError> {
    use agent_core::state::control_flow::CancelReason;

    let parsed = parse_session_cancel_params(params)?;

    let cancelled = match mobile_session_execution(&parsed.session_id) {
        MobileSessionExecution::ManagedCli => {
            crate::agent_sessions::cli::commands::cli_agent_cancel(
                parsed.session_id.clone(),
                Some(CancelReason::UserStop),
            )
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?
        }
        MobileSessionExecution::ImportedHistory => {
            external_send::cancel_imported_session(&parsed.session_id)
        }
        MobileSessionExecution::NativeAgent => {
            let handle = crate::api::get_app_handle().ok_or_else(|| {
                RpcError::new(RpcErrorCode::InvalidRequest, "desktop agent not ready")
            })?;
            let state = handle.state::<agent_core::state::AgentAppState>();
            state
                .cancel_session(&parsed.session_id, CancelReason::UserStop)
                .await
        }
    };
    if !cancelled {
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            format!("session is not running: {}", parsed.session_id),
        ));
    }

    Ok(json!({
        "cancelled": true,
        "sessionId": parsed.session_id,
    }))
}

fn activity_chunk_is_user(chunk: &core_types::activity::ActivityChunk) -> bool {
    matches!(chunk.function.as_str(), "user" | "user_message")
        || chunk.result.get("type").and_then(Value::as_str) == Some("user")
        || chunk
            .result
            .pointer("/message/role")
            .and_then(Value::as_str)
            == Some("user")
}

fn chunks_to_raw(
    chunks: Vec<core_types::activity::ActivityChunk>,
    requested_session_id: &str,
) -> (Vec<RawActivityChunk>, bool) {
    let truncated = chunks.len() > MAX_MOBILE_HISTORY_EVENTS;
    let first_user_index = chunks.iter().position(activity_chunk_is_user);
    let tail_start = chunks.len().saturating_sub(MAX_MOBILE_HISTORY_EVENTS);
    let keep_first_user = first_user_index.is_some_and(|index| index < tail_start);
    let tail_start = if keep_first_user {
        chunks
            .len()
            .saturating_sub(MAX_MOBILE_HISTORY_EVENTS.saturating_sub(1))
    } else {
        tail_start
    };
    let selected = chunks
        .into_iter()
        .enumerate()
        .filter(|(index, _)| {
            keep_first_user && Some(*index) == first_user_index || *index >= tail_start
        })
        .map(|(_, chunk)| RawActivityChunk {
            chunk_id: Some(chunk.chunk_id),
            session_id: Some(requested_session_id.to_string()),
            action_type: Some(chunk.action_type),
            function: Some(chunk.function),
            args: Some(chunk.args),
            result: Some(chunk.result),
            created_at: Some(chunk.created_at),
            thread_id: chunk.thread_id,
            process_id: chunk.process_id,
            call_id: None,
        })
        .collect();
    (selected, truncated)
}

async fn events_from_chunks(
    chunks: Vec<core_types::activity::ActivityChunk>,
    requested_session_id: String,
) -> Result<LoadedMobileEvents, RpcError> {
    tokio::task::spawn_blocking(move || {
        let (raw, truncated) = chunks_to_raw(chunks, &requested_session_id);
        LoadedMobileEvents {
            events: crate::agent_sessions::event_pipeline::ingestion::ingest_raw_chunks(
                &raw,
                &requested_session_id,
            )
            .events,
            truncated,
        }
    })
    .await
    .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, format!("task join: {err}")))
}

fn projected_round_duration_ms(started_at: &str, ended_at: Option<&str>) -> Option<i64> {
    let started_at = chrono::DateTime::parse_from_rfc3339(started_at).ok()?;
    let ended_at = chrono::DateTime::parse_from_rfc3339(ended_at?).ok()?;
    Some(
        ended_at
            .signed_duration_since(started_at)
            .num_milliseconds()
            .max(0),
    )
}

fn mobile_rounds_from_projected(
    turns: &[orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata],
) -> Vec<MobileRoundSummary> {
    turns
        .iter()
        .enumerate()
        .map(|(index, turn)| MobileRoundSummary {
            id: turn.turn_id.clone(),
            turn_intent_id: None,
            next_round_id: turns.get(index + 1).map(|next| next.turn_id.clone()),
            started_at: turn.started_at.clone(),
            ended_at: turn.ended_at.clone(),
            duration_ms: projected_round_duration_ms(&turn.started_at, turn.ended_at.as_deref()),
            user_preview: turn.user_preview.clone(),
            event_count: turn.event_count,
            body_event_count: turn.body_event_count,
            status: turn.status.clone(),
        })
        .collect()
}

fn mobile_rounds_from_cursor(
    turns: &[orgtrack_core::sources::cursor_ide::history::CursorIdeTurnSummary],
) -> Vec<MobileRoundSummary> {
    turns
        .iter()
        .map(|turn| MobileRoundSummary {
            id: turn.turn_id.clone(),
            turn_intent_id: None,
            next_round_id: turn.next_turn_id.clone(),
            started_at: turn.started_at.clone(),
            ended_at: turn.ended_at.clone(),
            duration_ms: turn.duration_ms,
            user_preview: turn.user_preview.clone(),
            event_count: i64::try_from(turn.event_count).unwrap_or(i64::MAX),
            body_event_count: i64::try_from(turn.body_event_count).unwrap_or(i64::MAX),
            status: "completed".to_string(),
        })
        .collect()
}

fn mobile_rounds_from_cached(
    turns: &[session_persistence::CachedTurnSummary],
) -> Vec<MobileRoundSummary> {
    turns
        .iter()
        .map(|turn| MobileRoundSummary {
            id: turn.turn_id.clone(),
            turn_intent_id: turn.turn_intent_id.clone(),
            next_round_id: turn.next_turn_id.clone(),
            started_at: turn.started_at.clone(),
            ended_at: turn.ended_at.clone(),
            duration_ms: turn.duration_ms,
            user_preview: turn.user_preview.clone(),
            event_count: turn.event_count,
            body_event_count: turn.body_event_count,
            status: turn.status.clone(),
        })
        .collect()
}

fn truncate_mobile_preview(value: &str) -> (String, bool) {
    if value.len() <= MAX_MOBILE_ROUND_PREVIEW_BYTES {
        return (value.to_string(), false);
    }
    const ELLIPSIS: &str = "…";
    let mut end = MAX_MOBILE_ROUND_PREVIEW_BYTES.saturating_sub(ELLIPSIS.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}{}", &value[..end], ELLIPSIS), true)
}

/// Keep the newest round directory entries within a fixed count and byte
/// budget so `session/subscribe` stays below the Relay's 1 MiB frame limit.
fn bounded_mobile_rounds(mut rounds: Vec<MobileRoundSummary>) -> (Vec<MobileRoundSummary>, bool) {
    let mut complete = true;
    for round in &mut rounds {
        let (preview, _) = truncate_mobile_preview(&round.user_preview);
        round.user_preview = preview;
        // Preview truncation does not make the directory incomplete: the
        // round identity and exact-body route remain available.
    }

    let mut used_bytes = 2usize;
    let mut newest_first = Vec::new();
    for round in rounds.into_iter().rev() {
        if newest_first.len() >= MAX_MOBILE_ROUNDS {
            complete = false;
            break;
        }
        let round_bytes = serde_json::to_vec(&round)
            .map(|bytes| bytes.len().saturating_add(1))
            .unwrap_or(MAX_MOBILE_ROUNDS_BYTES.saturating_add(1));
        if used_bytes.saturating_add(round_bytes) > MAX_MOBILE_ROUNDS_BYTES {
            complete = false;
            break;
        }
        used_bytes = used_bytes.saturating_add(round_bytes);
        newest_first.push(round);
    }
    newest_first.reverse();
    (newest_first, complete)
}

fn latest_round_chunks(
    mut chunks: Vec<core_types::activity::ActivityChunk>,
    latest_round_id: Option<&str>,
) -> Vec<core_types::activity::ActivityChunk> {
    let Some(round_id) = latest_round_id else {
        return chunks;
    };
    let cursor_user_id = format!("cursoride-user-{round_id}");
    let Some(start) = chunks
        .iter()
        .rposition(|chunk| chunk.chunk_id == round_id || chunk.chunk_id == cursor_user_id)
    else {
        return Vec::new();
    };
    chunks.split_off(start)
}

fn latest_round_events(
    mut events: Vec<SessionEvent>,
    latest_turn: Option<&session_persistence::CachedTurnSummary>,
) -> Vec<SessionEvent> {
    let Some(turn) = latest_turn else {
        return events;
    };
    let Some(start) = events.iter().rposition(|event| {
        event.id == turn.turn_id
            || turn
                .user_event_ids
                .iter()
                .any(|user_event_id| user_event_id == &event.id)
    }) else {
        return Vec::new();
    };
    events.split_off(start)
}

fn exact_codex_round_chunks(
    mut chunks: Vec<core_types::activity::ActivityChunk>,
    loaded_event_count: usize,
) -> Vec<core_types::activity::ActivityChunk> {
    let start = chunks.len().saturating_sub(loaded_event_count);
    chunks.split_off(start)
}

fn mobile_history_session_id(requested_session_id: &str) -> String {
    crate::agent_sessions::cli::native_transcript::imported_transcript_id_for_managed_session(
        requested_session_id,
    )
    .unwrap_or_else(|| requested_session_id.to_string())
}

async fn load_mobile_initial_history(
    requested_session_id: &str,
) -> Result<MobileHistoryWindow, RpcError> {
    let history_session_id = mobile_history_session_id(requested_session_id);
    if history_session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX) {
        let window =
            crate::orgtrack::history_commands::codex_app_initial_window(history_session_id)
                .await
                .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        let all_rounds = mobile_rounds_from_projected(&window.turns);
        let latest_round_id = all_rounds.last().map(|round| round.id.clone());
        let chunks = latest_round_chunks(window.chunks, latest_round_id.as_deref());
        let loaded = events_from_chunks(chunks, requested_session_id.to_string()).await?;
        let (rounds, rounds_complete) = bounded_mobile_rounds(all_rounds);
        return Ok(MobileHistoryWindow {
            rounds,
            rounds_complete,
            latest_round_id,
            events: loaded.events,
            events_truncated: loaded.truncated,
        });
    }

    if history_session_id.starts_with(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX)
    {
        let initial = crate::orgtrack::history_commands::cursor_ide_initial_window(
            history_session_id.clone(),
            Some(100),
        )
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        let all_rounds = mobile_rounds_from_cursor(&initial.turns);
        let latest_round_id = all_rounds.last().map(|round| round.id.clone());
        let chunks = if let Some(round_id) = latest_round_id.as_deref() {
            let exact = crate::orgtrack::history_commands::cursor_ide_turn_window(
                history_session_id,
                round_id.to_string(),
            )
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
            if exact.chunks.is_empty() {
                latest_round_chunks(initial.chunks, Some(round_id))
            } else {
                exact.chunks
            }
        } else {
            initial.chunks
        };
        let loaded = events_from_chunks(chunks, requested_session_id.to_string()).await?;
        let (rounds, rounds_complete) = bounded_mobile_rounds(all_rounds);
        return Ok(MobileHistoryWindow {
            rounds,
            rounds_complete,
            latest_round_id,
            events: loaded.events,
            events_truncated: loaded.truncated,
        });
    }

    if orgtrack_core::sources::imported_history::is_imported_history_session_id(&history_session_id)
    {
        let window = crate::orgtrack::history_commands::imported_history_initial_window(
            history_session_id,
            Some(1),
        )
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        let all_rounds = mobile_rounds_from_projected(&window.turns);
        let latest_round_id = all_rounds.last().map(|round| round.id.clone());
        let chunks = latest_round_chunks(window.chunks, latest_round_id.as_deref());
        let loaded = events_from_chunks(chunks, requested_session_id.to_string()).await?;
        let (rounds, rounds_complete) = bounded_mobile_rounds(all_rounds);
        return Ok(MobileHistoryWindow {
            rounds,
            rounds_complete,
            latest_round_id,
            events: loaded.events,
            events_truncated: loaded.truncated,
        });
    }

    let window = crate::agent_sessions::event_pipeline::commands::load_initial_turn_window_events(
        requested_session_id,
        Some(1),
    )
    .await
    .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
    let events = latest_round_events(window.events, window.turns.last());
    let all_rounds = mobile_rounds_from_cached(&window.turns);
    let latest_round_id = all_rounds.last().map(|round| round.id.clone());
    let (rounds, rounds_complete) = bounded_mobile_rounds(all_rounds);
    Ok(MobileHistoryWindow {
        rounds,
        rounds_complete,
        latest_round_id,
        events,
        events_truncated: false,
    })
}

async fn load_mobile_round_events(
    requested_session_id: &str,
    round_id: &str,
) -> Result<LoadedMobileEvents, RpcError> {
    let history_session_id = mobile_history_session_id(requested_session_id);
    if history_session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX) {
        let window = crate::orgtrack::history_commands::codex_app_turn_window(
            history_session_id,
            round_id.to_string(),
        )
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        let chunks = exact_codex_round_chunks(window.chunks, window.loaded_event_count);
        return events_from_chunks(chunks, requested_session_id.to_string()).await;
    }

    if history_session_id.starts_with(orgtrack_core::sources::cursor_ide::CURSORIDE_SESSION_PREFIX)
    {
        let window = crate::orgtrack::history_commands::cursor_ide_turn_window(
            history_session_id,
            round_id.to_string(),
        )
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        return events_from_chunks(window.chunks, requested_session_id.to_string()).await;
    }

    if orgtrack_core::sources::imported_history::is_imported_history_session_id(&history_session_id)
    {
        let mut windows = crate::orgtrack::history_commands::imported_history_turn_windows(
            history_session_id,
            vec![round_id.to_string()],
        )
        .await
        .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        let chunks = windows
            .pop()
            .filter(|window| window.turn_id == round_id)
            .map(|window| window.chunks)
            .unwrap_or_default();
        return events_from_chunks(chunks, requested_session_id.to_string()).await;
    }

    crate::agent_sessions::event_pipeline::commands::cache_load_session_turn_body(
        requested_session_id.to_string(),
        round_id.to_string(),
    )
    .await
    .map(|window| LoadedMobileEvents {
        events: window.events,
        truncated: false,
    })
    .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))
}

fn require_mobile_round_events(
    session_id: &str,
    round_id: &str,
    loaded: LoadedMobileEvents,
) -> Result<LoadedMobileEvents, RpcError> {
    if loaded.events.is_empty() {
        return Err(RpcError::new(
            RpcErrorCode::SessionNotFound,
            format!("round was not found for session: {session_id}/{round_id}"),
        ));
    }
    Ok(loaded)
}

/// Reload one authoritative round for event-scoped follow-up actions.
///
/// Callers must resolve targets from these events instead of trusting the
/// compact, potentially truncated projection returned to the mobile browser.
pub(super) async fn authoritative_round_events(
    session_id: &str,
    round_id: &str,
) -> Result<Vec<SessionEvent>, RpcError> {
    let loaded = require_mobile_round_events(
        session_id,
        round_id,
        load_mobile_round_events(session_id, round_id).await?,
    )?;
    Ok(loaded.events)
}

fn truncate_mobile_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &value[..end])
}

const MOBILE_TOOL_FIELD_PRIORITY: &[&str] = &[
    "kind",
    "filePath",
    "fileName",
    "command",
    "action",
    "query",
    "pattern",
    "directory",
    "description",
    "handle",
    "cwd",
    "exitCode",
    "isFailure",
    "shellProcessStatus",
    "lineCount",
    "startLine",
    "linesAdded",
    "linesRemoved",
    "totalMatches",
    "totalFiles",
    "total",
    "status",
    "success",
    "outcome",
    "errorMessage",
    "resultSummary",
    "output",
    "streamOutput",
    "content",
    "diff",
    "files",
    "results",
    "entries",
    "todos",
    "tasks",
];

fn is_sensitive_mobile_tool_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "cookie"
            | "setcookie"
            | "xapikey"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "password"
            | "secret"
            | "privatekey"
    )
}

#[derive(Clone, Copy)]
struct MobileToolDataLimits {
    max_depth: usize,
    max_fields: usize,
    max_items: usize,
    max_string_bytes: usize,
}

fn compact_mobile_tool_json(
    value: &Value,
    depth: usize,
    limits: MobileToolDataLimits,
    truncated: &mut bool,
) -> Value {
    if depth >= limits.max_depth {
        if value.is_array() || value.is_object() {
            *truncated = true;
            return Value::String("…".to_string());
        }
    }

    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => {
            let compact = truncate_mobile_text(text, limits.max_string_bytes);
            if compact != *text {
                *truncated = true;
            }
            Value::String(compact)
        }
        Value::Array(items) => {
            if items.len() > limits.max_items {
                *truncated = true;
            }
            Value::Array(
                items
                    .iter()
                    .take(limits.max_items)
                    .map(|item| compact_mobile_tool_json(item, depth + 1, limits, truncated))
                    .collect(),
            )
        }
        Value::Object(object) => {
            let mut ordered_keys = Vec::with_capacity(object.len());
            for preferred in MOBILE_TOOL_FIELD_PRIORITY {
                if object.contains_key(*preferred) {
                    ordered_keys.push(*preferred);
                }
            }
            for key in object.keys() {
                if !ordered_keys
                    .iter()
                    .any(|candidate| *candidate == key.as_str())
                {
                    ordered_keys.push(key.as_str());
                }
            }

            let mut compact = Map::new();
            for key in ordered_keys {
                if compact.len() >= limits.max_fields {
                    *truncated = true;
                    break;
                }
                if is_sensitive_mobile_tool_key(key) {
                    compact.insert(key.to_string(), Value::String("[redacted]".to_string()));
                    *truncated = true;
                    continue;
                }
                if let Some(field) = object.get(key) {
                    compact.insert(
                        key.to_string(),
                        compact_mobile_tool_json(field, depth + 1, limits, truncated),
                    );
                }
            }
            Value::Object(compact)
        }
    }
}

fn mobile_tool_data(value: &Value) -> (Value, bool) {
    let mut truncated = false;
    let regular_limits = MobileToolDataLimits {
        max_depth: MAX_MOBILE_TOOL_DATA_DEPTH,
        max_fields: MAX_MOBILE_TOOL_DATA_OBJECT_FIELDS,
        max_items: MAX_MOBILE_TOOL_DATA_ARRAY_ITEMS,
        max_string_bytes: MAX_MOBILE_TOOL_DATA_STRING_BYTES,
    };
    let mut compact = compact_mobile_tool_json(value, 0, regular_limits, &mut truncated);
    let mut encoded_bytes = serde_json::to_vec(&compact)
        .map(|encoded| encoded.len())
        .unwrap_or(usize::MAX);

    if encoded_bytes > MAX_MOBILE_TOOL_DATA_BYTES {
        truncated = true;
        let fallback_limits = MobileToolDataLimits {
            max_depth: 3,
            max_fields: 12,
            max_items: 4,
            max_string_bytes: 512,
        };
        compact = compact_mobile_tool_json(value, 0, fallback_limits, &mut truncated);
        encoded_bytes = serde_json::to_vec(&compact)
            .map(|encoded| encoded.len())
            .unwrap_or(usize::MAX);
    }

    if encoded_bytes > MAX_MOBILE_TOOL_DATA_BYTES {
        truncated = true;
        compact = json!({
            "kind": value.get("kind").and_then(Value::as_str).unwrap_or("unknown"),
        });
    }

    (compact, truncated)
}

fn mobile_tool_summary(
    file_path: Option<&str>,
    command: Option<&str>,
    extracted: Option<&Value>,
    args: Option<&Value>,
    display_text: &str,
    function_name: &str,
) -> String {
    let direct = file_path
        .filter(|value| !value.trim().is_empty())
        .or_else(|| command.filter(|value| !value.trim().is_empty()));
    if let Some(value) = direct {
        return truncate_mobile_text(value.trim(), MAX_MOBILE_TOOL_SUMMARY_BYTES);
    }

    const SUMMARY_KEYS: &[&str] = &[
        "filePath",
        "file_path",
        "path",
        "command",
        "cmd",
        "query",
        "pattern",
        "globPattern",
        "glob_pattern",
        "directory",
        "targetDirectory",
        "target_directory",
        "url",
        "uri",
        "targetUrl",
        "description",
        "name",
        "title",
        "action",
        "handle",
    ];
    for object in [extracted, args]
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
    {
        for key in SUMMARY_KEYS {
            if let Some(value) = object
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return truncate_mobile_text(value, MAX_MOBILE_TOOL_SUMMARY_BYTES);
            }
        }
    }

    let display_text = display_text.trim();
    if !display_text.is_empty() && !display_text.eq_ignore_ascii_case(function_name) {
        return truncate_mobile_text(display_text, MAX_MOBILE_TOOL_SUMMARY_BYTES);
    }
    String::new()
}

fn attach_mobile_tool_projection(
    mobile_event: &mut Value,
    file_path: Option<&str>,
    command: Option<&str>,
    call_id: Option<&str>,
    extracted: Option<&Value>,
    args: Option<&Value>,
    display_text: &str,
    function_name: &str,
) -> bool {
    let fallback = json!({ "kind": "unknown" });
    let (tool_data, tool_data_truncated) = mobile_tool_data(extracted.unwrap_or(&fallback));
    mobile_event["toolData"] = tool_data;
    mobile_event["toolDataTruncated"] = Value::Bool(tool_data_truncated);

    let summary = mobile_tool_summary(
        file_path,
        command,
        extracted,
        args,
        display_text,
        function_name,
    );
    if !summary.is_empty() {
        mobile_event["toolSummary"] = Value::String(summary);
    }
    if let Some(file_path) = file_path.filter(|value| !value.is_empty()) {
        mobile_event["filePath"] = Value::String(truncate_mobile_text(
            file_path,
            MAX_MOBILE_TOOL_SUMMARY_BYTES,
        ));
    }
    if let Some(command) = command.filter(|value| !value.is_empty()) {
        mobile_event["command"] =
            Value::String(truncate_mobile_text(command, MAX_MOBILE_TOOL_SUMMARY_BYTES));
    }
    if let Some(call_id) = call_id.filter(|value| !value.is_empty()) {
        mobile_event["callId"] = Value::String(truncate_mobile_text(call_id, MAX_MOBILE_ID_BYTES));
    }
    tool_data_truncated
}

fn mobile_event_kind(
    source: &str,
    canonical: &str,
    action_type: &str,
    display_variant: &str,
) -> Option<&'static str> {
    if source.eq_ignore_ascii_case("user")
        || canonical.eq_ignore_ascii_case("user")
        || canonical.eq_ignore_ascii_case("user_message")
    {
        return Some("user");
    }
    if (source.eq_ignore_ascii_case("assistant") && display_variant.eq_ignore_ascii_case("message"))
        || canonical.eq_ignore_ascii_case("agent")
        || canonical.eq_ignore_ascii_case("assistant")
        || canonical.eq_ignore_ascii_case("agent_message")
        || canonical.eq_ignore_ascii_case("assistant_message")
    {
        return Some("agent");
    }
    if display_variant.eq_ignore_ascii_case("tool_call")
        || action_type.eq_ignore_ascii_case("tool_call")
        || canonical.to_ascii_lowercase().starts_with("tool_")
    {
        return Some("tool");
    }
    None
}

fn mobile_event_from_session(event: &SessionEvent) -> Option<(Value, bool)> {
    let kind = if event.source == EventSource::User {
        Some("user")
    } else if event.source == EventSource::Assistant
        && event.display_variant == EventDisplayVariant::Message
    {
        Some("agent")
    } else if event.display_variant == EventDisplayVariant::ToolCall
        || event.action_type == "tool_call"
    {
        Some("tool")
    } else {
        mobile_event_kind(
            &serde_json::to_value(&event.source)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default(),
            &event.ui_canonical,
            &event.action_type,
            &serde_json::to_value(&event.display_variant)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default(),
        )
    }?;
    let max_text_bytes = if kind == "tool" {
        MAX_MOBILE_TOOL_TEXT_BYTES
    } else {
        MAX_MOBILE_MESSAGE_TEXT_BYTES
    };

    let mut mobile_event = json!({
        "id": event.id,
        "uiCanonical": event.ui_canonical,
        "functionName": event.function_name,
        "actionType": event.action_type,
        "source": event.source,
        "displayVariant": event.display_variant,
        "displayStatus": event.display_status,
        "displayText": truncate_mobile_text(&event.display_text, max_text_bytes),
        "createdAt": event.created_at,
    });
    let extracted = event
        .extracted
        .as_ref()
        .and_then(|value| serde_json::to_value(value).ok());
    let tool_data_truncated = if kind == "tool" {
        attach_mobile_tool_projection(
            &mut mobile_event,
            event.file_path.as_deref(),
            event.command.as_deref(),
            event.call_id.as_deref(),
            extracted.as_ref(),
            Some(&event.args),
            &event.display_text,
            &event.function_name,
        )
    } else {
        false
    };
    if let Some(turn_intent_id) = event
        .result
        .get("turnIntentId")
        .or_else(|| event.result.get("turn_intent_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        mobile_event["turnIntentId"] = Value::String(turn_intent_id.to_string());
    }
    Some((mobile_event, tool_data_truncated))
}

fn wire_string<'a>(event: &'a Value, camel: &str, snake: &str) -> &'a str {
    event
        .get(camel)
        .or_else(|| event.get(snake))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn mobile_event_from_wire(event: &Value) -> Option<(Value, bool)> {
    let source = wire_string(event, "source", "source");
    let canonical = wire_string(event, "uiCanonical", "ui_canonical");
    let action_type = wire_string(event, "actionType", "action_type");
    let display_variant = wire_string(event, "displayVariant", "display_variant");
    let kind = mobile_event_kind(source, canonical, action_type, display_variant)?;
    let max_text_bytes = if kind == "tool" {
        MAX_MOBILE_TOOL_TEXT_BYTES
    } else {
        MAX_MOBILE_MESSAGE_TEXT_BYTES
    };

    let mut mobile_event = json!({
        "id": truncate_mobile_text(wire_string(event, "id", "id"), MAX_MOBILE_ID_BYTES),
        "uiCanonical": canonical,
        "functionName": wire_string(event, "functionName", "function_name"),
        "actionType": action_type,
        "source": source,
        "displayVariant": display_variant,
        "displayStatus": wire_string(event, "displayStatus", "display_status"),
        "displayText": truncate_mobile_text(
            wire_string(event, "displayText", "display_text"),
            max_text_bytes,
        ),
        "createdAt": wire_string(event, "createdAt", "created_at"),
    });
    let tool_data_truncated = if kind == "tool" {
        attach_mobile_tool_projection(
            &mut mobile_event,
            Some(wire_string(event, "filePath", "file_path")),
            Some(wire_string(event, "command", "command")),
            Some(wire_string(event, "callId", "call_id")),
            event.get("extracted"),
            event.get("args"),
            wire_string(event, "displayText", "display_text"),
            wire_string(event, "functionName", "function_name"),
        )
    } else {
        false
    };
    let turn_intent_id = wire_string(event, "turnIntentId", "turn_intent_id");
    let turn_intent_id = if turn_intent_id.is_empty() {
        event
            .get("result")
            .and_then(Value::as_object)
            .and_then(|result| {
                result
                    .get("turnIntentId")
                    .or_else(|| result.get("turn_intent_id"))
            })
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        turn_intent_id
    };
    if !turn_intent_id.is_empty() {
        mobile_event["turnIntentId"] = Value::String(turn_intent_id.to_string());
    }
    Some((mobile_event, tool_data_truncated))
}

fn budget_mobile_upserts<I>(events: I) -> MobileUpsertBudget
where
    I: Iterator<Item = (Value, bool)>,
{
    let events = events.collect::<Vec<_>>();
    let first_user_index = events.iter().position(|(event, _)| {
        event.get("source").and_then(Value::as_str) == Some("user")
            || event.get("uiCanonical").and_then(Value::as_str) == Some("user_message")
    });
    let mut used_bytes = 2usize;
    let mut selected_indices = Vec::new();
    let mut truncated = events.iter().any(|(_, text_truncated)| *text_truncated);

    // A round body without its opening user message is misleading. Reserve
    // that event first, then spend the remaining budget on the newest events.
    if let Some(index) = first_user_index {
        let event_bytes = serde_json::to_vec(&events[index].0)
            .map(|bytes| bytes.len().saturating_add(1))
            .unwrap_or(MAX_MOBILE_UPSERT_BYTES.saturating_add(1));
        if used_bytes.saturating_add(event_bytes) <= MAX_MOBILE_UPSERT_BYTES {
            used_bytes = used_bytes.saturating_add(event_bytes);
            selected_indices.push(index);
        } else {
            truncated = true;
        }
    }

    for index in (0..events.len()).rev() {
        if Some(index) == first_user_index {
            continue;
        }
        if selected_indices.len() >= MAX_MOBILE_HISTORY_EVENTS {
            truncated = true;
            continue;
        }
        let event_bytes = serde_json::to_vec(&events[index].0)
            .map(|bytes| bytes.len().saturating_add(1))
            .unwrap_or(MAX_MOBILE_UPSERT_BYTES.saturating_add(1));
        if used_bytes.saturating_add(event_bytes) > MAX_MOBILE_UPSERT_BYTES {
            truncated = true;
            continue;
        }
        used_bytes = used_bytes.saturating_add(event_bytes);
        selected_indices.push(index);
    }
    if selected_indices.len() < events.len() {
        truncated = true;
    }
    selected_indices.sort_unstable();
    MobileUpsertBudget {
        upserts: selected_indices
            .into_iter()
            .map(|index| events[index].0.clone())
            .collect(),
        truncated,
    }
}

fn mobile_upserts_from_session_events(events: &[SessionEvent]) -> MobileUpsertBudget {
    budget_mobile_upserts(events.iter().filter_map(|event| {
        let (mobile_event, tool_data_truncated) = mobile_event_from_session(event)?;
        let text_limit = if mobile_event.get("displayVariant").and_then(Value::as_str)
            == Some("tool_call")
            || mobile_event.get("actionType").and_then(Value::as_str) == Some("tool_call")
            || mobile_event
                .get("uiCanonical")
                .and_then(Value::as_str)
                .is_some_and(|canonical| canonical.starts_with("tool_"))
        {
            MAX_MOBILE_TOOL_TEXT_BYTES
        } else {
            MAX_MOBILE_MESSAGE_TEXT_BYTES
        };
        Some((
            mobile_event,
            tool_data_truncated || event.display_text.len() > text_limit,
        ))
    }))
}

fn mobile_upserts_from_wire(envelope: &Value) -> MobileUpsertBudget {
    let upserts = envelope
        .get("upserts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    budget_mobile_upserts(upserts.iter().filter_map(|event| {
        let display_text = wire_string(event, "displayText", "display_text");
        let (mobile_event, tool_data_truncated) = mobile_event_from_wire(event)?;
        let text_limit = if mobile_event.get("displayVariant").and_then(Value::as_str)
            == Some("tool_call")
            || mobile_event.get("actionType").and_then(Value::as_str) == Some("tool_call")
            || mobile_event
                .get("uiCanonical")
                .and_then(Value::as_str)
                .is_some_and(|canonical| canonical.starts_with("tool_"))
        {
            MAX_MOBILE_TOOL_TEXT_BYTES
        } else {
            MAX_MOBILE_MESSAGE_TEXT_BYTES
        };
        Some((
            mobile_event,
            tool_data_truncated || display_text.len() > text_limit,
        ))
    }))
}

fn mobile_removed_ids(envelope: &Value) -> Vec<String> {
    let ids = envelope
        .get("removedIds")
        .or_else(|| envelope.get("removed_ids"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut used_bytes = 2usize;
    let mut newest_first = Vec::new();
    for id in ids.iter().rev().filter_map(Value::as_str) {
        if newest_first.len() >= MAX_MOBILE_REMOVED_IDS {
            break;
        }
        let id = truncate_mobile_text(id, MAX_MOBILE_ID_BYTES);
        let id_bytes = serde_json::to_vec(&id)
            .map(|bytes| bytes.len().saturating_add(1))
            .unwrap_or(MAX_MOBILE_REMOVED_ID_BYTES.saturating_add(1));
        if used_bytes.saturating_add(id_bytes) > MAX_MOBILE_REMOVED_ID_BYTES {
            continue;
        }
        used_bytes = used_bytes.saturating_add(id_bytes);
        newest_first.push(id);
    }
    newest_first.reverse();
    newest_first
}

pub(crate) fn compact_snapshot_envelope_for_mobile(envelope: &Value) -> Value {
    let budget = mobile_upserts_from_wire(envelope);
    json!({
        "sessionId": envelope
            .get("sessionId")
            .or_else(|| envelope.get("session_id"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "version": envelope.get("version").and_then(Value::as_u64).unwrap_or_default(),
        "snapshotDelta": envelope
            .get("snapshotDelta")
            .or_else(|| envelope.get("snapshot_delta"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "streaming": envelope.get("streaming").and_then(Value::as_bool).unwrap_or(false),
        "upserts": budget.upserts,
        "truncated": envelope.get("truncated").and_then(Value::as_bool).unwrap_or(false)
            || budget.truncated,
        "removedIds": mobile_removed_ids(envelope),
        "memberships": [],
    })
}

fn build_subscription_snapshot(
    session_id: &str,
    round_id: Option<&str>,
    events: &[SessionEvent],
    source_truncated: bool,
    version: u64,
) -> Value {
    let snapshot = crate::agent_sessions::event_pipeline::derived::compute_derived(events, version);
    let budget = mobile_upserts_from_session_events(&snapshot.chat_events);
    let mut value = json!({
        "sessionId": session_id,
        "version": snapshot.version,
        "snapshotDelta": false,
        "streaming": snapshot.has_running_event,
        "upserts": budget.upserts,
        "truncated": source_truncated || budget.truncated,
        "removedIds": [],
        "memberships": [],
    });
    if let Some(round_id) = round_id {
        value["roundId"] = Value::String(round_id.to_string());
    }
    value
}

/// Subscribe a mobile connection to session event fanout and return one
/// authoritative, bounded history snapshot for the selected session.
pub async fn session_subscribe(conn_id: u64, params: &Value) -> Result<Value, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?;

    if fanout::subscription_count(conn_id) >= MAX_CONCURRENT_SUBSCRIPTIONS
        && !fanout::is_subscribed(conn_id, session_id)
    {
        return Err(RpcError::new(
            RpcErrorCode::InvalidParams,
            "max concurrent subscriptions reached",
        ));
    }

    if !fanout::subscribe_session(conn_id, session_id) {
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "connection not registered",
        ));
    }

    let history = match load_mobile_initial_history(session_id).await {
        Ok(loaded) => loaded,
        Err(err) => {
            fanout::unsubscribe_session(conn_id, session_id);
            return Err(err);
        }
    };
    let snapshot = build_subscription_snapshot(
        session_id,
        history.latest_round_id.as_deref(),
        &history.events,
        history.events_truncated,
        0,
    );

    Ok(json!({
        "subscribed": true,
        "sessionId": session_id,
        "rounds": {
            "items": history.rounds,
            "complete": history.rounds_complete,
        },
        "snapshot": snapshot,
    }))
}

/// Load one exact round body without mutating the desktop EventStore window.
pub async fn session_round(params: &Value) -> Result<Value, RpcError> {
    let parsed = parse_session_round_params(params)?;
    let loaded = require_mobile_round_events(
        &parsed.session_id,
        &parsed.round_id,
        load_mobile_round_events(&parsed.session_id, &parsed.round_id).await?,
    )?;
    let snapshot = build_subscription_snapshot(
        &parsed.session_id,
        Some(&parsed.round_id),
        &loaded.events,
        loaded.truncated,
        0,
    );

    Ok(json!({
        "sessionId": parsed.session_id,
        "roundId": parsed.round_id,
        "snapshot": snapshot,
    }))
}

/// Unsubscribe from a session fanout stream.
pub fn session_unsubscribe(conn_id: u64, params: &Value) -> Result<Value, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?;

    fanout::unsubscribe_session(conn_id, session_id);

    Ok(json!({
        "unsubscribed": true,
        "sessionId": session_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_session_send_params_requires_session_id() {
        let err = parse_session_send_params(&json!({ "content": "hi" })).unwrap_err();
        assert_eq!(err.code, RpcErrorCode::InvalidParams);
    }

    #[test]
    fn parse_session_send_params_rejects_empty_content() {
        let err = parse_session_send_params(&json!({
            "sessionId": "sde-1",
            "content": "   "
        }))
        .unwrap_err();
        assert!(err.message.contains("content"));
    }

    #[test]
    fn parse_session_send_params_accepts_optional_turn_intent_id() {
        let parsed = parse_session_send_params(&json!({
            "sessionId": "sde-1",
            "content": "hello",
            "turnIntentId": "ti_123",
            "model": "gpt-4"
        }))
        .expect("params");
        assert_eq!(parsed.session_id, "sde-1");
        assert_eq!(parsed.content, "hello");
        assert_eq!(parsed.turn_intent_id.as_deref(), Some("ti_123"));
        assert_eq!(parsed.model.as_deref(), Some("gpt-4"));
    }

    #[test]
    fn parse_session_send_params_rejects_oversized_content() {
        let err = parse_session_send_params(&json!({
            "sessionId": "sde-1",
            "content": "x".repeat(MAX_MOBILE_SEND_CONTENT_BYTES + 1),
        }))
        .unwrap_err();
        assert!(err.message.contains("too large"));
    }

    #[test]
    fn parse_session_cancel_params_requires_session_id() {
        let err = parse_session_cancel_params(&json!({})).unwrap_err();
        assert_eq!(err.code, RpcErrorCode::InvalidParams);
    }

    #[test]
    fn parse_session_round_params_validates_round_identity() {
        let parsed = parse_session_round_params(&json!({
            "sessionId": " codexapp-session ",
            "roundId": " codex-turn-42 ",
        }))
        .expect("round params");
        assert_eq!(parsed.session_id, "codexapp-session");
        assert_eq!(parsed.round_id, "codex-turn-42");

        let missing = parse_session_round_params(&json!({
            "sessionId": "codexapp-session",
        }))
        .unwrap_err();
        assert_eq!(missing.code, RpcErrorCode::InvalidParams);

        let oversized = parse_session_round_params(&json!({
            "sessionId": "codexapp-session",
            "roundId": "x".repeat(MAX_MOBILE_ROUND_ID_BYTES + 1),
        }))
        .unwrap_err();
        assert!(oversized.message.contains("too long"));
    }

    fn projected_round(
        id: &str,
        sequence: i64,
    ) -> orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata {
        orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata {
            turn_id: id.to_string(),
            start_sequence: sequence,
            started_at: format!("2026-08-30T10:00:0{sequence}Z"),
            ended_at: Some(format!("2026-08-30T10:00:0{}Z", sequence + 1)),
            status: "completed".to_string(),
            user_preview: format!("question {id}"),
            event_count: 2,
            body_event_count: 1,
            modified_files: Vec::new(),
            resource_interactions: Vec::new(),
            git_artifacts: Vec::new(),
        }
    }

    fn history_chunk(id: &str, function: &str) -> core_types::activity::ActivityChunk {
        let mut chunk = core_types::activity::ActivityChunk::new("history", "raw", function);
        chunk.chunk_id = id.to_string();
        chunk
    }

    #[test]
    fn initial_history_keeps_all_round_summaries_but_only_latest_body() {
        let turns = vec![
            projected_round("u1", 0),
            projected_round("u2", 2),
            projected_round("u3", 4),
        ];
        let rounds = mobile_rounds_from_projected(&turns);
        let chunks = vec![
            history_chunk("u1", "user"),
            history_chunk("a1", "assistant"),
            history_chunk("u2", "user"),
            history_chunk("a2", "assistant"),
            history_chunk("u3", "user"),
            history_chunk("a3", "assistant"),
        ];
        let latest = latest_round_chunks(chunks, rounds.last().map(|round| round.id.as_str()));

        assert_eq!(
            rounds
                .iter()
                .map(|round| round.id.as_str())
                .collect::<Vec<_>>(),
            vec!["u1", "u2", "u3"]
        );
        assert_eq!(rounds[0].next_round_id.as_deref(), Some("u2"));
        assert_eq!(rounds[2].next_round_id, None);
        assert_eq!(rounds[2].user_preview, "question u3");
        assert_eq!(
            latest
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["u3", "a3"]
        );
    }

    #[test]
    fn cached_round_directory_exposes_canonical_turn_intent_id() {
        let turns = vec![session_persistence::CachedTurnSummary {
            session_id: "native-session".to_string(),
            turn_id: "round-1".to_string(),
            turn_intent_id: Some("intent-1".to_string()),
            start_sequence: 1,
            end_sequence: None,
            next_turn_id: None,
            started_at: "2026-08-30T10:00:00Z".to_string(),
            ended_at: None,
            duration_ms: None,
            user_event_ids: vec!["user-1".to_string()],
            user_preview: "hello".to_string(),
            event_count: 1,
            body_event_count: 0,
            status: "pending".to_string(),
            interrupted: false,
            modified_files: Vec::new(),
            resource_interactions: Vec::new(),
            git_artifacts: Vec::new(),
        }];

        let rounds = mobile_rounds_from_cached(&turns);
        let wire = serde_json::to_value(&rounds[0]).expect("round wire");

        assert_eq!(rounds[0].turn_intent_id.as_deref(), Some("intent-1"));
        assert_eq!(
            wire.get("turnIntentId").and_then(Value::as_str),
            Some("intent-1")
        );
    }

    #[test]
    fn imported_round_directory_omits_unknown_turn_intent_id() {
        let rounds = mobile_rounds_from_projected(&[projected_round("round-1", 1)]);
        let wire = serde_json::to_value(&rounds[0]).expect("round wire");

        assert!(wire.get("turnIntentId").is_none());
    }

    #[test]
    fn exact_codex_round_drops_previous_context_placeholder() {
        let chunks = vec![
            history_chunk("u1", "user"),
            history_chunk("codex-unloaded-u1", "assistant"),
            history_chunk("u2", "user"),
            history_chunk("a2", "assistant"),
        ];
        let exact = exact_codex_round_chunks(chunks, 2);
        assert_eq!(
            exact
                .iter()
                .map(|chunk| chunk.chunk_id.as_str())
                .collect::<Vec<_>>(),
            vec!["u2", "a2"]
        );
    }

    #[test]
    fn round_directory_is_a_bounded_contiguous_newest_suffix() {
        let turns = (0..=MAX_MOBILE_ROUNDS)
            .map(|index| projected_round(&format!("round-{index}"), 0))
            .collect::<Vec<_>>();
        let (rounds, complete) = bounded_mobile_rounds(mobile_rounds_from_projected(&turns));

        assert!(!complete);
        assert_eq!(rounds.len(), MAX_MOBILE_ROUNDS);
        assert_eq!(
            rounds.first().map(|round| round.id.as_str()),
            Some("round-1")
        );
        assert_eq!(
            rounds.last().map(|round| round.id.as_str()),
            Some("round-500")
        );
        assert!(rounds
            .iter()
            .all(|round| round.user_preview.len() <= MAX_MOBILE_ROUND_PREVIEW_BYTES));

        let mut long_preview = projected_round("long-preview", 0);
        long_preview.user_preview = "问".repeat(MAX_MOBILE_ROUND_PREVIEW_BYTES);
        let (rounds, complete) =
            bounded_mobile_rounds(mobile_rounds_from_projected(&[long_preview]));
        assert!(complete);
        assert_eq!(rounds.len(), 1);
        assert!(rounds[0].user_preview.len() <= MAX_MOBILE_ROUND_PREVIEW_BYTES);
    }

    #[test]
    fn round_directory_byte_budget_never_creates_holes() {
        let turns = (0..300)
            .map(|index| {
                let mut turn = projected_round(&format!("round-{index}-{}", "x".repeat(900)), 0);
                turn.user_preview = "preview".repeat(80);
                turn
            })
            .collect::<Vec<_>>();
        let (rounds, complete) = bounded_mobile_rounds(mobile_rounds_from_projected(&turns));

        assert!(!complete);
        assert!(rounds.len() < turns.len());
        let first_index = 300usize - rounds.len();
        for (offset, round) in rounds.iter().enumerate() {
            assert!(round
                .id
                .starts_with(&format!("round-{}-", first_index + offset)));
        }
    }

    #[test]
    fn chunk_budget_preserves_the_round_opening_user() {
        let mut chunks = Vec::with_capacity(MAX_MOBILE_HISTORY_EVENTS + 2);
        chunks.push(history_chunk("user-opening", "user_message"));
        chunks.extend(
            (0..=MAX_MOBILE_HISTORY_EVENTS)
                .map(|index| history_chunk(&format!("assistant-{index}"), "assistant")),
        );

        let (raw, truncated) = chunks_to_raw(chunks, "codexapp-history");
        assert!(truncated);
        assert_eq!(raw.len(), MAX_MOBILE_HISTORY_EVENTS);
        assert_eq!(
            raw.first().and_then(|chunk| chunk.chunk_id.as_deref()),
            Some("user-opening")
        );
        assert_eq!(
            raw.first().and_then(|chunk| chunk.function.as_deref()),
            Some("user_message")
        );
        assert_eq!(
            raw.last().and_then(|chunk| chunk.chunk_id.as_deref()),
            Some("assistant-1000")
        );
    }

    #[test]
    fn empty_exact_round_is_not_a_successful_snapshot() {
        let err = require_mobile_round_events(
            "codexapp-session",
            "missing-round",
            LoadedMobileEvents {
                events: Vec::new(),
                truncated: false,
            },
        )
        .err()
        .expect("missing round error");
        assert_eq!(err.code, RpcErrorCode::SessionNotFound);
        assert!(err.message.contains("missing-round"));
    }

    #[test]
    fn mobile_execution_routes_each_session_family_to_its_owner() {
        assert_eq!(
            mobile_session_execution("cliagent-managed"),
            MobileSessionExecution::ManagedCli
        );
        assert_eq!(
            mobile_session_execution("codexapp-imported"),
            MobileSessionExecution::ImportedHistory
        );
        assert_eq!(
            mobile_session_execution("cursoride-imported"),
            MobileSessionExecution::ImportedHistory
        );
        assert_eq!(
            mobile_session_execution("sdeagent-native"),
            MobileSessionExecution::NativeAgent
        );
    }

    #[test]
    fn managed_cli_mobile_send_owns_an_authoritative_user_event() {
        let request = managed_cli_mobile_message_request(
            SessionSendParams {
                session_id: "cliagent-managed".to_string(),
                content: "mobile question".to_string(),
                turn_intent_id: Some("intent-mobile".to_string()),
                model: Some("model-a".to_string()),
            },
            "intent-mobile".to_string(),
        );

        assert!(request.materialize_user_message_event);
        assert_eq!(request.turn_intent_id.as_deref(), Some("intent-mobile"));
        assert_eq!(
            request.client_message_id.as_deref(),
            Some("mobile-intent-mobile")
        );
        assert_eq!(request.content, "mobile question");
    }

    #[test]
    fn map_session_status_to_mobile_running_states() {
        assert_eq!(map_session_status_to_mobile("running"), "running");
        assert_eq!(map_session_status_to_mobile("pending"), "running");
        assert_eq!(map_session_status_to_mobile("waiting_for_user"), "running");
    }

    #[test]
    fn map_session_status_to_mobile_idle_states() {
        assert_eq!(map_session_status_to_mobile("idle"), "idle");
        assert_eq!(map_session_status_to_mobile("completed"), "idle");
        assert_eq!(map_session_status_to_mobile("failed"), "idle");
    }

    #[test]
    fn mobile_session_name_prefers_the_directory_display_projection() {
        assert_eq!(
            mobile_session_name(
                "# Files mentioned by the user: raw provider envelope",
                Some("Generate a pairing code")
            ),
            "Generate a pairing code"
        );
        assert_eq!(mobile_session_name("Fallback", Some("  ")), "Fallback");
    }

    #[test]
    fn sidebar_snapshot_list_preserves_desktop_order_and_running_filter() {
        let snapshot = vec![
            MobileSidebarSessionSnapshotRow {
                id: "second-by-time".to_string(),
                name: "Desktop first".to_string(),
                status: "idle".to_string(),
            },
            MobileSidebarSessionSnapshotRow {
                id: "first-by-time".to_string(),
                name: "Desktop second".to_string(),
                status: "running".to_string(),
            },
        ];

        let writable_codex_session_ids = HashSet::new();
        let all = session_list_from_sidebar_snapshot(
            snapshot.clone(),
            "all",
            10,
            &writable_codex_session_ids,
        );
        assert_eq!(
            all.pointer("/sessions/0/id").and_then(Value::as_str),
            Some("second-by-time")
        );
        assert_eq!(
            all.pointer("/sessions/1/id").and_then(Value::as_str),
            Some("first-by-time")
        );
        assert_eq!(
            all.get("source").and_then(Value::as_str),
            Some("desktop_sidebar")
        );

        let running = session_list_from_sidebar_snapshot(
            snapshot,
            "running",
            10,
            &writable_codex_session_ids,
        );
        assert_eq!(
            running.pointer("/sessions/0/id").and_then(Value::as_str),
            Some("first-by-time")
        );
        assert_eq!(
            running
                .get("sessions")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn subscription_snapshot_projects_normalized_history_messages() {
        let user =
            core_types::activity::ActivityChunk::new("codexapp-history", "raw", "user_message")
                .with_result(json!({
                    "type": "user",
                    "message": { "role": "user", "content": "historic prompt" },
                    "turnIntentId": "intent-history"
                }));
        let assistant =
            core_types::activity::ActivityChunk::new("codexapp-history", "assistant", "assistant")
                .with_result(json!({ "content": "historic answer" }));
        let (raw, source_truncated) = chunks_to_raw(vec![user, assistant], "codexapp-history");
        let events = crate::agent_sessions::event_pipeline::ingestion::ingest_raw_chunks(
            &raw,
            "codexapp-history",
        )
        .events;

        let snapshot = build_subscription_snapshot(
            "codexapp-history",
            Some("round-history"),
            &events,
            source_truncated,
            0,
        );
        assert_eq!(
            snapshot.get("roundId").and_then(Value::as_str),
            Some("round-history")
        );
        let upserts = snapshot
            .get("upserts")
            .and_then(Value::as_array)
            .expect("snapshot upserts");
        assert_eq!(upserts.len(), 2);
        assert_eq!(
            upserts[0].get("source").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            upserts[0].get("turnIntentId").and_then(Value::as_str),
            Some("intent-history")
        );
        assert_eq!(
            upserts[1].get("uiCanonical").and_then(Value::as_str),
            Some("agent_message")
        );
        assert_eq!(
            upserts[1].get("displayText").and_then(Value::as_str),
            Some("historic answer")
        );
    }

    #[test]
    fn mobile_tool_projection_keeps_structured_context_with_hard_limits() {
        let event = json!({
            "id": "tool-shell",
            "uiCanonical": "run_shell",
            "functionName": "run_shell",
            "actionType": "tool_call",
            "source": "tool",
            "displayVariant": "tool_call",
            "displayStatus": "completed",
            "displayText": "run_shell",
            "createdAt": "2026-08-30T10:00:00Z",
            "callId": "call-shell",
            "command": "pnpm test",
            "args": {
                "command": "pnpm test",
                "apiKey": "must-not-leave-the-desktop"
            },
            "result": {
                "output": "full raw result stays private"
            },
            "extracted": {
                "kind": "shell",
                "command": "pnpm test",
                "cwd": "/repo",
                "output": "问".repeat(MAX_MOBILE_TOOL_DATA_STRING_BYTES + 32),
                "exitCode": 0,
                "isFailure": false,
                "nested": {
                    "password": "must-not-leave-the-desktop",
                    "label": "safe"
                }
            }
        });

        let (projected, truncated) = mobile_event_from_wire(&event).expect("tool projection");
        let encoded = serde_json::to_vec(&projected).expect("serialize projected tool");
        let encoded_text = String::from_utf8(encoded.clone()).expect("valid utf-8 payload");

        assert!(truncated);
        assert!(encoded.len() < MAX_MOBILE_TOOL_DATA_BYTES + MAX_MOBILE_TOOL_TEXT_BYTES + 2_048);
        assert_eq!(
            projected.get("toolSummary").and_then(Value::as_str),
            Some("pnpm test")
        );
        assert_eq!(
            projected.pointer("/toolData/kind").and_then(Value::as_str),
            Some("shell")
        );
        assert_eq!(
            projected
                .pointer("/toolData/exitCode")
                .and_then(Value::as_i64),
            Some(0)
        );
        assert_eq!(
            projected
                .pointer("/toolDataTruncated")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            projected
                .pointer("/toolData/nested/password")
                .and_then(Value::as_str),
            Some("[redacted]")
        );
        assert!(!encoded_text.contains("must-not-leave-the-desktop"));
        assert!(projected.get("args").is_none());
        assert!(projected.get("result").is_none());
    }

    #[test]
    fn mobile_history_conversion_is_bounded() {
        let chunks = (0..=MAX_MOBILE_HISTORY_EVENTS)
            .map(|_| core_types::activity::ActivityChunk::new("s", "assistant", "assistant"))
            .collect();
        let (raw, truncated) = chunks_to_raw(chunks, "s");
        assert_eq!(raw.len(), MAX_MOBILE_HISTORY_EVENTS);
        assert!(truncated);
    }

    #[test]
    fn subscription_snapshot_stays_below_the_relay_frame_limit() {
        let user = core_types::activity::ActivityChunk::new(
            "codexapp-large-history",
            "raw",
            "user_message",
        )
        .with_result(json!({
            "type": "user",
            "message": { "role": "user", "content": "opening question" }
        }));
        let assistant = core_types::activity::ActivityChunk::new(
            "codexapp-large-history",
            "assistant",
            "assistant",
        )
        .with_result(json!({ "content": "seed" }));
        let (raw, source_truncated) =
            chunks_to_raw(vec![user, assistant], "codexapp-large-history");
        let templates = crate::agent_sessions::event_pipeline::ingestion::ingest_raw_chunks(
            &raw,
            "codexapp-large-history",
        )
        .events;
        // Ingestion owns canonical timeline ordering, so do not infer roles
        // from vector position when constructing this byte-budget fixture.
        let mut user_template = templates
            .iter()
            .find(|event| event.source == EventSource::User)
            .cloned()
            .expect("user template");
        user_template.created_at = "2026-08-29T09:59:59.999Z".to_string();
        let assistant_template = templates
            .iter()
            .find(|event| event.source == EventSource::Assistant)
            .cloned()
            .expect("assistant template");
        let mut events = vec![user_template];
        events.extend(
            (0..200)
                .map(|index| {
                    let mut event = assistant_template.clone();
                    event.id = format!("assistant-{index}");
                    event.created_at = format!("2026-08-29T10:00:00.{index:03}Z");
                    event.display_text = format!("message-{index}-{}", "x".repeat(64 * 1024));
                    event.result = json!({ "content": "y".repeat(64 * 1024) });
                    event
                })
                .collect::<Vec<_>>(),
        );

        let snapshot = build_subscription_snapshot(
            "codexapp-large-history",
            None,
            &events,
            source_truncated,
            1,
        );
        let serialized = serde_json::to_vec(&snapshot).expect("serialize mobile snapshot");
        assert!(
            serialized.len() < 768 * 1024,
            "mobile snapshot must leave headroom below the Relay's 1 MiB frame limit"
        );
        let upserts = snapshot
            .get("upserts")
            .and_then(Value::as_array)
            .expect("snapshot upserts");
        assert!(upserts.iter().all(|event| event.get("result").is_none()));
        assert_eq!(
            upserts
                .first()
                .and_then(|event| event.get("source"))
                .and_then(Value::as_str),
            Some("user"),
            "the opening question must survive round byte truncation"
        );
        assert_eq!(
            snapshot.get("truncated").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            upserts
                .last()
                .and_then(|event| event.get("id"))
                .and_then(Value::as_str),
            Some("assistant-199"),
            "newest history must win when the byte budget is full"
        );
    }

    #[test]
    fn live_snapshot_compaction_drops_large_raw_payloads_and_keeps_newest() {
        let mut upserts = (0..100)
            .map(|index| {
                json!({
                    "id": format!("tool-{index}"),
                    "uiCanonical": "tool_shell",
                    "functionName": "shell",
                    "actionType": "tool_call",
                    "source": "tool",
                    "displayVariant": "tool_call",
                    "displayStatus": "completed",
                    "displayText": format!("tool-{index}-{}", "x".repeat(32 * 1024)),
                    "createdAt": format!("2026-08-29T10:00:{index:02}Z"),
                    "args": { "content": "a".repeat(64 * 1024) },
                    "result": { "output": "b".repeat(64 * 1024) },
                })
            })
            .collect::<Vec<_>>();
        upserts.push(json!({
            "id": "user-current",
            "uiCanonical": "user_message",
            "actionType": "raw",
            "source": "user",
            "displayVariant": "message",
            "displayStatus": "completed",
            "displayText": "hello",
            "createdAt": "2026-08-29T10:01:41Z",
            "result": {
                "message": { "role": "user", "content": "hello" },
                "turnIntentId": "intent-live"
            },
        }));
        let compacted = compact_snapshot_envelope_for_mobile(&json!({
            "sessionId": "sde-live",
            "version": 7,
            "snapshotDelta": true,
            "upserts": upserts,
            "removedIds": [],
        }));

        let serialized = serde_json::to_vec(&compacted).expect("serialize compact live snapshot");
        assert!(serialized.len() < 768 * 1024);
        let compacted_upserts = compacted["upserts"].as_array().expect("upserts");
        assert!(compacted_upserts
            .iter()
            .all(|event| event.get("args").is_none() && event.get("result").is_none()));
        assert!(
            compacted_upserts
                .iter()
                .filter(|event| event.get("displayVariant").and_then(Value::as_str)
                    == Some("tool_call"))
                .all(
                    |event| event.pointer("/toolData/kind").and_then(Value::as_str)
                        == Some("unknown")
                )
        );
        assert_eq!(
            compacted_upserts
                .last()
                .and_then(|event| event.get("id"))
                .and_then(Value::as_str),
            Some("user-current")
        );
        assert_eq!(
            compacted_upserts
                .last()
                .and_then(|event| event.get("turnIntentId"))
                .and_then(Value::as_str),
            Some("intent-live")
        );
    }
}
