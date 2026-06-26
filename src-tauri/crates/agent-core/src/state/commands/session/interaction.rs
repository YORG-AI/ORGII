//! Interaction commands: questions, permissions, mode-switch, plan-approval.

use crate::foundation::session_bridge::{self, CliPlanApprovalResponseParams};
use crate::interaction::mode_switch::ModeSwitchChoice;
use crate::interaction::permission::PermissionResponse;
use crate::interaction::plan_approval::PlanResolution;
use crate::session::persistence as session_persistence;
use crate::session::AgentExecMode;
use crate::state::AgentAppState;

use super::identity::IdentityOverrides;
use super::message;

/// Respond to a question from the agent.
#[tauri::command]
pub async fn agent_question_response(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
    answers: Vec<Vec<String>>,
) -> Result<(), String> {
    let session = state.get_session(&session_id).await;
    if let Some(session) = session {
        session
            .question_manager
            .respond(&request_id, answers)
            .await
            .map_err(|msg| format!("Question response failed: {}", msg))?;
        return Ok(());
    }
    Err(format!(
        "No session found for question response: {}",
        session_id
    ))
}

/// Push the user's current presence (mode + resolved behavior spec) into
/// the process-wide snapshot.
///
/// Called by the frontend on every presence-mode switch, on edits to the
/// active mode's spec, and once on startup. The global snapshot drives:
///   * re-arming auto-resolve deadlines on already-pending interactions,
///   * starting/stopping the goal continuation loop,
/// while the per-message `IdeContext.user_presence` snapshot continues to
/// feed prompt building.
#[tauri::command]
pub async fn set_user_presence(presence: crate::session::UserPresence) -> Result<(), String> {
    crate::interaction::presence_state::set_global_presence(presence);
    Ok(())
}

/// Push the user's current profile into the process-wide snapshot so
/// backend-only/background turns can render the same User Profile section.
#[tauri::command]
pub async fn set_user_profile(profile: Option<crate::session::UserProfile>) -> Result<(), String> {
    crate::interaction::profile_state::set_global_profile(profile);
    Ok(())
}

/// Reject a question from the agent.
#[tauri::command]
pub async fn agent_question_reject(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    let session = state.get_session(&session_id).await;
    if let Some(session) = session {
        session
            .question_manager
            .reject(&request_id)
            .await
            .map_err(|msg| format!("Question rejection failed: {}", msg))?;
        return Ok(());
    }
    Err(format!(
        "No session found for question reject: {}",
        session_id
    ))
}

/// Submit a user-supplied secret value to an in-flight `manage_secrets` request.
///
/// The plaintext is moved into the per-session `SecretBroker` and immediately
/// wrapped in `zeroize::Zeroizing<String>`. The agent is unblocked with the
/// minted opaque `{{secret:<token>}}` placeholder — the plaintext never enters
/// the LLM transcript or the chat history.
///
/// This command is the only sanctioned ingress path for a secret value; it is
/// invoked by the `SecretCaptureModal` frontend component in response to an
/// `agent:secret_request` event. The `value` parameter is consumed by-value
/// (`String`) so the wire string is dropped at the end of the command.
#[tauri::command]
pub async fn agent_secret_capture_submit(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
    value: String,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("No session found for secret submit: {}", session_id))?;

    session.secret_broker.submit(&request_id, value).await;
    Ok(())
}

/// Cancel an in-flight `manage_secrets` request.
///
/// Called when the user dismisses the `SecretCaptureModal` without providing
/// a value. The agent is unblocked with a `Rejected` outcome.
#[tauri::command]
pub async fn agent_secret_capture_cancel(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("No session found for secret cancel: {}", session_id))?;

    session.secret_broker.cancel(&request_id).await;
    Ok(())
}

/// Inspect captured secrets for a session — labels, kinds, lengths only.
///
/// Used by the frontend to render a per-session "secret vault" panel so the
/// user can see what they have provided and discard entries they no longer
/// want the agent to be able to resolve. Plaintext is never returned.
#[tauri::command]
pub async fn agent_secret_capture_list(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let session = state.get_session(&session_id).await;
    let entries = if let Some(session) = session {
        session.secret_broker.list().await
    } else {
        Vec::new()
    };
    Ok(serde_json::json!({ "secrets": entries }))
}

/// Discard a single captured secret immediately.
///
/// Resolves the token, drops the `Zeroizing<String>` wrapper (which wipes
/// memory), and removes the entry from the broker. After discard, any future
/// `write_env_file` attempt that references the token fails.
#[tauri::command]
pub async fn agent_secret_capture_discard(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    token: String,
) -> Result<bool, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("No session found for secret discard: {}", session_id))?;

    Ok(session.secret_broker.discard(&token).await)
}

