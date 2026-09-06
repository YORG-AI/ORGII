//! Post-run finalization for CLI sessions.
//!
//! Everything after the spawn/stdout loop returns: compute the final session
//! status, extract a user-facing error message from stderr, flush and publish
//! provider-native history, persist status, clear live-status, requeue Agent
//! Org member turns, broadcast the terminal event, commit worktree changes,
//! fetch Cursor usage, and tear down the MITM proxy / proxy token / synced
//! skill files. Extracted from
//! `session::run_session`.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use tokio::sync::Mutex;

use key_vault::key_store::{ModelType, KEY_SERVICE};

use super::super::parsers::{canonicalize_cli_error_message, is_codex_fallback_metadata_notice};
use super::super::persistence::{self, CodeSession};
use super::super::types::SessionStatus;
use super::cursor_usage::fetch_cursor_usage_for_session;
use super::helpers::{clear_live_status, flush_and_broadcast};
use super::oauth_setup::is_cli_oauth_failure_message;
use super::proxy_release::release_proxy_token_for_session;
use super::token_sync::sync_codex_cli_auth_to_key_vault;
use crate::api::websocket_handler;

const CURSOR_HISTORY_READY_ATTEMPTS: usize = 3;
const CURSOR_HISTORY_READY_RETRY_MS: u64 = 100;

fn normalized_total_tokens(input_tokens: u64, output_tokens: u64, reported_total: u64) -> u64 {
    if reported_total > 0 {
        reported_total
    } else {
        input_tokens.saturating_add(output_tokens)
    }
}

fn cursor_cli_history_changed_message(
    session_id: &str,
    history_session_id: &str,
    turn_intent_id: Option<&str>,
) -> serde_json::Value {
    let mut message = serde_json::json!({
        "type": "code_session.history_changed",
        "session_id": session_id,
        "history_session_id": history_session_id,
        "source": "cursor_cli",
        "status": "turn_settled",
    });
    if let Some(turn_intent_id) = turn_intent_id {
        message["turn_intent_id"] = serde_json::Value::String(turn_intent_id.to_string());
    }
    message
}

/// Advertise replay invalidation only after the provider-owned Cursor store
/// is bound to the managed id and its current meta/root manifest can be read.
async fn notify_cursor_cli_history_changed_when_readable(
    session_id: &str,
    turn_intent_id: Option<&str>,
) {
    let managed_session_id = session_id.to_string();
    let history_session_id = match tokio::task::spawn_blocking(move || {
        super::super::native_transcript::imported_transcript_id_for_managed_session(
            &managed_session_id,
        )
    })
    .await
    {
        Ok(Some(history_session_id)) => history_session_id,
        Ok(None) => {
            tracing::warn!(
                session_id,
                "Cursor CLI turn settled without a persisted native transcript binding"
            );
            return;
        }
        Err(err) => {
            tracing::warn!(
                session_id,
                error = %err,
                "Cursor CLI native transcript binding probe failed"
            );
            return;
        }
    };

    for attempt in 0..CURSOR_HISTORY_READY_ATTEMPTS {
        match crate::orgtrack::history_commands::cursor_cli_history_is_readable(
            history_session_id.clone(),
        )
        .await
        {
            Ok(true) => {
                websocket_handler::broadcast(
                    cursor_cli_history_changed_message(
                        session_id,
                        &history_session_id,
                        turn_intent_id,
                    )
                    .to_string(),
                );
                return;
            }
            Ok(false) => {}
            Err(err) => tracing::debug!(
                session_id,
                history_session_id,
                attempt,
                error = %err,
                "Cursor CLI transcript is not readable yet"
            ),
        }
        if attempt + 1 < CURSOR_HISTORY_READY_ATTEMPTS {
            tokio::time::sleep(tokio::time::Duration::from_millis(
                CURSOR_HISTORY_READY_RETRY_MS,
            ))
            .await;
        }
    }

    tracing::warn!(
        session_id,
        history_session_id,
        "Cursor CLI turn settled but its provider transcript remained unreadable"
    );
}

