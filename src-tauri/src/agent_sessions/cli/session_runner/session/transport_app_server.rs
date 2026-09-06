//! Codex app-server transport: long-lived JSON-RPC turn over stdio.
//!
//! Native continuation episodes opt into this transport explicitly. Ordinary
//! Codex sessions retain the established per-turn `codex exec --json` path.

use tokio::process::Child;

use crate::api::websocket_handler;

use super::super::super::persistence;
use super::super::helpers::{emit_chunk, snapshot_cli_file_edit};
use super::super::launch_profiles::ResolvedCliLaunchProfile;
use super::super::oauth_setup::{
    is_cli_chunk_replay_unsafe, is_cli_oauth_failure_message, is_retryable_cli_oauth_failure_chunk,
};

pub(super) struct AppServerOutcome {
    pub(super) exit_code: i32,
    pub(super) timed_out: bool,
    pub(super) cli_session_id_out: Option<String>,
    pub(super) codex_app_server_turn_ok: bool,
    pub(super) retryable_oauth_message: Option<String>,
    pub(super) terminal_error_message: Option<String>,
}

fn is_successful_turn_status(status: &str) -> bool {
    status == "completed"
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_codex_app_server_branch(
    mut child: Child,
    session_id: String,
    account_id: Option<&str>,
    oauth_retry_eligible: bool,
    user_input: String,
    developer_instructions: Option<String>,
    working_dir: &str,
    cli_resume_id: Option<String>,
    model: Option<&str>,
    launch_profile: &ResolvedCliLaunchProfile,
    config: Option<serde_json::Value>,
    image_paths: Vec<String>,
    session_timeout: tokio::time::Duration,
    pre_message_snapshot_id: Option<String>,
    snapshot_working_dir: String,
    mut cli_session_id_out: Option<String>,
    sequence: &mut i64,
    mut codex_app_server_turn_ok: bool,
    attempt_stderr: &mut super::CliStderrCollector,
    allow_native_context_recovery: bool,
) -> Result<AppServerOutcome, String> {
    // ── Codex app-server: long-lived JSON-RPC over stdio ──
    // The resolved launch profile may explicitly select the legacy exec path.
    // Same CODEX_HOME / auth env as the exec shell-out — the spawn
    // above already carries env_vars.
    use crate::agent_sessions::cli::parsers::codex_app_server;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stdin = child.stdin.take().expect("stdin was piped for app-server");
    let (chunk_tx, mut chunk_rx) =
        tokio::sync::mpsc::channel::<core_types::activity::ActivityChunk>(256);

    let turn = codex_app_server::CodexAppServerTurn {
        session_id: session_id.clone(),
        user_input,
        developer_instructions,
        working_dir: working_dir.to_string(),
        resume_thread_id: cli_resume_id.clone(),
        model: super::super::command::codex_app_server_thread_model(model),
        permission_mode: launch_profile.permission_mode,
        config,
        image_paths: image_paths.clone(),
        allow_native_context_recovery,
    };
    let mut app_server_handle = tokio::spawn(async move {
        codex_app_server::run_app_server_turn(stdin, stdout, turn, chunk_tx).await
    });

    let mut retryable_oauth_message = None;
    let mut replay_unsafe_output_seen = false;
    let mut terminal_error_message = None;
    let timeout_result = tokio::time::timeout(session_timeout, async {
        while let Some(chunk) = chunk_rx.recv().await {
            if retryable_oauth_message.is_none() && !replay_unsafe_output_seen {
                retryable_oauth_message =
                    is_retryable_cli_oauth_failure_chunk(oauth_retry_eligible, &chunk);
            }
            if retryable_oauth_message.is_some() {
                // Suppress the failed attempt. The outer runner will refresh
                // and replay only when no assistant/tool output was emitted.
                continue;
            }
            super::record_terminal_cli_error(&mut terminal_error_message, &chunk);
            if is_cli_chunk_replay_unsafe(&chunk) {
                replay_unsafe_output_seen = true;
            }
            // Bind the rollout-compatible thread id as soon as a lifecycle
            // chunk carries it (mirrors the parser early-binding in the exec
            // branch below). Context recovery may natively fork the thread
            // inside this same transport turn, so a DIFFERENT id must replace
            // the initial binding immediately; otherwise an instant follow-up
            // can resume the overflowing source UUID and compact again.
            if let Some(ref tid) = chunk.thread_id {
                if cli_session_id_out.as_deref() != Some(tid.as_str()) {
                    cli_session_id_out = Some(tid.clone());
                    if let Err(err) =
                        persistence::update_cli_session_id_for_account(&session_id, account_id, tid)
                    {
                        tracing::warn!(
                            "[CodeSession] Failed to bind early cli_session_id: {}",
                            err
                        );
                    }
                    websocket_handler::broadcast(
                        serde_json::json!({
                            "type": "code_session.cli_session_bound",
                            "session_id": session_id,
                            "cli_session_id": tid,
                        })
                        .to_string(),
                    );
                }
            }
            if let Some(snap_id) = &pre_message_snapshot_id {
                snapshot_cli_file_edit(&session_id, snap_id, &chunk, &snapshot_working_dir).await;
            }
            emit_chunk(&chunk, &session_id, sequence).await;
        }
    })
    .await;
    let mut timed_out = timeout_result.is_err();
    if timed_out {
        app_server_handle.abort();
        terminal_error_message = Some("Codex app-server turn timed out".to_string());
    }

    // The chunk channel normally closes only after the protocol task exits,
    // but a leaked sender or stuck cleanup must not turn the four-hour turn
    // deadline into an unbounded JoinHandle wait.
    let join_result =
        tokio::time::timeout(tokio::time::Duration::from_secs(5), &mut app_server_handle).await;
    if join_result.is_err() {
        timed_out = true;
        codex_app_server_turn_ok = false;
        terminal_error_message = Some("Codex app-server shutdown timed out".to_string());
        app_server_handle.abort();
    }

    match join_result {
        Ok(Ok(Ok(result))) if !timed_out => {
            cli_session_id_out = Some(result.thread_id);
            codex_app_server_turn_ok = is_successful_turn_status(&result.turn_status);
            if let Some(ref usage) = result.usage {
                let round_model = usage.model.as_deref().or(model);
                if let Err(err) = session_persistence::token_usage::insert_token_usage_record(
                    &session_id,
                    "code",
                    round_model,
                    account_id,
                    usage.input_tokens as i64,
                    usage.output_tokens as i64,
                    usage.cache_read_tokens as i64,
                    usage.cache_write_tokens as i64,
                    usage.total_tokens as i64,
                    0,
                    None,
                ) {
                    tracing::warn!(
                        "[CodeSession] Failed to insert per-round token usage: {}",
                        err
                    );
                }
            }
        }
        Ok(Ok(Err(err))) if !timed_out => {
            if oauth_retry_eligible
                && !replay_unsafe_output_seen
                && is_cli_oauth_failure_message(&err)
            {
                retryable_oauth_message = Some(err);
            } else {
                tracing::error!("[CodeSession] app-server protocol error: {}", err);
                terminal_error_message =
                    Some(super::super::super::parsers::canonicalize_cli_error_message(&err));
            }
        }
        Ok(Err(join_err)) if !timed_out => {
            tracing::error!("[CodeSession] app-server task panicked: {}", join_err);
            terminal_error_message = Some(format!("Codex app-server task failed: {join_err}"));
        }
        _ => {}
    }

    // The app-server process is long-lived and never exits on its
    // own — the turn is over, so tear it down like the ACP branch.
    if let Some(pid) = child.id() {
        super::super::lifecycle::terminate_process_tree(pid as i64, &session_id).await;
    } else {
        let _ = child.kill().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|err| format!("Wait error: {}", err))?;
    let exit_code = status.code().unwrap_or(-1);

    // The child is gone; collect the rest of its stderr before the OAuth probe
    // below reads it.
    attempt_stderr.drain().await;

    if retryable_oauth_message.is_none()
        && oauth_retry_eligible
        && !timed_out
        && !codex_app_server_turn_ok
        && !replay_unsafe_output_seen
    {
        let stderr = attempt_stderr.lines();
        let stderr = stderr.lock().await;
        retryable_oauth_message = stderr
            .iter()
            .find(|line| is_cli_oauth_failure_message(line))
            .cloned();
    }

    Ok(AppServerOutcome {
        exit_code,
        timed_out,
        cli_session_id_out,
        codex_app_server_turn_ok,
        retryable_oauth_message,
        terminal_error_message,
    })
}

#[cfg(test)]
mod tests {
    use super::is_successful_turn_status;

    #[test]
    fn only_completed_app_server_turns_succeed() {
        assert!(is_successful_turn_status("completed"));
        assert!(!is_successful_turn_status("failed"));
        assert!(!is_successful_turn_status("interrupted"));
        assert!(!is_successful_turn_status("cancelled"));
    }
}