/// Respond to a permission request from the agent.
#[tauri::command]
pub async fn agent_permission_response(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    request_id: String,
    response: String,
    tool_name: Option<String>,
    tool_args: Option<serde_json::Value>,
) -> Result<(), String> {
    let perm_response = PermissionResponse::from_wire(&response)
        .ok_or_else(|| format!("Invalid permission response: {}", response))?;

    let session = state.get_session(&session_id).await;
    if let Some(session) = session {
        session
            .permission_manager
            .respond(
                &request_id,
                perm_response,
                tool_name.as_deref(),
                tool_args.as_ref(),
            )
            .await;
        return Ok(());
    }
    Err(format!(
        "No session found for permission response: {}",
        session_id
    ))
}

/// Get pending questions for a session.
#[tauri::command]
pub async fn agent_get_pending_questions(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let session = state.get_session(&session_id).await;
    let questions = if let Some(session) = session {
        session.question_manager.get_pending_metadata().await
    } else {
        Vec::new()
    };
    Ok(serde_json::json!({ "pendingQuestions": questions }))
}

/// Respond to a mode-switch prompt from the agent.
#[tauri::command]
pub async fn agent_mode_switch_response(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    choice: String,
    target_mode: Option<String>,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("No session found: {}", session_id))?;

    let manager = session
        .mode_switch_manager
        .as_ref()
        .ok_or_else(|| format!("Session {} has no mode-switch manager", session_id))?;

    let decision = ModeSwitchChoice::from_wire(&choice, target_mode)
        .ok_or_else(|| format!("Invalid mode-switch choice: {}", choice))?;

    manager.respond(decision).await;
    Ok(())
}

/// Query the pending plan approval snapshot for a session (if any).
///
/// Called on session mount/switch so the frontend can rehydrate
/// `pendingPlanApprovalsAtom` after a page refresh or window re-focus.
/// Returns `null` when no plan is currently pending.
///
/// Lookup order:
///   1. In-memory `PlanApprovalManager::pending_snapshot` when the
///      session is already initialized (hot-path during a live session).
///   2. DB fallback via `plan_approval::load_snapshot_for_session` when
///      the session object hasn't been created yet — this is the normal
///      path on the first window focus after an app restart, before the
///      user has typed anything into this session. Without this branch
///      the Build button would stay disabled until the user sent an
///      unrelated message that triggered `ensure_session_initialized`.
#[tauri::command]
pub async fn agent_get_pending_plan_approval(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let live_snapshot = match state.get_session(&session_id).await {
        Some(session) => match session.plan_approval_manager.as_ref() {
            Some(manager) => manager.pending_snapshot().await,
            None => None,
        },
        None => None,
    };
    let snapshot = match live_snapshot {
        Some(snapshot) => Some(snapshot),
        None => crate::interaction::plan_approval::load_snapshot_for_session(&session_id).await?,
    };

    let Some(snapshot) = snapshot else {
        return Ok(None);
    };

    Ok(Some(serde_json::json!({
        "sessionId": &snapshot.session_id,
        "planPath": &snapshot.plan_path,
        "planTitle": &snapshot.plan_title,
        "planContent": &snapshot.plan_content,
        "toolCallId": &snapshot.tool_call_id,
        "planId": &snapshot.plan_id,
        "planRevisionId": &snapshot.plan_revision_id,
        "originToolCallId": &snapshot.origin_tool_call_id,
    })))
}

/// Build button response from the plan card.
///
/// `choice` is `"approve"` (plain), `"approve_with_edits"` (edited plan
/// content supplied), or `"reject"` (skip the pending plan without starting
/// a Build turn).
///
/// This command:
///   1. Consumes the pending plan snapshot from `PlanApprovalManager`.
///   2. When `approve_with_edits`, overwrites the plan file with the edited
///      content so the next turn reads the user's version.
///   3. Consumes `pre_plan_mode_cache` and broadcasts `agent:exit_plan_mode`
///      so the frontend flips the per-session exec mode back to the previous mode.
///   4. Clears `plan_slot_cache` so a future `create_plan` starts fresh.
///   5. Kicks off a **new Build-mode turn** with a synthetic user-visible
///      message instructing the LLM to start implementing the approved plan.
///      Clicking Build immediately produces a new turn that writes the todo
///      list and begins executing. There is
///      no hidden deferred `tool_result` injection — every state change is
///      visible in the transcript as a real user/assistant exchange.
///
/// `handle` is taken so we can re-enter `send_message_impl`, which needs a
/// `tauri::State<AgentAppState>` and a live `app_handle` via `state.app_handle`.
#[tauri::command]
pub async fn agent_plan_approval_response(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    choice: String,
    edited_content: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    plan_approval_response_impl(
        &state,
        session_id,
        choice,
        edited_content,
        model,
        account_id,
        workspace_path,
        None,
    )
    .await
}