/// Outcome of the spawn/stdout loop, consumed by [`finalize_session_run`].
pub(super) struct SessionRunOutcome {
    pub exit_code: i32,
    pub cli_session_id_out: Option<String>,
    pub cli_plan_approval_gate_reached: bool,
    /// App-server transport: whether the turn reached a non-failed
    /// `turn/completed`.
    pub codex_app_server_turn_ok: bool,
    /// OAuth error that is terminal after refresh failed or the one retry was
    /// exhausted. A successfully refreshed first-attempt error is never kept.
    pub terminal_oauth_error: Option<String>,
    /// Structured error emitted by the CLI transport. This is authoritative
    /// over stderr, which may contain only launch/progress notices.
    pub terminal_error_message: Option<String>,
    pub stderr_lines: Arc<Mutex<VecDeque<String>>>,
}

fn work_item_run_usage_since(
    session_id: &str,
    run_started_at: chrono::DateTime<chrono::Utc>,
) -> project_management::projects::types::WorkItemRunUsage {
    let records = match session_persistence::token_usage::get_token_usage_records(session_id) {
        Ok(records) => records,
        Err(err) => {
            tracing::warn!(
                session_id,
                error = %err,
                "failed to load CLI usage for WorkItemRun finalization"
            );
            return Default::default();
        }
    };
    let mut usage = project_management::projects::types::WorkItemRunUsage::default();
    for record in records {
        let belongs_to_turn = chrono::DateTime::parse_from_rfc3339(&record.created_at)
            .map(|created_at| created_at.with_timezone(&chrono::Utc) >= run_started_at)
            .unwrap_or(false);
        if !belongs_to_turn {
            continue;
        }
        let input_tokens = u64::try_from(record.input_tokens).unwrap_or(0);
        let output_tokens = u64::try_from(record.output_tokens).unwrap_or(0);
        usage.input_tokens = usage.input_tokens.saturating_add(input_tokens);
        usage.output_tokens = usage.output_tokens.saturating_add(output_tokens);
        usage.cache_read_tokens = usage
            .cache_read_tokens
            .saturating_add(u64::try_from(record.cache_read_tokens).unwrap_or(0));
        usage.cache_write_tokens = usage
            .cache_write_tokens
            .saturating_add(u64::try_from(record.cache_write_tokens).unwrap_or(0));
        usage.total_tokens = usage.total_tokens.saturating_add(normalized_total_tokens(
            input_tokens,
            output_tokens,
            u64::try_from(record.total_tokens).unwrap_or(0),
        ));
    }
    usage
}

fn is_meaningful_stderr_line(line: &str) -> bool {
    // Keep this fallback in step with what the structured parsers suppress.
    // `not found` below would otherwise re-promote a notice the parser
    // deliberately dropped into the persisted failure message.
    if is_codex_fallback_metadata_notice(line) {
        return false;
    }

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
}

/// Collapse retry diagnostics into one persisted error string. Structured CLI
/// logs prefix every retry with a fresh timestamp, so exact-line dedup alone
/// still rendered the same failure many times.
pub(super) fn summarize_cli_stderr(stderr_lines: &VecDeque<String>) -> Option<String> {
    let mut seen = HashSet::new();
    let mut meaningful = Vec::new();

    for line in stderr_lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && is_meaningful_stderr_line(line))
    {
        let diagnostic = [" ERROR ", " WARN ", " FATAL "]
            .iter()
            .find_map(|marker| line.find(marker).map(|index| &line[index + marker.len()..]))
            .unwrap_or(line)
            .trim();
        let diagnostic = canonicalize_cli_error_message(diagnostic);
        if seen.insert(diagnostic.clone()) {
            meaningful.push(diagnostic);
        }
    }

    if meaningful.is_empty() {
        // Nothing looked like a failure. Fall back to the last real line, but
        // still never to a notice the parser deliberately suppressed —
        // otherwise the filter above only holds while some *other* line
        // happens to match, which is not a property worth having.
        stderr_lines
            .iter()
            .rev()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !is_codex_fallback_metadata_notice(line))
            .map(str::to_string)
    } else {
        Some(meaningful.join("\n"))
    }
}

