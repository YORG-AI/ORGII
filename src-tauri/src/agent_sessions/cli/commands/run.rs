//! `cli_agent_run` / `cli_agent_message` / `cli_agent_approval_response` —
//! spawning and driving the background CLI agent runner, plus IDE-context
//! injection and TUI-pane release.

use super::super::persistence;
use super::super::session_runner;
use super::super::types::{KeySource, SessionStatus};
use agent_core::session::IdeContext;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunReceipt {
    pub session_id: String,
    pub turn_intent_id: String,
    pub status: SessionStatus,
}

/// Start one CLI turn on an existing session row.
///
/// `Default` is derived so callers that only drive a plain prompt (the
/// agent-core bridge, the debug runtime probes) can name just the fields
/// they mean instead of padding the call with positional `None`s.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRunRequest {
    pub session_id: String,
    pub user_input: String,
    pub cli_resume_id: Option<String>,
    pub ide_context: Option<IdeContext>,
    pub mode: Option<String>,
    pub images: Option<Vec<String>>,
}

/// Send a follow-up message on an existing session, optionally switching the
/// model/account first. `turn_intent_id` / `client_message_id` are optional:
/// the frontend pre-assigns them so its optimistic user row and the persisted
/// intent share one identity, while callers without a UI row omit them.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliMessageRequest {
    pub session_id: String,
    pub content: String,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub ide_context: Option<IdeContext>,
    pub mode: Option<String>,
    pub images: Option<Vec<String>>,
    pub turn_intent_id: Option<String>,
    pub client_message_id: Option<String>,
}

/// Identity of a single turn. `turn_intent_id` keys the `turn_intents` row and
/// every `status_changed` broadcast for the turn; `client_message_id`
/// reconciles the frontend's optimistic user message with the persisted one.
#[derive(Debug)]
struct TurnIdentity {
    turn_intent_id: String,
    client_message_id: String,
}

impl TurnIdentity {
    /// Mint a fresh pair for a turn no client pre-assigned ids for.
    fn generate() -> Self {
        Self::from_client(None, None)
    }