/// Auto-approve entry point for the presence-policy deadline watcher.
///
/// Same flow as the user clicking Build, plus an `agent:plan_auto_approved`
/// broadcast so the card can render the "auto-approved (<mode>)" marker.
/// Idempotent: when the user already resolved the plan, `resolve_pending`
/// returns `None` and this becomes a logged no-op.
pub async fn auto_approve_pending_plan(
    state: &AgentAppState,
    session_id: String,
    mode_label: String,
) -> Result<(), String> {
    plan_approval_response_impl(
        state,
        session_id,
        "approve".to_string(),
        None,
        None,
        None,
        None,
        Some(mode_label),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn plan_approval_response_impl(
    state: &AgentAppState,
    session_id: String,
    choice: String,
    edited_content: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    workspace_path: Option<String>,
    auto_approved_by: Option<String>,
) -> Result<(), String> {
    let session = state.get_session(&session_id).await;

    if session_bridge::get_cli_tools_snapshot(&session_id)?.is_some() {
        // The CLI bridge resolves the pending plan through
        // `plan_approval::resolve_pending`, which pushes the terminal
        // transcript event itself — no wire-side event push needed here.
        session_bridge::respond_cli_plan_approval(CliPlanApprovalResponseParams {
            session_id,
            choice,
            edited_content,
            model,
            account_id,
            workspace_path,
        })
        .await?;
        return Ok(());
    }

    // Fast path: live session with an initialized manager. Slow path:
    // the FE clicked Build on the very first window focus after an app
    // restart — no message has been sent yet, so the agent pipeline
    // never entered `ensure_session_initialized` and the in-memory
    // session object does not exist. Create it here so the plan row
    // that was persisted by the previous run rehydrates into
    // `PlanApprovalManager` before we `take_pending()` below.
    if session.is_none() {
        crate::init::register_session_with_rehydrate(state, &session_id).await?;
    }

    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("No session found: {}", session_id))?;

    let manager = session
        .plan_approval_manager
        .as_ref()
        .ok_or_else(|| format!("Session {} has no plan-approval manager", session_id))?;

    let resolution = match choice.as_str() {
        "approve" => PlanResolution::Approved { edited: None },
        "approve_with_edits" => PlanResolution::Approved {
            edited: Some(
                edited_content
                    .ok_or_else(|| "approve_with_edits requires `edited_content`".to_string())?,
            ),
        },
        "reject" => PlanResolution::Rejected,
        other => return Err(format!("Invalid plan-approval choice: {}", other)),
    };
    let rejected = choice == "reject";
    let edited = choice == "approve_with_edits";

    let snapshot =
        crate::interaction::plan_approval::resolve_pending(&session_id, resolution, Some(manager))
            .await
            .ok_or_else(|| format!("No pending plan approval for session {}", session_id))?;

    // Cross-mode approval: the pending plan survives mode switches, so the
    // user may click Build/Skip from any exec mode. Only restore the
    // pre-plan mode when the session is still IN plan mode — if the user
    // already switched (e.g. to Build), keep their current mode instead of
    // overwriting it with a stale snapshot.
    let current_mode = session_persistence::get_session(&session_id)
        .ok()
        .flatten()
        .and_then(|record| record.agent_exec_mode)
        .and_then(|mode| AgentExecMode::parse(&mode));
    let still_in_plan_mode = matches!(current_mode, Some(AgentExecMode::Plan) | None);
    let restore_mode = if still_in_plan_mode {
        session
            .pre_plan_mode_cache
            .take(&session_id)
            .unwrap_or(AgentExecMode::Build)
    } else {
        let _ = session.pre_plan_mode_cache.take(&session_id);
        current_mode.unwrap_or(AgentExecMode::Build)
    };
    let build_turn_mode = AgentExecMode::Build;

    session.plan_slot_cache.clear(&session_id);

    if still_in_plan_mode {
        session_persistence::update_agent_exec_mode(&session_id, restore_mode.as_str())
            .map_err(|err| format!("Failed to persist restored agent exec mode: {err}"))?;
    }

    crate::bus::broadcast_event(
        "agent:exit_plan_mode",
        serde_json::json!({
            "sessionId": &session_id,
            "planPath": &snapshot.plan_path,
            "planTitle": &snapshot.plan_title,
            "toolCallId": &snapshot.tool_call_id,
            "planId": &snapshot.plan_id,
            "planRevisionId": &snapshot.plan_revision_id,
            "originToolCallId": &snapshot.origin_tool_call_id,
            "restoreMode": restore_mode.as_str(),
            "edited": edited,
            "rejected": rejected,
        }),
    );

    if let Some(ref mode_label) = auto_approved_by {
        crate::bus::broadcast_event(
            "agent:plan_auto_approved",
            serde_json::json!({
                "sessionId": &session_id,
                "planId": &snapshot.plan_id,
                "planRevisionId": &snapshot.plan_revision_id,
                "modeLabel": mode_label,
            }),
        );
    }

    if rejected {
        return Ok(());
    }

    // ── Kick off the Build turn ──────────────────────────────────────────
    //
    // Why we re-enter `send_message_impl` here instead of writing a custom
    // "resume" path:
    //   * `send_message_impl` already handles scheduler enqueue, runtime
    //     resolution, cancel-flag reset, and turn stats. Duplicating any
    //     of that would drift on the next refactor.
    //
    let plan_body = std::fs::read_to_string(&snapshot.plan_path)
        .map_err(|err| format!("Failed to read approved plan: {}", err))?;
    let synthetic_content = format!(
        "[Plan approved{edited_marker}] Implement the approved plan now.\n\n\
         Execute the approved plan directly. Use the available coding tools to make the requested changes. \
         If the plan is genuinely complex, you may use `manage_todo` with its schema to track execution, \
         but do not create another plan.\n\n\
         ## Approved plan\n\n{plan_body}",
        edited_marker = if edited { " (edited)" } else { "" },
    );

    // Prefer the FE-supplied identity (model / account_id / workspace_path)
    // from the current chat composer over DB fallbacks. After an app
    // restart the in-memory runtime is empty, and the DB row may be stale
    // if the user switched model/account since the plan was drafted —
    // using what the composer currently shows is always the least
    // surprising behavior ("Build with whatever I'm about to send").
    // `send_message_impl` will still fall back to runtime/DB for any
    // field the FE leaves as `None`.
    let overrides = IdentityOverrides {
        model,
        account_id,
        workspace_root: workspace_path,
        native_harness_type: None,
    };
    message::send_message_impl(
        state,
        session_id.clone(),
        synthetic_content,
        None,
        overrides,
        Some(build_turn_mode.as_str().to_string()),
        None,
        None,
        false,
        false,
        None,
        None,
        crate::foundation::session_bridge::TurnIntentBridgeSource::UserSubmit,
    )
    .await
    .map(|_| ())
    .map_err(|err| format!("Failed to kick off Build turn after plan approval: {}", err))
}

/// Debug-only: seed a pending plan approval row for WDIO plan-lifecycle
/// specs. Ensures an `agent_sessions` row exists (production
/// `upsert_session`), then drives the production `mark_ready` path so the
/// DB row + broadcast are shaped exactly like a live `create_plan`.
#[tauri::command]
pub async fn debug_seed_pending_plan(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    plan_path: String,
    plan_title: String,
    plan_content: String,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_pending_plan is only available in debug builds".into());
    }
    std::fs::write(&plan_path, plan_content.as_bytes())
        .map_err(|err| format!("Failed to write plan file: {err}"))?;

    // GC orphans rows whose session does not exist — seed the session row
    // first so the fixture is indistinguishable from a live plan session.
    {
        let sid = session_id.clone();
        let title = plan_title.clone();
        tokio::task::spawn_blocking(move || {
            if matches!(session_persistence::get_session(&sid), Ok(Some(_))) {
                return Ok(());
            }
            let now = chrono::Utc::now().to_rfc3339();
            session_persistence::upsert_session(&session_persistence::UnifiedSessionRecord {
                session_id: sid.clone(),
                name: title,
                status: "idle".to_string(),
                agent_exec_mode: Some("plan".to_string()),
                created_at: now.clone(),
                updated_at: now,
                ..Default::default()
            })
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| format!("Failed to seed session row: {err}"))?;
    }

    let manager = match state.get_session(&session_id).await {
        Some(session) => session.plan_approval_manager.clone(),
        None => None,
    };
    match manager {
        Some(manager) => {
            manager
                .mark_ready(&session_id, &plan_path, &plan_title, &plan_content, None)
                .await;
        }
        None => {
            let manager = crate::interaction::plan_approval::PlanApprovalManager::new();
            if let Some(handle) = crate::interaction::plan_approval::global_app_handle() {
                manager.set_app_handle(Some(handle.clone()));
            }
            manager
                .mark_ready(&session_id, &plan_path, &plan_title, &plan_content, None)
                .await;
        }
    }
    Ok(())
}
