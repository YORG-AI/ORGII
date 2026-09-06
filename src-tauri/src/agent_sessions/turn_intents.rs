//! Provider-neutral durable turn-intent reads.
//!
//! Canonical conversation recovery uses the same `session_turn_intents` rows
//! already written by Agent and CLI runtimes. Keeping this query above either
//! adapter avoids a second frontend receipt/claim database.

use serde::Serialize;

// One IPC call is deliberately bounded so renderer shutdown/update can tear
// it down promptly. The frontend chains these windows while the exact durable
// intent remains queued/running; a legitimate long provider turn therefore
// has no arbitrary wall-clock deadline.
const MAX_TURN_WAIT_MS: u64 = 60_000;
const TURN_WAIT_INITIAL_POLL_MS: u64 = 100;
const TURN_WAIT_MAX_POLL_MS: u64 = 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnIntentStatus {
    pub session_id: String,
    pub turn_intent_id: String,
    pub status: String,
    pub updated_at: String,
}

fn read_status(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<SessionTurnIntentStatus>, String> {
    session_persistence::turn_intents::read_intent(session_id, turn_intent_id)
        .map(|row| {
            row.map(|intent| SessionTurnIntentStatus {
                session_id: intent.session_id,
                turn_intent_id: intent.turn_intent_id,
                status: intent.status.as_str().to_string(),
                updated_at: intent.updated_at,
            })
        })
        .map_err(|err| format!("DB error: {err}"))
}

#[tauri::command]
pub async fn session_turn_intent_status(
    session_id: String,
    turn_intent_id: String,
) -> Result<Option<SessionTurnIntentStatus>, String> {
    if session_id.is_empty() || turn_intent_id.is_empty() {
        return Err("session_id and turn_intent_id are required".to_string());
    }
    tokio::task::spawn_blocking(move || read_status(&session_id, &turn_intent_id))
        .await
        .map_err(|err| format!("Task error: {err}"))?
}

#[tauri::command]
pub async fn session_wait_for_turn_terminal(
    session_id: String,
    turn_intent_id: String,
    timeout_ms: u64,
) -> Result<SessionTurnIntentStatus, String> {
    if session_id.is_empty() || turn_intent_id.is_empty() {
        return Err("session_id and turn_intent_id are required".to_string());
    }
    let timeout_ms = timeout_ms.clamp(1, MAX_TURN_WAIT_MS);
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    let mut poll_ms = TURN_WAIT_INITIAL_POLL_MS;

    loop {
        let read_session_id = session_id.clone();
        let read_turn_intent_id = turn_intent_id.clone();
        let intent = tokio::task::spawn_blocking(move || {
            read_status(&read_session_id, &read_turn_intent_id)
        })
        .await
        .map_err(|err| format!("Task error: {err}"))??;

        if let Some(intent) = intent.filter(|row| {
            matches!(
                row.status.as_str(),
                "completed" | "failed" | "cancelled" | "stale" | "coalesced" | "rejected"
            )
        }) {
            return Ok(intent);
        }

        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(format!(
                "turn {turn_intent_id} for session {session_id} timed out"
            ));
        }
        tokio::time::sleep(std::cmp::min(
            tokio::time::Duration::from_millis(poll_ms),
            deadline - now,
        ))
        .await;
        poll_ms = poll_ms.saturating_mul(2).min(TURN_WAIT_MAX_POLL_MS);
    }
}
