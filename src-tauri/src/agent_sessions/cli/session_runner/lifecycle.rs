//! Session lifecycle management — kill, cancel, cleanup.

use super::super::persistence::{self, CodeSession};
use super::super::types::SessionStatus;
use super::helpers::{flush_cli_streams_for_session, RUNNING_SESSIONS};
use agent_core::state::control_flow::CancelReason;

#[cfg(unix)]
fn signal_process_tree(pid: i64, signal: libc::c_int) -> bool {
    let pid = pid as libc::pid_t;
    let group_result = unsafe { libc::kill(-pid, signal) };
    if group_result == 0 {
        return true;
    }

    unsafe { libc::kill(pid, signal) == 0 }
}

#[cfg(unix)]
fn process_tree_exists(pid: i64) -> bool {
    let pid = pid as libc::pid_t;
    unsafe { libc::kill(-pid, 0) == 0 || libc::kill(pid, 0) == 0 }
}

#[cfg(unix)]
pub async fn terminate_process_tree(pid: i64, label: &str) {
    let term_result = signal_process_tree(pid, libc::SIGTERM);
    if !term_result {
        return;
    }

    // Poll instead of one flat 3s sleep: the CLI usually dies within a few
    // hundred ms, and every extra ms here delays the `cancelled` terminal
    // the frontend is blocked on.
    const SIGTERM_GRACE_MS: u64 = 3_000;
    const POLL_INTERVAL_MS: u64 = 100;
    let mut waited = 0;
    while waited < SIGTERM_GRACE_MS {
        tokio::time::sleep(tokio::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
        waited += POLL_INTERVAL_MS;
        if !process_tree_exists(pid) {
            return;
        }
    }
    tracing::info!(
        "[CodeSession] {} PID/group {} still alive after SIGTERM grace period, sending SIGKILL",
        label,
        pid
    );
    signal_process_tree(pid, libc::SIGKILL);
}

#[cfg(windows)]
pub async fn terminate_process_tree(pid: i64, _label: &str) {
    let mut command = tokio::process::Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    // Suppress the `taskkill` console window.
    command.creation_flags(app_platform::CREATE_NO_WINDOW);
    let _ = command.output().await;
}

/// Kill the running agent for a session: abort Tokio task, kill OS process, stop proxy.
///
/// This is the low-level cleanup function. It does NOT update the session status
/// in the database — callers are responsible for setting the appropriate final status
/// (e.g., Cancelled for user cancel, or nothing before a re-run).
pub async fn kill_running_agent(session_id: &str) -> bool {
    let running_task = {
        let mut sessions = RUNNING_SESSIONS.lock().await;
        sessions.remove(session_id)
    };
    let had_running_task = running_task.is_some();
    if let Some(handle) = running_task {
        // The flush can touch SQLite. Never hold the global runner registry
        // lock across that blocking-pool round trip or unrelated sessions'
        // start/stop operations would serialize behind it.
        flush_cli_streams_for_session(session_id).await;
        handle.abort();
        // `abort()` only requests cancellation. Await the handle so the
        // runner future has actually dropped its provider-identity guard
        // before a follow-up publishes the interrupted snapshot or launches
        // another turn against the same native UUID.
        if let Err(error) = handle.await {
            if !error.is_cancelled() {
                tracing::warn!(
                    session_id,
                    error = %error,
                    "CLI runner failed while waiting for cancellation"
                );
            }
        }
    }

    let process_session_id = session_id.to_string();
    let persisted_session =
        tokio::task::spawn_blocking(move || persistence::get_session(&process_session_id)).await;
    if let Ok(Ok(Some(session))) = persisted_session {
        if let Some(pid) = session.pid {
            terminate_process_tree(pid, session_id).await;
        }
    }

    integrations::proxy::server::stop_session_proxy(session_id).await;

    had_running_task
}

async fn terminal_context(
    session_id: &str,
) -> Result<(Option<CodeSession>, Option<String>), String> {
    let lookup_session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let session =
            persistence::get_session(&lookup_session_id).map_err(|err| err.to_string())?;
        let active_turn_intent_id = session_persistence::turn_intents::latest_for_sessions(
            std::slice::from_ref(&lookup_session_id),
        )
        .map_err(|err| err.to_string())?
        .remove(&lookup_session_id)
        .filter(|intent| {
            intent.status == session_persistence::turn_intents::TurnIntentStatus::Running
        })
        .map(|intent| intent.turn_intent_id);
        Ok::<_, String>((session, active_turn_intent_id))
    })
    .await
    .map_err(|err| format!("Task error: {err}"))?
}

