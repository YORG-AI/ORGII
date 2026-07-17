use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use tokio::sync::oneshot;

use super::config;
use super::history::{prefix_hash, select_next_chunk, summary_message, RunMode};
use super::persistence;
use super::{HousekeeperCompactionStatus, HousekeeperContextCompactionState};
use crate::model_context::compaction::ContextCompactor;
use crate::session::persistence as session_persistence;
use crate::session::scheduler::{ScheduledKind, ScheduledMessage};
use crate::state::{AgentAppState, AgentSession};

const BACKGROUND_INITIAL_DELAY: Duration = Duration::from_secs(20);
const BACKGROUND_INTERVAL: Duration = Duration::from_secs(45);
const BACKGROUND_CANDIDATE_LIMIT: usize = 16;

fn response_from_record(
    record: persistence::CompactionRecord,
    status: HousekeeperCompactionStatus,
    message: Option<String>,
) -> HousekeeperContextCompactionState {
    HousekeeperContextCompactionState {
        enabled: record.enabled,
        status,
        covered_messages: record.covered_message_count,
        source_tokens: record.source_tokens,
        summary_tokens: record.summary_tokens,
        last_run_at: record.last_run_at,
        last_error: record.last_error,
        message,
    }
}

fn error_response(session_id: &str, error: String) -> HousekeeperContextCompactionState {
    let _ = persistence::mark_error(session_id, &error);
    match persistence::load(session_id) {
        Ok(record) => response_from_record(record, HousekeeperCompactionStatus::Error, Some(error)),
        Err(_) => HousekeeperContextCompactionState {
            enabled: true,
            status: HousekeeperCompactionStatus::Error,
            covered_messages: 0,
            source_tokens: 0,
            summary_tokens: 0,
            last_run_at: None,
            last_error: Some(error.clone()),
            message: Some(error),
        },
    }
}

async fn load_history(session_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || session_persistence::load_llm_history(&session_id))
        .await
        .map_err(|err| format!("MiniCPM history task failed: {err}"))?
        .map_err(|err| format!("MiniCPM history load failed: {err}"))
}

pub(crate) async fn run_once(session_id: &str, mode: RunMode) -> HousekeeperContextCompactionState {
    let Some(runtime_config) = config::current() else {
        return HousekeeperContextCompactionState::unavailable();
    };

    let record = match persistence::load(session_id) {
        Ok(record) => record,
        Err(err) => return error_response(session_id, err),
    };
    if !record.enabled {
        return response_from_record(record, HousekeeperCompactionStatus::Disabled, None);
    }
    match persistence::acquire_run(session_id) {
        Ok(true) => {}
        Ok(false) => {
            let record = persistence::load(session_id).unwrap_or(record);
            return response_from_record(
                record,
                HousekeeperCompactionStatus::Running,
                Some("MiniCPM context maintenance is already running".to_string()),
            );
        }
        Err(err) => return error_response(session_id, err),
    }

    let mut record = match persistence::load(session_id) {
        Ok(record) => record,
        Err(err) => return error_response(session_id, err),
    };
    let history = match load_history(session_id).await {
        Ok(history) => history,
        Err(err) => return error_response(session_id, err),
    };

    let state_matches_history = record.covered_message_count <= history.len()
        && prefix_hash(&history, record.covered_message_count).as_deref()
            == Some(record.covered_prefix_hash.as_str());
    if record.covered_message_count > 0 && !state_matches_history {
        if let Err(err) = persistence::reset_progress(session_id) {
            return error_response(session_id, err);
        }
        record = match persistence::load(session_id) {
            Ok(record) => record,
            Err(err) => return error_response(session_id, err),
        };
    }

    let Some(chunk) = select_next_chunk(
        &history,
        record.covered_message_count,
        (!record.summary.trim().is_empty()).then_some(record.summary.as_str()),
        runtime_config.context_limit_tokens,
        mode,
    ) else {
        if let Err(err) = persistence::mark_idle(session_id) {
            return error_response(session_id, err);
        }
        let record = persistence::load(session_id).unwrap_or(record);
        return response_from_record(
            record,
            HousekeeperCompactionStatus::Idle,
            Some("There is not enough older context to maintain yet".to_string()),
        );
    };

    let segment = history[record.covered_message_count..chunk.end].to_vec();
    let request = key_vault::HousekeeperContextSummaryRequest {
        previous_summary: (!record.summary.trim().is_empty()).then_some(record.summary.clone()),
        history_segment: segment,
        account_id: runtime_config.account_id,
        model: runtime_config.model,
        max_output_tokens: Some(chunk.max_output_tokens),
    };
    let summary_response = match key_vault::summarize_housekeeper_context(request).await {
        Ok(response) => response,
        Err(err) => return error_response(session_id, err),
    };

    if config::current().is_none() {
        let _ = persistence::mark_idle(session_id);
        return HousekeeperContextCompactionState::unavailable();
    }
    match persistence::load(session_id) {
        Ok(latest_record) if !latest_record.enabled => {
            return response_from_record(
                latest_record,
                HousekeeperCompactionStatus::Disabled,
                Some("MiniCPM context maintenance was disabled; result discarded".to_string()),
            );
        }
        Ok(_) => {}
        Err(err) => return error_response(session_id, err),
    }

    let latest_history = match load_history(session_id).await {
        Ok(history) => history,
        Err(err) => return error_response(session_id, err),
    };
    let expected_hash = prefix_hash(&history, chunk.end);
    if expected_hash.is_none() || expected_hash != prefix_hash(&latest_history, chunk.end) {
        let _ = persistence::reset_progress(session_id);
        let record = persistence::load(session_id).unwrap_or_default();
        return response_from_record(
            record,
            HousekeeperCompactionStatus::Idle,
            Some(
                "Conversation changed while MiniCPM was working; the stale result was discarded"
                    .to_string(),
            ),
        );
    }

    let source_tokens = ContextCompactor::estimate_messages_tokens(&history[..chunk.end]);
    let summary_tokens = ContextCompactor::estimate_message_tokens(&summary_message(
        &summary_response.summary,
        chunk.end,
    ));
    if summary_tokens >= source_tokens {
        return error_response(
            session_id,
            format!(
                "MiniCPM summary did not reduce context (source={source_tokens}, summary={summary_tokens})"
            ),
        );
    }

    let Some(covered_prefix_hash) = expected_hash else {
        return error_response(session_id, "Failed to hash summarized history".to_string());
    };
    if let Err(err) = persistence::save_success(
        session_id,
        &summary_response.summary,
        chunk.end,
        &covered_prefix_hash,
        source_tokens,
        summary_tokens,
    ) {
        return error_response(session_id, err);
    }

    tracing::info!(
        "[housekeeper_compaction] session={} covered={} segment_tokens={} source_tokens={} summary_tokens={} model={} account={}",
        session_id,
        chunk.end,
        chunk.segment_tokens,
        source_tokens,
        summary_tokens,
        summary_response.model,
        summary_response.account_id,
    );
    let record = persistence::load(session_id).unwrap_or_default();
    response_from_record(
        record,
        HousekeeperCompactionStatus::Complete,
        Some(format!("MiniCPM maintained {} older messages", chunk.end)),
    )
}

