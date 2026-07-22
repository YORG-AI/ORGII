//! Post-run finalization for CLI sessions.
//!
//! Everything after the spawn/stdout loop returns: compute the final session
//! status, extract a user-facing error message from stderr, persist status,
//! clear live-status, requeue Agent Org member turns, broadcast the terminal
//! event, commit worktree changes, fetch Cursor usage, and tear down the MITM
//! proxy / proxy token / synced skill files. Extracted from
//! `session::run_session`.

use std::collections::VecDeque;
use std::sync::Arc;

use tokio::sync::Mutex;

use key_vault::key_store::{ModelType, KEY_SERVICE};

use super::super::persistence::{self, CodeSession};
use super::super::types::{KeySource, SessionStatus};
use super::cursor_usage::fetch_cursor_usage_for_session;
use super::helpers::{clear_live_status, flush_and_broadcast};
use super::oauth_setup::is_cli_oauth_failure_message;
use super::proxy_release::release_proxy_token_for_session;
use super::token_sync::sync_codex_cli_auth_to_key_vault;
use crate::api::websocket_handler;

/// Outcome of the spawn/stdout loop, consumed by [`finalize_session_run`].
pub(super) struct SessionRunOutcome {
    pub exit_code: i32,
    pub cli_session_id_out: Option<String>,
    pub cli_plan_approval_gate_reached: bool,
    /// App-server transport: whether the turn reached a non-failed
    /// `turn/completed`.
    pub codex_app_server_turn_ok: bool,
    pub suppressed_oauth_error: Option<String>,
    pub stderr_lines: Arc<Mutex<VecDeque<String>>>,
}