/// One terminal owner for runner interruption paths. Callers must already have
/// stopped the runner and hold its identity boundary before invoking this.
struct InterruptedTerminal<'a> {
    status: SessionStatus,
    intent_status: session_persistence::turn_intents::TurnIntentStatus,
    error: Option<&'a str>,
    reason: Option<&'a str>,
}

async fn finalize_interrupted_runner(
    session_id: &str,
    session: Option<&CodeSession>,
    active_turn_intent_id: Option<&str>,
    terminal: InterruptedTerminal<'_>,
) -> Result<(), String> {
    // Preserve every provider-durable partial row before publishing the
    // terminal intent. A runtime switch may begin as soon as that intent is
    // visible, so transcript/alias convergence belongs to the durable
    // terminal boundary. Catalog refresh remains deferred and idempotent.
    let convergence_error = if let Err(error) =
        super::super::native_materializer::converge_bound_native_transcript_and_schedule_catalog(
            session_id,
        )
        .await
    {
        tracing::error!(
            session_id,
            error = %error,
            "failing interrupted terminal because provider-native transcript did not converge"
        );
        Some(format!(
            "Provider-native transcript could not be finalized safely: {error}"
        ))
    } else {
        None
    };

    let persist_session_id = session_id.to_string();
    let persist_turn_intent_id = active_turn_intent_id.map(str::to_string);
    let persist_error = convergence_error
        .clone()
        .or_else(|| terminal.error.map(str::to_string));
    let broadcast_error = persist_error.clone();
    let terminal_status = if convergence_error.is_some() {
        SessionStatus::Failed
    } else {
        terminal.status
    };
    let terminal_intent_status = if convergence_error.is_some() {
        session_persistence::turn_intents::TurnIntentStatus::Failed
    } else {
        terminal.intent_status
    };
    tokio::task::spawn_blocking(move || {
        persistence::update_cli_turn_lifecycle(
            &persist_session_id,
            terminal_status,
            persist_error.as_deref(),
            persist_turn_intent_id
                .as_deref()
                .map(|turn_intent_id| (turn_intent_id, terminal_intent_status)),
        )
    })
    .await
    .map_err(|err| format!("Task error: {err}"))??;

    super::super::hook_approvals::unregister_session(session_id);
    if let Some(session) = session {
        if let Some(agent) = session
            .cli_agent_type
            .as_deref()
            .and_then(key_vault::key_store::ModelType::from_str)
        {
            super::helpers::clear_live_status(
                &agent,
                session_id,
                session.cli_session_id.as_deref(),
            );
        } else {
            crate::orgtrack::agent_live_status::clear(&[session_id]);
        }
    } else {
        crate::orgtrack::agent_live_status::clear(&[session_id]);
    }

    let mut status_msg = serde_json::json!({
        "type": "code_session.status_changed",
        "session_id": session_id,
        "status": terminal_status.as_ref(),
        "background": session.is_some_and(|session| session.background),
        "session_name": session.map(|session| session.name.clone()),
    });
    if let Some(reason) = terminal.reason {
        status_msg["reason"] = serde_json::Value::String(reason.to_string());
    }
    if let Some(error) = broadcast_error.as_deref() {
        status_msg["error_message"] = serde_json::Value::String(error.to_string());
    }
    if let Some(turn_intent_id) = active_turn_intent_id {
        status_msg["turn_intent_id"] = serde_json::Value::String(turn_intent_id.to_string());
    }
    crate::api::websocket_handler::broadcast(status_msg.to_string());

    if let Some(error) = convergence_error {
        Err(error)
    } else {
        Ok(())
    }
}

/// Fail a killed app-server turn whose native interrupt never reached a safe
/// terminal boundary. The ordinary cancel path and forced-follow-up path share
/// the same lifecycle persistence, live-status cleanup, and broadcast owner.
pub(crate) async fn fail_interrupted_turn(session_id: &str, error: &str) -> Result<(), String> {
    let (session, active_turn_intent_id) = terminal_context(session_id).await?;
    finalize_interrupted_runner(
        session_id,
        session.as_ref(),
        active_turn_intent_id.as_deref(),
        InterruptedTerminal {
            status: SessionStatus::Failed,
            intent_status: session_persistence::turn_intents::TurnIntentStatus::Failed,
            error: Some(error),
            reason: None,
        },
    )
    .await
}

/// Persist the old turn boundary before a force-follow-up rebinds runtime,
/// account, or model. The caller has already stopped the process and owns the
/// session identity lock, exactly like the user-cancel path.
pub(crate) async fn finalize_interrupted_follow_up(
    session_id: &str,
    interrupt_error: Option<&str>,
) -> Result<(), String> {
    let (session, active_turn_intent_id) = terminal_context(session_id).await?;
    finalize_interrupted_runner(
        session_id,
        session.as_ref(),
        active_turn_intent_id.as_deref(),
        InterruptedTerminal {
            status: if interrupt_error.is_some() {
                SessionStatus::Failed
            } else {
                SessionStatus::Cancelled
            },
            intent_status: if interrupt_error.is_some() {
                session_persistence::turn_intents::TurnIntentStatus::Failed
            } else {
                session_persistence::turn_intents::TurnIntentStatus::Cancelled
            },
            error: interrupt_error,
            reason: Some("replaced_by_follow_up"),
        },
    )
    .await
}