    /// Adopt whichever halves the client supplied, minting the rest.
    fn from_client(turn_intent_id: Option<String>, client_message_id: Option<String>) -> Self {
        Self {
            turn_intent_id: turn_intent_id.unwrap_or_else(new_id),
            client_message_id: client_message_id.unwrap_or_else(new_id),
        }
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Mint a turn intent id for a path that has no `TurnIdentity` of its own
/// (currently `cli_agent_resume`), so every turn is attributable.
pub(super) fn new_turn_intent_id() -> String {
    new_id()
}

/// Prepend IDE context (open files, git status, etc.) to the user prompt
/// so external CLI agents are aware of the user's IDE state.
fn inject_ide_context_into_prompt(user_input: &str, ide_context: Option<&IdeContext>) -> String {
    let Some(ctx) = ide_context else {
        return user_input.to_string();
    };

    let section = agent_core::core::session::prompt::ide_context::format_ide_context(ctx);
    if section.is_empty() {
        return user_input.to_string();
    }

    format!(
        "<ide_context>\n{}\n</ide_context>\n\n{}",
        section, user_input
    )
}

/// Park a TUI-hosted session when its terminal pane goes away (PTY exit or
/// tab close). Non-TUI sessions and already-terminal rows are left alone.
#[tauri::command]
pub async fn cli_agent_tui_release(session_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || super::super::tui_bridge::release_tui_session(&session_id))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

/// Run a code session (spawn CLI agent in background).
#[tauri::command]
pub async fn cli_agent_run(request: CliRunRequest) -> Result<(), String> {
    run_turn(request, TurnIdentity::generate()).await
}

/// Shared turn body behind both `cli_agent_run` and `cli_agent_message`:
/// persist acceptance under the registry lock, broadcast `running`, then spawn
/// the background runner.
async fn run_turn(request: CliRunRequest, turn: TurnIdentity) -> Result<(), String> {
    let CliRunRequest {
        session_id,
        user_input,
        cli_resume_id,
        ide_context,
        mode,
        images,
    } = request;
    let TurnIdentity {
        turn_intent_id,
        client_message_id,
    } = turn;

    tracing::info!(
        session_id = %session_id,
        has_resume_id = cli_resume_id.is_some(),
        mode = ?mode,
        image_count = images.as_ref().map(|items| items.len()).unwrap_or(0),
        "cli_agent_run: received run request"
    );

    if let Some(requested_mode) = mode.as_deref() {
        let sid = session_id.clone();
        let requested_mode = requested_mode.to_string();
        tokio::task::spawn_blocking(move || {
            persistence::update_agent_exec_mode(&sid, &requested_mode)
                .map_err(|err| format!("DB error: {}", err))
        })
        .await
        .map_err(|err| format!("Task error: {}", err))??;
    }

    // Hold the registry lock across acceptance persistence + spawn so two
    // concurrent calls cannot both create a running intent for one session.
    let mut sessions = session_runner::RUNNING_SESSIONS.lock().await;

    // Guard: prevent duplicate parallel agents for the same session
    if let Some(handle) = sessions.get(&session_id) {
        if !handle.is_finished() {
            return Err(format!(
                "Session {} already has a running agent. Cancel it first.",
                session_id
            ));
        }
    }

    let persist_session_id = session_id.clone();
    let persist_turn_intent_id = turn_intent_id.clone();
    tokio::task::spawn_blocking(move || {
        persistence::accept_cli_turn(
            &persist_session_id,
            &persist_turn_intent_id,
            &client_message_id,
        )
        .map_err(|err| format!("failed to accept CLI turn lifecycle: {err}"))
    })
    .await
    .map_err(|err| format!("Task error: {err}"))??;

    let mut running_msg = serde_json::json!({
        "type": "code_session.status_changed",
        "session_id": session_id,
        "status": "running",
    });
    running_msg["turn_intent_id"] = serde_json::Value::String(turn_intent_id.clone());
    crate::api::websocket_handler::broadcast(running_msg.to_string());

    let sid = session_id.clone();
    let cli_input = inject_ide_context_into_prompt(&user_input, ide_context.as_ref());
    let resume_id = cli_resume_id.clone();
    let agent_mode = mode.clone();
    let runner_turn_intent_id = turn_intent_id.clone();

    tracing::info!(session_id = %session_id, "cli_agent_run: spawning background runner");

    // Spawn as background task
    let handle = tokio::spawn(async move {
        if let Err(e) = session_runner::run_session(
            sid.clone(),
            cli_input,
            resume_id,
            agent_mode.as_deref(),
            images,
            Some(&runner_turn_intent_id),
        )
        .await
        {
            tracing::error!("[CodeSession] Session {} failed: {}", sid, e);
            session_runner::flush_cli_streams_for_session(&sid).await;
            // Best-effort: if marking the row as Failed itself fails, log
            // it explicitly rather than silently dropping the persistence
            // error — the session row may be left in `Running` until the
            // health checker repairs it on next pass.
            let failed_sid = sid.clone();
            let failed_error = e.clone();
            let failed_intent = runner_turn_intent_id.clone();
            let persist_result = tokio::task::spawn_blocking(move || {
                persistence::update_cli_turn_lifecycle(
                    &failed_sid,
                    SessionStatus::Failed,
                    Some(&failed_error),
                    Some((
                        &failed_intent,
                        session_persistence::turn_intents::TurnIntentStatus::Failed,
                    )),
                )
            })
            .await;
            if let Err(persist_err) = persist_result
                .map_err(|err| err.to_string())
                .and_then(|result| result)
            {
                tracing::error!(
                    "[CodeSession] failed to mark session {} as Failed: {}",
                    sid,
                    persist_err
                );
            }
            integrations::proxy::server::stop_session_proxy(&sid).await;
            session_runner::release_proxy_token_for_session_pub(&sid).await;
            super::failure_broadcast::broadcast_async_run_failure(
                &sid,
                &e,
                Some(&runner_turn_intent_id),
            )
            .await;
        }
        // Remove finished entry from RUNNING_SESSIONS to prevent unbounded growth
        session_runner::RUNNING_SESSIONS.lock().await.remove(&sid);
    });

    sessions.insert(session_id.clone(), handle);
    drop(sessions);
    tracing::info!(session_id = %session_id, "cli_agent_run: background runner registered");

    Ok(())
}

/// Send a follow-up message to a running or completed session.
///
/// Kills any existing running agent (OS process + proxy), re-allocates a fresh
/// proxy token (the previous one was released on completion), loads the CLI
/// session ID for resume, then re-runs with the new input.
///
/// If `model` or `account_id` is provided, updates the session config before
/// re-running so the CLI uses the newly selected model/key.
#[tauri::command]
pub async fn cli_agent_message(request: CliMessageRequest) -> Result<CliRunReceipt, String> {
    let CliMessageRequest {
        session_id,
        content,
        model,
        account_id,
        ide_context,
        mode,
        images,
        turn_intent_id,
        client_message_id,
    } = request;
    let turn = TurnIdentity::from_client(turn_intent_id, client_message_id);
    tracing::info!(
        session_id = %session_id,
        has_model_override = model.is_some(),
        has_account_override = account_id.is_some(),
        mode = ?mode,
        image_count = images.as_ref().map(|items| items.len()).unwrap_or(0),
        "cli_agent_message: received follow-up"
    );

    // Load the session for resume ID and proxy re-allocation
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    tracing::info!(
        session_id = %session_id,
        session_status = ?session.status,
        session_account_id = ?session.account_id,
        session_cli_session_id = ?session.cli_session_id,
        key_source = ?session.key_source,
        "cli_agent_message: loaded session"
    );

    let target_account_id = account_id.as_deref().or(session.account_id.as_deref());

    // If the user switched model/account, persist the change so run_session picks it up.
    if model.is_some() || account_id.is_some() {
        let sid = session_id.clone();
        let mdl = model.clone();
        let acc = account_id.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(err) =
                persistence::update_model_and_account(&sid, mdl.as_deref(), acc.as_deref())
            {
                tracing::warn!(
                    "[CodeSession] Failed to update model/account for follow-up: {}",
                    err
                );
            }
        })
        .await
        .map_err(|e| format!("Task error: {}", e))?;

        if let Some(ref new_account_id) = account_id {
            if session.account_id.as_deref() != Some(new_account_id.as_str()) {
                agent_core::lifecycle::emit_session_account_switched(
                    agent_core::interaction::plan_approval::global_app_handle(),
                    &session_id,
                    session.account_id.as_deref(),
                    new_account_id,
                    model.as_deref().or(session.model.as_deref()),
                );
            }
        }
    }