/// Finalize a completed (or timed-out) session run: derive and persist the
/// terminal status, surface an error message, run the terminal-transition
/// side effects, and release per-session resources.
#[allow(clippy::too_many_arguments)]
pub(super) async fn finalize_session_run(
    session: &CodeSession,
    agent: &ModelType,
    env_vars: &std::collections::HashMap<String, String>,
    run_started_at: chrono::DateTime<chrono::Utc>,
    needs_mitm: bool,
    use_codex_app_server: bool,
    is_acp_agent: bool,
    synced_rule_files: &[std::path::PathBuf],
    turn_intent_id: Option<&str>,
    outcome: SessionRunOutcome,
) {
    let SessionRunOutcome {
        exit_code,
        cli_session_id_out,
        cli_plan_approval_gate_reached,
        codex_app_server_turn_ok,
        suppressed_oauth_error,
        stderr_lines,
    } = outcome;

    let session_id = session.session_id.as_str();
    let account_id = session.account_id.as_deref();

    let setup_is_codex_own_key =
        *agent == ModelType::Codex && session.key_source == KeySource::OwnKey;
    let setup_access_token = env_vars.get("OPENAI_API_KEY").cloned();
    let setup_account_id = account_id.map(str::to_string);
    let setup_session_id = session_id.to_string();
    let setup_cli_session_id = cli_session_id_out.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if setup_is_codex_own_key {
            if let Err(err) = sync_codex_cli_auth_to_key_vault(
                setup_account_id.as_deref(),
                setup_access_token.as_deref(),
            ) {
                tracing::warn!(
                    "[CodeSession] Failed to sync Codex CLI auth tokens: {}",
                    err
                );
            }
            if exit_code == 0 {
                if let Some(account_id) = setup_account_id.as_deref() {
                    if let Err(err) = KEY_SERVICE.reset_oauth_refresh_failures(account_id) {
                        tracing::warn!(
                            "[CodeSession] Failed to reset Codex OAuth refresh failures: {}",
                            err
                        );
                    }
                }
            }
        }
        if let Some(cli_session_id) = setup_cli_session_id.as_deref() {
            persistence::update_cli_session_id_for_account(
                &setup_session_id,
                setup_account_id.as_deref(),
                cli_session_id,
            )
            .ok();
        }
    })
    .await;

    let raw_final_status = if cli_plan_approval_gate_reached {
        SessionStatus::Completed
    } else if use_codex_app_server {
        // exit_code is meaningless here — we kill the long-lived server
        // after the turn; success is the turn/completed outcome.
        if codex_app_server_turn_ok {
            SessionStatus::Completed
        } else {
            SessionStatus::Failed
        }
    } else if is_acp_agent {
        if cli_session_id_out.is_some() {
            SessionStatus::Completed
        } else {
            SessionStatus::Failed
        }
    } else if exit_code == 0 {
        SessionStatus::Completed
    } else {
        SessionStatus::Failed
    };

    // CLI member sessions inside an Agent Org run must land on `Idle` after each
    // successful turn so they remain available for the next coordinator dispatch.
    // `Completed` is terminal (is_terminal() == true) and would cause
    // `reconcile_run_finality` to prematurely end the run.
    let is_org_member = session.org_member_id.is_some();
    let final_status = if raw_final_status == SessionStatus::Completed && is_org_member {
        SessionStatus::Idle
    } else {
        raw_final_status
    };

    let error_message: Option<String> = if final_status == SessionStatus::Failed {
        if let Some(message) = suppressed_oauth_error.clone() {
            Some(message)
        } else {
            let buf = stderr_lines.lock().await;
            let meaningful: Vec<&str> = buf
                .iter()
                .map(|s| s.as_str())
                .filter(|line| {
                    let lower = line.to_lowercase();
                    lower.contains("error")
                        || lower.contains("fatal")
                        || lower.contains("panic")
                        || lower.contains("fail")
                        || lower.contains("exception")
                        || lower.contains("timed out")
                        || lower.contains("timeout")
                        || lower.contains("refused")
                        || lower.contains("denied")
                        || lower.contains("not found")
                        || lower.contains("refresh token")
                        || lower.contains("access token")
                        || lower.contains("oauth")
                        || lower.contains("unauthorized")
                        || lower.contains("not authenticated")
                        || lower.contains("authentication")
                        || lower.contains("login required")
                        || lower.contains("please log in")
                        || lower.contains("please login")
                        || lower.contains("revoked")
                        || lower.contains("invalid_grant")
                })
                .collect();
            if meaningful.is_empty() {
                buf.back().map(|s| s.to_string())
            } else {
                Some(meaningful.join("\n"))
            }
        }
    } else {
        None
    };

    let should_record_oauth_failure = *agent == ModelType::Codex
        && session.key_source == KeySource::OwnKey
        && error_message
            .as_deref()
            .is_some_and(is_cli_oauth_failure_message);

    let persist_session_id = session_id.to_string();
    let persist_error_message = error_message.clone();
    let persist_turn_intent_id = turn_intent_id.map(str::to_string);
    let persist_account_id = account_id.map(str::to_string);
    let persist_result = tokio::task::spawn_blocking(move || {
        if should_record_oauth_failure {
            if let (Some(account_id), Some(error_message)) = (
                persist_account_id.as_deref(),
                persist_error_message.as_deref(),
            ) {
                if let Err(err) =
                    KEY_SERVICE.record_oauth_refresh_failure(account_id, error_message)
                {
                    tracing::warn!(
                        "[CodeSession] Failed to record Codex OAuth refresh failure: {}",
                        err
                    );
                }
            }
        }
        let intent_status = persist_turn_intent_id.as_deref().map(|turn_intent_id| {
            (
                turn_intent_id,
                if raw_final_status == SessionStatus::Completed {
                    session_persistence::turn_intents::TurnIntentStatus::Completed
                } else {
                    session_persistence::turn_intents::TurnIntentStatus::Failed
                },
            )
        });
        persistence::update_cli_turn_lifecycle(
            &persist_session_id,
            final_status,
            persist_error_message.as_deref(),
            intent_status,
        )
    })
    .await;
    if let Err(err) = persist_result
        .map_err(|join_err| join_err.to_string())
        .and_then(|result| result)
    {
        tracing::error!("[CodeSession] Failed to persist final lifecycle: {}", err);
    }

    if final_status.is_terminal() {
        clear_live_status(agent, session_id, cli_session_id_out.as_deref());
    }

    // For CLI sessions that are Agent Org members, requeue any in-progress work
    // and notify the coordinator that this member is idle/available. This mirrors
    // the Rust-native member path in `agent_core::lifecycle::finalize_session`.
    // app_handle is unavailable in the CLI runner, so inbox-wake via AppHandle is
    // skipped (fire-and-forget; the coordinator will drain on its next turn boundary).
    if is_org_member {
        let outcome: Result<String, String> = if error_message.is_none() {
            Ok(String::new())
        } else {
            Err(error_message
                .as_deref()
                .unwrap_or("unknown error")
                .to_string())
        };
        agent_core::lifecycle::finalize_agent_org_member_turn(None, session_id, &outcome);
    }

    // Flush any pending streaming deltas before signaling session end
    flush_and_broadcast(session_id).await;

    let mut status_msg = serde_json::json!({
        "type": "code_session.status_changed",
        "session_id": session_id,
        "status": final_status.as_ref(),
        "exit_code": exit_code,
        "background": session.background,
        "session_name": session.name,
    });
    if let Some(ref err_msg) = error_message {
        status_msg["error_message"] = serde_json::Value::String(err_msg.clone());
    }
    if let Some(turn_intent_id) = turn_intent_id {
        status_msg["turn_intent_id"] = serde_json::Value::String(turn_intent_id.to_string());
    }
    websocket_handler::broadcast(status_msg.to_string());

    // ── Worktree: commit changes on completion ──
    if raw_final_status == SessionStatus::Completed {
        if let Some(ref wt_repo_path) = session.repo_path {
            if session.worktree_path.is_some() {
                let repo = std::path::PathBuf::from(wt_repo_path);
                let wt_sid = session_id.to_string();
                let _ =
                    tokio::task::spawn_blocking(
                        move || match git::worktree::commit_worktree_changes(&repo, &wt_sid) {
                            Ok(true) => {
                                tracing::info!(
                                    "[CodeSession] Committed worktree changes for session {}",
                                    wt_sid
                                );
                            }
                            Ok(false) => {
                                tracing::info!(
                                "[CodeSession] No uncommitted changes in worktree for session {}",
                                wt_sid
                            );
                            }
                            Err(err) => {
                                tracing::warn!(
                                    "[CodeSession] Failed to commit worktree changes: {}",
                                    err
                                );
                            }
                        },
                    )
                    .await;
            }
        }
    }

    // ── Cursor: fetch token usage from Dashboard API ──
    if *agent == ModelType::CursorCli && raw_final_status == SessionStatus::Completed {
        let sid = session_id.to_string();
        let acc_id = session.account_id.clone();

        tokio::spawn(async move {
            fetch_cursor_usage_for_session(&sid, acc_id.as_deref(), run_started_at).await;
        });
    }

    if needs_mitm {
        integrations::proxy::server::stop_session_proxy(session_id).await;
        tracing::info!(
            "[CodeSession] Stopped per-session MITM proxy for session {}",
            session_id
        );
    }

    release_proxy_token_for_session(session_id).await;

    super::super::skill_sync::cleanup_synced_skill_files(synced_rule_files);
}