async fn enqueue_explicit(
    session: Arc<AgentSession>,
    session_id: String,
) -> HousekeeperContextCompactionState {
    if session.scheduler.is_processing() || session.scheduler.pending_count() > 0 {
        let record = persistence::load(&session_id).unwrap_or_default();
        return response_from_record(
            record,
            HousekeeperCompactionStatus::Busy,
            Some("The current session is busy; retry when it is idle".to_string()),
        );
    }

    let (result_tx, result_rx) = oneshot::channel();
    let execute_session_id = session_id.clone();
    let enqueue_result = session
        .scheduler
        .enqueue(ScheduledMessage {
            kind: ScheduledKind::Maintenance,
            message_id: format!("minicpm-context-compact-{}", uuid::Uuid::new_v4()),
            generation: 0,
            client_message_id: None,
            turn_intent_id: String::new(),
            content: "[MiniCPM context maintenance]".to_string(),
            execute: Box::new(move || {
                Box::pin(async move {
                    let result = std::panic::AssertUnwindSafe(run_once(
                        &execute_session_id,
                        RunMode::Explicit,
                    ))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|payload| {
                        error_response(
                            &execute_session_id,
                            format!(
                                "MiniCPM context maintenance panicked: {}",
                                crate::session::scheduler::panic_payload_to_string(
                                    payload.as_ref()
                                )
                            ),
                        )
                    });
                    let _ = result_tx.send(result);
                    Ok(String::new())
                })
            }),
        })
        .await;

    if let Err(err) = enqueue_result {
        return error_response(&session_id, err);
    }
    match result_rx.await {
        Ok(result) => result,
        Err(_) => error_response(
            &session_id,
            "MiniCPM context maintenance was cancelled before it ran".to_string(),
        ),
    }
}

pub(crate) async fn run_explicit(
    state: &AgentAppState,
    session_id: String,
) -> HousekeeperContextCompactionState {
    if config::current().is_none() {
        return HousekeeperContextCompactionState::unavailable();
    }
    let record = match persistence::load(&session_id) {
        Ok(record) => record,
        Err(err) => return error_response(&session_id, err),
    };
    if !record.enabled {
        return response_from_record(record, HousekeeperCompactionStatus::Disabled, None);
    }

    match state.get_session(&session_id).await {
        Some(session) => enqueue_explicit(session, session_id).await,
        None => run_once(&session_id, RunMode::Explicit).await,
    }
}

async fn background_tick(state: &AgentAppState) {
    if config::current().is_none() {
        return;
    }

    let candidates = match tokio::task::spawn_blocking(|| {
        persistence::background_candidates(BACKGROUND_CANDIDATE_LIMIT)
    })
    .await
    {
        Ok(Ok(candidates)) => candidates,
        Ok(Err(err)) => {
            tracing::warn!("[housekeeper_compaction] background query failed: {}", err);
            return;
        }
        Err(err) => {
            tracing::warn!(
                "[housekeeper_compaction] background query task failed: {}",
                err
            );
            return;
        }
    };

    for session_id in candidates {
        let Some(session) = state.get_session(&session_id).await else {
            continue;
        };
        if session.scheduler.is_processing() || session.scheduler.pending_count() > 0 {
            continue;
        }

        // Background maintenance deliberately does not occupy the dialog
        // scheduler. It writes only the sidecar table and validates the
        // canonical prefix again before accepting the result, so a newly
        // submitted turn is never delayed by MiniCPM.
        let panic_session_id = session_id.clone();
        let _ = std::panic::AssertUnwindSafe(run_once(&session_id, RunMode::Background))
            .catch_unwind()
            .await
            .unwrap_or_else(|payload| {
                error_response(
                    &panic_session_id,
                    format!(
                        "MiniCPM background context maintenance panicked: {}",
                        crate::session::scheduler::panic_payload_to_string(payload.as_ref())
                    ),
                )
            });
        break;
    }
}

pub fn spawn(state: AgentAppState) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(BACKGROUND_INITIAL_DELAY).await;
        let mut ticker = tokio::time::interval(BACKGROUND_INTERVAL);
        loop {
            ticker.tick().await;
            background_tick(&state).await;
        }
    });
}