pub(super) fn resolve_cli_failure_message(
    terminal_oauth_error: Option<String>,
    terminal_error_message: Option<String>,
    stderr_lines: &VecDeque<String>,
) -> Option<String> {
    terminal_oauth_error
        .or(terminal_error_message)
        .or_else(|| summarize_cli_stderr(stderr_lines))
}

/// Finalize a completed (or timed-out) session run: derive and persist the
/// terminal status, surface an error message, run the terminal-transition
/// side effects, and release per-session resources.
#[allow(clippy::too_many_arguments)]
pub(super) async fn finalize_session_run(
    session: &CodeSession,
    agent: &ModelType,
    oauth_retry_eligible: bool,
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
        terminal_oauth_error,
        terminal_error_message,
        stderr_lines,
    } = outcome;

    let session_id = session.session_id.as_str();
    let account_id = session.account_id.as_deref();

    let setup_is_codex_oauth = *agent == ModelType::Codex && oauth_retry_eligible;
    let setup_access_token = env_vars.get("OPENAI_API_KEY").cloned();
    let setup_account_id = account_id.map(str::to_string);
    let setup_session_id = session_id.to_string();
    let setup_cli_session_id = cli_session_id_out.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if setup_is_codex_oauth {
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

    let mut raw_final_status = if cli_plan_approval_gate_reached {
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
    // A CLI that exhausted its context can exit 0 while its result frame
    // reports `terminal_reason: prompt_too_long`. Demote the false success
    // so the run records the overflow and the next wake starts fresh.
    raw_final_status = if raw_final_status == SessionStatus::Completed
        && terminal_error_message
            .as_deref()
            .is_some_and(app_utils::runtime_errors::is_context_exhausted_message)
    {
        SessionStatus::Failed
    } else {
        raw_final_status
    };
    // CLI member sessions inside an Agent Org run must land on `Idle` after each
    // successful turn so they remain available for the next coordinator dispatch.
    // `Completed` is terminal (is_terminal() == true) and would cause
    // `reconcile_run_finality` to prematurely end the run.
    let is_org_member = session.org_member_id.is_some();
    let mut final_status = if raw_final_status == SessionStatus::Completed && is_org_member {
        SessionStatus::Idle
    } else {
        raw_final_status
    };

    let mut error_message: Option<String> = if final_status == SessionStatus::Failed {
        let buf = stderr_lines.lock().await;
        resolve_cli_failure_message(terminal_oauth_error.clone(), terminal_error_message, &buf)
    } else {
        None
    };
    // Native providers write the selected profile directly. Flushing final
    // deltas is the only terminal persistence boundary.
    flush_and_broadcast(session_id).await;

    // Converge the provider-written file before publishing the terminal
    // lifecycle. Consumers may start the next runtime as soon as that durable
    // status is visible, so the exact native transcript/alias must already be
    // authoritative. Only the best-effort App catalog refresh is deferred.
    if let Err(error) =
        super::super::native_materializer::converge_bound_native_transcript_and_schedule_catalog(
            session_id,
        )
        .await
    {
        let convergence_error =
            format!("Provider-native transcript could not be finalized safely: {error}");
        tracing::error!(
            session_id,
            error = %error,
            "failing terminal lifecycle because provider-native transcript did not converge"
        );
        raw_final_status = SessionStatus::Failed;
        final_status = SessionStatus::Failed;
        error_message = Some(convergence_error);
    }

    if raw_final_status == SessionStatus::Failed {
        super::input_assembly::forget_session_context(session_id);
    }

    super::harness_hooks::finish_turn(
        session_id,
        agent,
        session.model.as_deref(),
        session
            .worktree_path
            .as_deref()
            .filter(|path| !path.is_empty() && std::path::Path::new(path).is_dir())
            .or(session.repo_path.as_deref()),
        final_status.as_ref(),
        exit_code,
    )
    .await;

    let should_record_oauth_failure = *agent == ModelType::Codex
        && oauth_retry_eligible
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

    let durable_run_id = turn_intent_id
        .filter(|turn_intent_id| turn_intent_id.starts_with("wir_"))
        .map(str::to_string);

    // Cursor usage is fetched from its dashboard after process exit. Await it
    // for a durable turn so the immutable Run receipt is not finalized with a
    // permanent zero while the Session total updates a few seconds later.
    if *agent == ModelType::CursorCli
        && raw_final_status == SessionStatus::Completed
        && durable_run_id.is_some()
    {
        fetch_cursor_usage_for_session(session_id, account_id, run_started_at).await;
    }

    if let Some(run_id) = durable_run_id.as_deref() {
        let usage = work_item_run_usage_since(session_id, run_started_at);
        let outcome = match raw_final_status {
            SessionStatus::Completed | SessionStatus::Idle => {
                project_management::work_run_service::WorkItemRunTerminalOutcome::Succeeded
            }
            SessionStatus::Cancelled => {
                project_management::work_run_service::WorkItemRunTerminalOutcome::Cancelled
            }
            SessionStatus::Pending | SessionStatus::Running | SessionStatus::Failed => {
                project_management::work_run_service::WorkItemRunTerminalOutcome::Failed
            }
        };
        let terminal_run_id = run_id.to_string();
        let terminal_session_id = session_id.to_string();
        let terminal_error = error_message.clone();
        match tokio::task::spawn_blocking(move || {
            project_management::work_run_service::record_run_terminal(
                &terminal_run_id,
                Some(&terminal_session_id),
                outcome,
                usage,
                terminal_error.as_deref(),
            )
        })
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => tracing::error!(
                session_id,
                run_id,
                error = %err,
                "failed to persist CLI WorkItemRun terminal"
            ),
            Err(err) => tracing::error!(
                session_id,
                run_id,
                error = %err,
                "CLI WorkItemRun terminal task failed"
            ),
        }
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

    let mut status_msg = serde_json::json!({
        "type": "code_session.status_changed",
        "session_id": session_id,
        "status": final_status.as_ref(),
        "exit_code": exit_code,
        "background": session.background,
        "session_name": session.name,
        "plan_gate": cli_plan_approval_gate_reached,
    });
    if let Some(ref err_msg) = error_message {
        status_msg["error_message"] = serde_json::Value::String(err_msg.clone());
    }
    if let Some(turn_intent_id) = turn_intent_id {
        status_msg["turn_intent_id"] = serde_json::Value::String(turn_intent_id.to_string());
    }
    websocket_handler::broadcast(status_msg.to_string());

    // The generic terminal status preserves the existing lifecycle contract,
    // but it is not a replay-readiness barrier: Cursor may commit the provider
    // transcript through SQLite/WAL independently of ORGII's stream flush.
    // Advertise the dedicated history invalidation only after that transcript
    // and its managed-session binding are both readable.
    if *agent == ModelType::CursorCli {
        notify_cursor_cli_history_changed_when_readable(session_id, turn_intent_id).await;
    }

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
    if *agent == ModelType::CursorCli
        && raw_final_status == SessionStatus::Completed
        && durable_run_id.is_none()
    {
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

#[cfg(test)]
mod usage_tests {
    use super::{cursor_cli_history_changed_message, normalized_total_tokens};

    #[test]
    fn reported_total_wins_when_present() {
        assert_eq!(normalized_total_tokens(10, 20, 25), 25);
    }

    #[test]
    fn missing_total_is_derived_from_input_and_output() {
        assert_eq!(normalized_total_tokens(91_133, 1_876, 0), 93_009);
    }

    #[test]
    fn cursor_history_changed_event_is_session_scoped_and_turn_settled() {
        let message = cursor_cli_history_changed_message(
            "cliagent-managed",
            "cursorcliapp-native",
            Some("intent-1"),
        );

        assert_eq!(
            message,
            serde_json::json!({
                "type": "code_session.history_changed",
                "session_id": "cliagent-managed",
                "history_session_id": "cursorcliapp-native",
                "source": "cursor_cli",
                "status": "turn_settled",
                "turn_intent_id": "intent-1",
            })
        );
    }

    #[test]
    fn cursor_history_changed_event_omits_absent_turn_intent() {
        let message =
            cursor_cli_history_changed_message("cliagent-managed", "cursorcliapp-native", None);

        assert!(message.get("turn_intent_id").is_none());
        assert_eq!(message["session_id"], "cliagent-managed");
        assert_eq!(message["history_session_id"], "cursorcliapp-native");
    }
}