    // Kill the existing agent process, Tokio task, and per-session proxy.
    tracing::info!(session_id = %session_id, "cli_agent_message: killing existing runner");
    session_runner::kill_running_agent(&session_id).await;
    tracing::info!(session_id = %session_id, "cli_agent_message: existing runner cleanup complete");

    // Resolve the resume id AFTER the old runner is dead — a slow runner
    // can commit a fresh cli_session_id right up until the kill, so an
    // earlier read would resume one conversation-id behind (TOCTOU on
    // same-account follow-ups). Reading post-kill from a fresh row sees
    // the runner's final commit.
    let fresh_cli_session_id = {
        let sid = session_id.clone();
        tokio::task::spawn_blocking(move || persistence::get_session(&sid))
            .await
            .map_err(|e| format!("Task error: {}", e))?
            .map_err(|err| format!("DB error: {}", err))?
            .and_then(|s| s.cli_session_id)
    };
    let resume_session_id = session_id.clone();
    let resume_account_id = target_account_id.map(str::to_string);
    let account_scoped_resume_id = tokio::task::spawn_blocking(move || {
        persistence::get_cli_session_id_for_account(
            &resume_session_id,
            resume_account_id.as_deref(),
        )
        .map_err(|err| format!("DB error: {err}"))
    })
    .await
    .map_err(|err| format!("Task error: {err}"))??;
    let cli_resume_id = account_scoped_resume_id.or_else(|| {
        if account_id
            .as_deref()
            .is_some_and(|new_account_id| session.account_id.as_deref() != Some(new_account_id))
        {
            None
        } else {
            fresh_cli_session_id
        }
    });