/// Cancel a running session by killing the CLI subprocess.
///
/// Does NOT release the proxy token — follow-up messages via
/// `cli_agent_message` always re-allocate a fresh token anyway.
/// The old token expires via the agent-proxy inactivity timeout or
/// is released on session deletion.
pub async fn cancel_session(session_id: &str, reason: CancelReason) -> Result<bool, String> {
    // Serialize against `cli_agent_message` / `cli_agent_run` for this
    // session: a cancel whose DB lookup lands after a follow-up turn was
    // accepted would otherwise cancel the NEW intent and kill the new
    // process ("stop then send loses both messages").
    let control_lock = super::helpers::session_control_lock(session_id).await;
    let control_guard = control_lock.lock().await;

    // The previous `.ok().flatten()` collapsed a DB error and a
    // legitimate "session not found" into the same `None`. The
    // status_changed broadcast below would then ship without
    // `background` / `session_name` populated, and the UI would
    // silently render an "unknown session cancelled" toast. Warn
    // on the DB-error branch so the cause is visible while still
    // proceeding with the cancel (we don't want to fail the cancel
    // just because we couldn't decorate the broadcast).
    let (session, active_turn_intent_id) = match terminal_context(session_id).await {
        Ok(result) => result,
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "cli::cancel_session: terminal context unavailable; broadcast will lack session metadata"
            );
            (None, None)
        }
    };

    // Codex app-server transport: ask the running turn to interrupt
    // gracefully (bounded wait) so codex finalizes the rollout before we
    // kill the process tree. No-op for every other transport/agent.
    let interrupt_outcome =
        crate::agent_sessions::cli::parsers::codex_app_server::interrupt_session_gracefully(
            session_id,
        )
        .await;

    let had_running = kill_running_agent(session_id).await;
    // `kill_running_agent` awaits the aborted runner, so its lifetime identity
    // guard is gone. Reacquire identity while the control guard is still held
    // before persisting the terminal turn boundary.
    let _identity_guard = super::session_identity_lock(session_id)
        .await
        .lock_owned()
        .await;

    // A timed-out Codex app-server interrupt cannot advertise a clean native
    // resume boundary. Ordinary native runtimes already write their one
    // authoritative profile directly, so no second copy step exists.
    let interrupt_error = if matches!(
        interrupt_outcome,
        crate::agent_sessions::cli::parsers::codex_app_server::GracefulInterruptOutcome::TimedOut
    ) {
        Some("Codex did not finish its native interrupted turn".to_string())
    } else {
        None
    };
    let terminal_status = if interrupt_error.is_some() {
        SessionStatus::Failed
    } else {
        SessionStatus::Cancelled
    };
    let terminal_intent_status = if interrupt_error.is_some() {
        session_persistence::turn_intents::TurnIntentStatus::Failed
    } else {
        session_persistence::turn_intents::TurnIntentStatus::Cancelled
    };

    finalize_interrupted_runner(
        session_id,
        session.as_ref(),
        active_turn_intent_id.as_deref(),
        InterruptedTerminal {
            status: terminal_status,
            intent_status: terminal_intent_status,
            error: interrupt_error.as_deref(),
            reason: Some(reason.as_str()),
        },
    )
    .await?;
    drop(control_guard);

    if let Some(error) = interrupt_error {
        tracing::error!(
            "[CodeSession] Session {} cancellation failed closed (reason={}, had_running={}): {}",
            session_id,
            reason.as_str(),
            had_running,
            error
        );
        return Err(error);
    }

    tracing::info!(
        "[CodeSession] Session {} cancelled (reason={}, had_running={})",
        session_id,
        reason.as_str(),
        had_running
    );

    Ok(had_running)
}

/// Clean up the persistent Cursor config directory for a session.
///
/// Called when a session is deleted. Removes `~/.orgii/cursor-config/{session_id}/`
/// which contains CLI config and chat session data used for --resume.
pub fn cleanup_cursor_config_dir(session_id: &str) {
    let config_dir = app_paths::cursor_config_dir(session_id);
    if config_dir.exists() {
        if let Err(err) = std::fs::remove_dir_all(&config_dir) {
            tracing::warn!(
                "[CodeSession] Failed to clean up cursor config dir for {}: {}",
                session_id,
                err
            );
        }
    }
}
