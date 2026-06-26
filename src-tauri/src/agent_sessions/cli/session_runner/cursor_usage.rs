//! Cursor Dashboard API usage fetch — token tracking after session runs.

use crate::api::websocket_handler;
use key_vault::key_store::{ModelType, KEY_SERVICE};

/// Fetch token usage from the Cursor Dashboard API after a single run completes.
///
/// This runs as a fire-and-forget async task. It waits a few seconds for the
/// Cursor API to update, fetches ALL usage events in the *run's* time window
/// (no model filtering — the narrow per-run window is sufficient), stores a
/// per-round record in `session_token_usage` using the actual model from the
/// API response, updates the aggregate column, and broadcasts a WebSocket
/// event so the frontend can refresh.
///
/// Token resolution: uses ONLY the specific credential identified by `account_id`.
/// No fallbacks — if account_id is missing, usage tracking is skipped.
pub(super) async fn fetch_cursor_usage_for_session(
    session_id: &str,
    account_id: Option<&str>,
    run_started_at: chrono::DateTime<chrono::Utc>,
) {
    use crate::agent_sessions::cli::platform_adapters::cursor::usage::fetch_cursor_usage;
    use chrono::Utc;

    let session_token = resolve_cursor_session_token(account_id);
    let session_token = match session_token {
        Some(token) => token,
        None => {
            tracing::info!(
                "[CursorUsage] No session_token available (account_id={:?}), skipping usage fetch",
                account_id
            );
            return;
        }
    };

    let start_time = run_started_at - chrono::Duration::seconds(2);
    let end_time = Utc::now();

    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    let summary = match fetch_cursor_usage(&session_token, start_time, end_time, None).await {
        Ok(summary) if summary.event_count > 0 => summary,
        Ok(_) => {
            tracing::info!(
                "[CursorUsage] 0 events on first attempt for session {}, retrying in 10s...",
                session_id
            );
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let retry_end = Utc::now();
            match fetch_cursor_usage(&session_token, start_time, retry_end, None).await {
                Ok(summary) => summary,
                Err(err) => {
                    tracing::warn!(
                        "[CursorUsage] Retry failed for session {}: {}",
                        session_id,
                        err
                    );
                    return;
                }
            }
        }
        Err(err) => {
            tracing::warn!(
                "[CursorUsage] Failed to fetch usage for session {}: {}",
                session_id,
                err
            );
            return;
        }
    };

    if summary.event_count == 0 {
        tracing::info!(
            "[CursorUsage] No matching events for session {} after retry",
            session_id,
        );
        return;
    }

    if let Err(err) = session_persistence::token_usage::insert_token_usage_record(
        session_id,
        "code",
        summary.dominant_model.as_deref(),
        account_id,
        summary.input_tokens as i64,
        summary.output_tokens as i64,
        summary.cache_read_tokens as i64,
        summary.cache_write_tokens as i64,
        summary.total_tokens as i64,
        0,
        None,
    ) {
        tracing::warn!(
            "[CursorUsage] Failed to insert per-round token usage for session {}: {}",
            session_id,
            err
        );
    }

    tracing::info!(
        "[CursorUsage] Stored token usage for session {}: {} events, {} total tokens, model={:?}",
        session_id,
        summary.event_count,
        summary.total_tokens,
        summary.dominant_model,
    );

    let update_msg = serde_json::json!({
        "type": "code_session.token_usage_updated",
        "session_id": session_id,
        "total_tokens": summary.total_tokens,
    });
    websocket_handler::broadcast(update_msg.to_string());
}

/// Resolve the Cursor session token to use for Dashboard API queries.
///
/// Uses ONLY the specific credential identified by `account_id`.
/// No fallbacks — if account_id is missing or has no session_token,
/// usage tracking is skipped. The frontend is responsible for always
/// setting account_id when creating sessions.
fn resolve_cursor_session_token(account_id: Option<&str>) -> Option<String> {
    let acc_id = match account_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            tracing::warn!(
                "[CursorUsage] No account_id set on session — cannot resolve session_token. \
                 Ensure the frontend passes selectedAccountId when creating sessions."
            );
            return None;
        }
    };

    let cred = KEY_SERVICE.get_key(&ModelType::CursorCli, Some(acc_id));
    if let Some(token) = cred.and_then(|c| c.session_token) {
        tracing::info!(
            "[CursorUsage] Using session_token from credential account_id={}",
            acc_id
        );
        return Some(token);
    }

    tracing::warn!(
        "[CursorUsage] Credential '{}' has no session_token — usage tracking skipped",
        acc_id
    );
    None
}