    tracing::info!(
        session_id = %session_id,
        target_account_id = ?target_account_id,
        cli_resume_id = ?cli_resume_id,
        "cli_agent_message: resolved resume state"
    );

    // For hosted_key sessions (or legacy proxy billing), allocate a fresh token.
    // The previous token was released when the last run completed (or expired
    // via the agent-proxy inactivity timeout), so we must get a new one.
    let needs_proxy = session.key_source == KeySource::HostedKey;
    if needs_proxy {
        let hosted_token = session.hosted_token.as_deref().unwrap_or("");
        if hosted_token.is_empty() {
            return Err("Cannot send follow-up: no market token stored on session".to_string());
        }

        let platform = session.cli_agent_type.as_deref().unwrap_or("");
        let mdl = model.as_deref().or(session.model.as_deref());
        let tier = session.tier.as_deref();

        let allocation = integrations::proxy::allocate_proxy_token_internal(
            platform,
            mdl,
            tier,
            None,
            hosted_token,
        )
        .await?;

        tracing::info!(
            "[CodeSession] Re-allocated proxy token for follow-up on session {}",
            session_id
        );

        // Persist new credentials so run_session reads them
        let sid = session_id.clone();
        let token = allocation.proxy_token.clone();
        let url = allocation.proxy_url.clone();
        let proxy_sid = allocation.session_id.clone();
        tokio::task::spawn_blocking(move || {
            persistence::update_proxy_credentials(&sid, &token, &url, proxy_sid.as_deref())
                .map_err(|e| format!("DB error: {}", e))
        })
        .await
        .map_err(|e| format!("Task error: {}", e))??;
    }

    // Re-run the session with the new message
    tracing::info!(session_id = %session_id, "cli_agent_message: dispatching rerun");
    let turn_intent_id = turn.turn_intent_id.clone();
    run_turn(
        CliRunRequest {
            session_id: session_id.clone(),
            user_input: content,
            cli_resume_id,
            ide_context,
            mode,
            images,
        },
        turn,
    )
    .await?;
    Ok(CliRunReceipt {
        session_id,
        turn_intent_id,
        status: SessionStatus::Running,
    })
}

/// Respond to a pending approval request from a CLI agent.
///
/// Two registries can be waiting on this:
/// - **Hook approvals** (managed Claude Code shell-out sessions): a parked
///   `PermissionRequest` hook long-poll keyed by `request_id`
///   (`hookperm-*`, from the `permission:request` wire event). Checked
///   first. `always_allow` maps to a plain allow — persistent rules stay
///   with Claude's own permission store.
/// - **ACP agents** (OpenCode, Copilot, Kiro): a `session/request_permission`
///   parked in `acp_common::PENDING_APPROVALS`, keyed by `request_id`
///   (`acpperm-*`, from the `permission:request` wire event with
///   `origin: "acp"`), with a session-id fallback.
#[tauri::command]
pub async fn cli_agent_approval_response(
    session_id: String,
    approved: bool,
    always_allow: Option<bool>,
    request_id: Option<String>,
) -> Result<(), String> {
    if crate::agent_sessions::cli::hook_approvals::has_pending_hook_approval(
        &session_id,
        request_id.as_deref(),
    ) {
        return crate::agent_sessions::cli::hook_approvals::resolve_hook_approval(
            &session_id,
            request_id.as_deref(),
            approved,
        );
    }
    crate::agent_sessions::cli::parsers::acp_common::resolve_approval(
        &session_id,
        request_id.as_deref(),
        approved,
        always_allow.unwrap_or(false),
    )
    .await
}
