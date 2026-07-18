//! Session messaging logic (`agent_send_message` implementation).

use std::sync::Arc;

use crate::foundation::session_bridge::TurnIntentBridgeSource;
use crate::persistence::AgentResponse;
use crate::session::persistence as session_persistence;
use crate::state::AgentAppState;

use super::identity::{resolve_session_identity, IdentityOverrides};
use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionStore, EnterMemberInterventionParams,
    DEFAULT_INTERVENTION_TTL_SECS,
};

/// Wake-only entry point for the **background-subagent** completion hook.
///
/// Resumes the parent with **empty content** (`is_resume = true`), exactly
/// like the Agent Org inbox auto-resume — so NO new user message is persisted
/// and NO new chat round is created. The parent continues inside the same
/// round it was already in.
///
/// A plain SDE session has no inbox to drain, so unlike the Agent Org path
/// nothing converts to a trailing user message on its own. That would leave
/// the conversation ending on the parent's last *assistant* message
/// ("已在后台启动。"), which providers reject with `HTTP 400: ... conversation
/// must end with a user message`. The unified processor closes that gap: on a
/// resume whose assembled message list still ends with an assistant turn, it
/// appends a **transient** (in-memory only, never persisted) user nudge so the
/// prefill invariant holds — see `inject_subagent_wake_nudge_if_needed` in
/// `turn/processor/mod.rs`. The actual subagent result still arrives via the
/// background-jobs system reminder.
pub async fn send_message_impl_for_subagent_wake(
    state: &AgentAppState,
    session_id: String,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        session_id,
        String::new(),
        None,
        IdentityOverrides::default(),
        None,
        None,
        None,
        true,
        false,
        None,
        None,
        None,
        None,
        TurnIntentBridgeSource::Resume,
    )
    .await
}

/// Agent Org wake entry point with a stable scheduler idempotency key.
///
/// The scheduler holds this key while the turn is queued or running, so
/// concurrent watchdog, inbox, and task wake sources coalesce into one turn.
pub async fn send_message_impl_for_org_wake(
    state: &AgentAppState,
    session_id: String,
    org_run_id: &str,
    member_id: &str,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        session_id,
        String::new(),
        None,
        IdentityOverrides::default(),
        None,
        None,
        None,
        true,
        false,
        Some(format!("agent-org-wake:{org_run_id}:{member_id}")),
        None,
        Some(org_run_id.to_string()),
        Some(org_run_id.to_string()),
        TurnIntentBridgeSource::Resume,
    )
    .await
}

/// Debug-only entry point for E2E follow-up turns.
///
/// The production `agent_send_message` Tauri command is `pub` but
/// requires `tauri::State<'_, AgentAppState>` (only constructible
/// inside a Tauri command handler), and `send_message_impl` is
/// `pub(super)`. This thin wrapper exposes the same call shape to
/// debug HTTP endpoints without widening visibility on the prod
/// implementation. Used by `/test/agent-org/follow-up-message` to
/// drive a second turn on an existing org session.
#[cfg(debug_assertions)]
pub async fn send_message_impl_for_test(
    state: &AgentAppState,
    session_id: String,
    content: String,
    model: Option<String>,
    account_id: Option<String>,
) -> Result<AgentResponse, String> {
    send_message_impl(
        state,
        session_id,
        content,
        None,
        IdentityOverrides {
            model,
            account_id,
            workspace_root: None,
            native_harness_type: None,
        },
        None,
        None,
        None,
        false,
        false,
        None,
        None,
        None,
        None,
        TurnIntentBridgeSource::UserSubmit,
    )
    .await
}

/// Implementation of agent_send_message.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_message_impl(
    state: &AgentAppState,
    session_id: String,
    content: String,
    display_text: Option<String>,
    overrides: IdentityOverrides,
    mode: Option<String>,
    images: Option<Vec<String>>,
    ide_context: Option<crate::session::IdeContext>,
    is_resume: bool,
    mark_direct_user_intervention: bool,
    client_message_id: Option<String>,
    turn_intent_id: Option<String>,
    org_wake_run_id: Option<String>,
    intent_org_run_id: Option<String>,
    source: TurnIntentBridgeSource,
) -> Result<AgentResponse, String> {
    // Canonical user-intent id: callers that already mint one at the
    // submit boundary pass it through; legacy / internal callers that
    // don't (mobile remote, wake hook, plan-approval re-entry) get a
    // server-side fallback so the bridge slot is always non-empty.
    let effective_turn_intent_id =
        turn_intent_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let default_mode = crate::session::AgentExecMode::Build.as_str();
    tracing::info!(
        "[agent_send_message] session={}, model={:?}, account={:?}, mode={:?}, images={}, turn_intent_id={}",
        session_id,
        overrides.model.as_deref().unwrap_or("<default>"),
        overrides.account_id.as_deref().unwrap_or("<default>"),
        mode.as_deref().unwrap_or(default_mode),
        images
            .as_ref()
            .map(|v| format!("{} image(s)", v.len()))
            .unwrap_or_else(|| "none".to_string()),
        effective_turn_intent_id,
    );

    // ── 1. Resolve session identity (unified — single code path) ─────────
    let identity = resolve_session_identity(state, &session_id, overrides).await?;

    // Goal loop: a real user submission becomes (or replaces) the
    // session's standing goal and resets the continuation counter.
    // `Queue`-sourced messages (goal continuations, queued flushes) and
    // resumes never reset it — otherwise the loop would feed itself.
    if matches!(
        source,
        TurnIntentBridgeSource::UserSubmit | TurnIntentBridgeSource::ForceSend
    ) && !is_resume
    {
        crate::session::goal_loop::on_user_message(&session_id, &content, display_text.as_deref());
    }

    let effective_model = identity.model;
    let effective_account_id = identity.account_id;
    let effective_workspace_root = identity.workspace_root;
    let effective_native_harness_type = identity.native_harness_type;

    // ── 2. Ensure session is initialized (lazy runtime creation) ─────────
    let launch_spec = crate::init::launch_spec::AgentLaunchSpec::from_session_sources(
        state,
        &session_id,
        effective_workspace_root.clone(),
        effective_account_id.clone(),
        Some(effective_model.clone()),
        effective_native_harness_type,
    )
    .await?;

    let runtime = crate::init::init_session(state, launch_spec).await?;

    // Turn intent ownership is independent from wake behavior. Explicit
    // callers (initial Org launch, direct member message, wake) pass the run
    // id before the runtime necessarily exists; ordinary messages recover it
    // from the canonical runtime context. Never allow a retry to cross runs.
    let runtime_org_run_id = runtime
        .agent_org_context
        .as_ref()
        .map(|context| context.run_id.clone());
    let effective_intent_org_run_id = match (
        intent_org_run_id.as_deref(),
        runtime_org_run_id.as_deref(),
    ) {
        (Some(explicit), Some(runtime_id)) if explicit != runtime_id => {
            return Err(format!(
                "Agent Org turn intent run mismatch for session {session_id}: explicit run {explicit}, runtime run {runtime_id}"
            ));
        }
        (Some(_), _) => intent_org_run_id,
        (None, Some(_)) => runtime_org_run_id,
        (None, None) => None,
    };

    // Wingman resume: reopen the bottom bar. On fresh start the frontend
    // sends `wingman_start` which opens the bar, but after app restart
    // the frontend doesn't re-send that command. Best-effort — a missing
    // bar doesn't block the session.
    if crate::definitions::prefix_lookup::is_wingman_session_id(&session_id) {
        if let Some(ref app_h) = state.app_handle {
            crate::session::wingman::open_wingman_bar(app_h, &session_id, "Active", None);
        }
    }

    // ── 3. Snapshot session resources (single lookup) ─────────────────────
    //
    // After `ensure_session_initialized` the session is guaranteed to exist
    // in memory, so we look it up once and extract everything we need.
    // `session_handle` stays alive for the enqueue step at the end;
    // `agent_session_arc` (clone) is moved into the async closure.
    let session_handle = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("Session not found after init: {}", session_id))?;

    session_handle.refresh_last_active().await;

    let cancel_flag = Arc::clone(&session_handle.cancel_flag);
    let session_for_closure = Arc::clone(&session_handle);
    let load_workspace_resources = runtime.resolved.load_workspace_resources;

    if !is_resume && !content.trim().is_empty() {
        let _ = super::org_tasks::resume_paused_run_for_user_message(state, &session_id).await?;
    }

    if mark_direct_user_intervention && !is_resume && !content.trim().is_empty() {
        let runtime_snapshot = session_handle.runtime.read().await.clone();
        if let Some(runtime) = runtime_snapshot {
            if let Some(org_context) = runtime.agent_org_context.as_ref() {
                let org_run_id = org_context.run_id.clone();
                let org_context = org_context.clone();
                let session_id_for_intervention = session_id.clone();
                tokio::task::spawn_blocking(move || {
                    let member_id =
                        crate::session::persistence::get_session(&session_id_for_intervention)
                            .map_err(|err| err.to_string())?
                            .and_then(|record| record.org_member_id)
                            .ok_or_else(|| {
                                format!(
                                    "Agent Org session {} has no canonical member_id",
                                    session_id_for_intervention
                                )
                            })?;
                    if !can_enter_member_intervention(&member_id) {
                        tracing::debug!(
                            org_run_id = %org_run_id,
                            session_id = %session_id_for_intervention,
                            "ordinary coordinator message does not enter member intervention"
                        );
                        return Ok::<(), String>(());
                    }
                    let agent_id = org_context.require_participant_agent_id(&member_id)?;
                    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
                        org_run_id,
                        member_id,
                        agent_id,
                        session_id: session_id_for_intervention,
                        reason: Some("direct_user_chat".to_string()),
                        ttl_secs: DEFAULT_INTERVENTION_TTL_SECS,
                    })?;
                    Ok::<(), String>(())
                })
                .await
                .map_err(|err| err.to_string())??;
            }
        }
    }

    let app_handle = state.app_handle.clone();

    // ── 3b. Mid-turn steering divert ─────────────────────────────────────
    //
    // A plain-text user message that arrives while a turn is RUNNING is
    // injected into that turn (drained by the turn loop before the next
    // LLM iteration) instead of waiting behind it as its own turn — the
    // model can change course immediately. Excluded: force-sends (they
    // interrupt via their own boundary semantics), resumes, queue-sourced
    // continuations, image messages, and empty content. The Stop boundary
    // clears the buffer, matching queued-message discard semantics.
    // `is_turn_processing`, not `is_processing`: only a running turn drains
    // the steering queue. A maintenance job (manual compaction) occupies the
    // worker without a turn loop, so a message diverted here during one would
    // wait forever.
    if matches!(source, TurnIntentBridgeSource::UserSubmit)
        && !is_resume
        && !content.trim().is_empty()
        && images.as_ref().map(|v| v.is_empty()).unwrap_or(true)
        && session_handle.scheduler.is_turn_processing()
    {
        crate::foundation::session_bridge::upsert_turn_intent(
            &session_id,
            &effective_turn_intent_id,
            client_message_id.as_deref(),
            effective_intent_org_run_id.as_deref(),
            source,
            crate::foundation::session_bridge::TurnIntentBridgeStatus::Queued,
        );
        session_handle
            .steering_queue
            .lock()
            .await
            .push(crate::turn_executor::SteeringInjection {
                content: content.clone(),
                turn_intent_id: effective_turn_intent_id.clone(),
            });

        // Race closure: the turn may have ended between the is_processing
        // check and the push. If it's idle now, reclaim the injection (when
        // still unconsumed) and fall through to a normal enqueue.
        let reclaimed = if !session_handle.scheduler.is_turn_processing() {
            let mut steering = session_handle.steering_queue.lock().await;
            let before = steering.len();
            steering.retain(|inj| inj.turn_intent_id != effective_turn_intent_id);
            steering.len() != before
        } else {
            false
        };

        if !reclaimed {
            tracing::info!(
                "[agent_send_message] Steering message into active turn for session {} (intent={})",
                session_id,
                effective_turn_intent_id
            );
            return Ok(AgentResponse {
                content: serde_json::json!({
                    "queued": true,
                    "steered": true,
                    "messageId": effective_turn_intent_id,
                    "queuePosition": 0,
                    "duplicate": false,
                })
                .to_string(),
                session_id,
                model: effective_model,
            });
        }
    }

    // ── 4. Persist identity and user_input (single DB write) ─────────────
    //
    // Also closes the override-account persistence gap: callers that switch
    // the account purely on the message wire (plan-approval Build kick-off,
    // composer-sent account) used to only rebuild the runtime — the DB row
    // kept the old account, so an app restart silently reverted the switch.
    // Syncing the resolved account here keeps memory and DB in one truth.
    {
        let sid = session_id.clone();
        let input_preview: String = crate::utils::safe_truncate_chars_to_string(&content, 100);
        let model_clone = effective_model.clone();
        let account_clone = effective_account_id.clone();
        let prev_account = tokio::task::spawn_blocking(move || {
            let mut prev_account: Option<Option<String>> = None;
            if let Ok(Some(mut db_session)) = session_persistence::get_session(&sid) {
                if db_session.user_input.is_none() {
                    db_session.user_input = Some(input_preview);
                    db_session.model = Some(model_clone);
                }
                if account_clone.is_some() && db_session.account_id != account_clone {
                    prev_account = Some(db_session.account_id.take());
                    db_session.account_id = account_clone;
                }
                if let Err(err) = session_persistence::upsert_session(&db_session) {
                    tracing::warn!("[session] Failed to upsert session {sid}: {err}");
                }
            } else {
                tracing::warn!("[session] DB row missing for {sid}, cannot persist status");
            }
            prev_account
        })
        .await
        .map_err(|err| err.to_string())?;
        // `Some(prev)` only when the account actually flipped above.
        if let (Some(prev), Some(to_account)) = (prev_account, effective_account_id.as_deref()) {
            crate::lifecycle::emit_session_account_switched(
                state.app_handle.as_ref(),
                &session_id,
                prev.as_deref(),
                to_account,
                Some(&effective_model),
            );
        }
    }

    // ── 5. Build the processing closure ──────────────────────────────────
    let sid_for_closure = session_id.clone();
    let content_for_closure = content.clone();
    let display_text_for_closure = display_text;
    let workspace_root_for_closure = effective_workspace_root.clone();
    let turn_intent_id_for_closure = effective_turn_intent_id.clone();
    // Resolve durable mode-control rows from exactly the bounded inbox batch
    // this background wake will drain. A control row in a later batch must
    // not change the mode of earlier work; rows become one-shot only when the
    // successful turn commits their read watermark.
    let inbox_control_mode = if let Some(run_id) = org_wake_run_id.as_deref() {
        let mode_session_id = session_id.clone();
        let mode_run_id = run_id.to_string();
        tokio::task::spawn_blocking(move || {
            resolve_agent_org_wake_mode(&mode_session_id, &mode_run_id)
        })
        .await
        .map_err(|error| format!("Agent Org pre-turn mode resolver failed: {error}"))??
    } else {
        None
    };
    // A direct human message owns this turn's mode. Do not consume the legacy
    // in-memory background override during intervention; durable unread rows
    // remain the source of truth for the next background wake.
    let coordinator_mode_override = org_wake_run_id
        .as_ref()
        .and_then(|_| session_handle.requested_exec_mode_cache.take(&session_id));
    let agent_mode = match inbox_control_mode.or(coordinator_mode_override) {
        Some(forced) => forced,
        None => resolve_agent_mode(mode.as_deref())?,
    };

    // Track the Plan-mode pre-mode snapshot.
    {
        let session = &session_handle;
        let current_mode = agent_mode;
        if matches!(current_mode, crate::session::AgentExecMode::Plan) {
            if session.pre_plan_mode_cache.get(&session_id).is_none() {
                let previous = restore_mode_before_plan_entry(
                    session.last_non_plan_mode_cache.get(&session_id),
                );
                session.pre_plan_mode_cache.set(&session_id, previous);
            }
        } else {
            session
                .last_non_plan_mode_cache
                .set(&session_id, current_mode);
        }
    }

    let execute: crate::session::scheduler::ExecuteFn = Box::new(move || {
        let sid = sid_for_closure;
        let content = content_for_closure;
        let display_text = display_text_for_closure;
        let workspace_root = workspace_root_for_closure;
        let session = session_for_closure;
        let turn_intent_id = turn_intent_id_for_closure;
        let org_wake_run_id = org_wake_run_id;

        Box::pin(async move {
            // Queued and coalesced messages are not running sessions. Promote
            // the DB state only when the scheduler actually begins execution.
            // For Agent Org wakes, re-check the run and update the session in
            // the same writer transaction used by run finality.
            let status_sid = sid.clone();
            let status_run_id = org_wake_run_id.clone();
            match tokio::task::spawn_blocking(move || {
                database::db::with_sessions_writer(|| -> Result<bool, String> {
                    let mut conn = database::db::get_connection().map_err(|err| err.to_string())?;
                    let tx = conn
                        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                        .map_err(|err| err.to_string())?;
                    let updated = if let Some(run_id) = status_run_id.as_deref() {
                        promote_agent_org_wake_session_to_running(&tx, run_id, &status_sid)?
                    } else {
                        tx.execute(
                            "UPDATE agent_sessions SET status=?1, updated_at=?2 WHERE session_id=?3",
                            rusqlite::params![
                                crate::session::SessionStatus::Running.as_str(),
                                chrono::Utc::now().to_rfc3339(),
                                &status_sid
                            ],
                        )
                        .map_err(|err| err.to_string())?
                    };
                    if updated != 1 {
                        if status_run_id.is_some() {
                            tx.commit().map_err(|err| err.to_string())?;
                            return Ok(false);
                        }
                        return Err(format!("session row missing at turn start: {status_sid}"));
                    }
                    tx.commit().map_err(|err| err.to_string())?;
                    Ok(true)
                })
            })
            .await
            {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => return Ok(String::new()),
                Ok(Err(err)) => return Err(format!("failed to persist running status: {err}")),
                Err(err) => return Err(format!("running-status task failed: {err}")),
            }

            // Clear any stale pre-turn cancel signal before starting a fresh
            // turn. A UserStop that lands while the session is idle (e.g. only
            // a background subagent is still running, the parent turn already
            // finished) takes the `keep_pre_turn_cancel_when_idle` branch in
            // `cancel_active_turn` and leaves `cancel_flag = true`. Without
            // this reset the *next* user message inherits that flag and the
            // turn loop self-cancels on iteration 1 (0 tokens, no response).
            // Messages that reach this closure have already passed the
            // scheduler's generation check, so a still-queued Send-Now that
            // Stop meant to discard was dropped as stale before getting here.
            cancel_flag.store(false, std::sync::atomic::Ordering::SeqCst);

            let turn_id = session.begin_turn(content.clone()).await;

            let input = crate::session::TurnInput {
                content: content.clone(),
                display_text,
                agent_mode: Some(agent_mode),
                images,
                ide_context,
                is_resume,
                channel: None,
                chat_id: None,
                turn_id: Some(turn_id.clone()),
                turn_intent_id,
            };

            let response =
                crate::session::process_message(Arc::clone(&session), input, app_handle.clone())
                    .await;

            let final_turn_state = if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                crate::session::DialogTurnState::Cancelled
            } else if response.is_ok() {
                crate::session::DialogTurnState::Completed
            } else {
                crate::session::DialogTurnState::Failed
            };

            let stats = response
                .as_ref()
                .ok()
                .map(|r| crate::session::TurnStats {
                    prompt_tokens: r.prompt_tokens,
                    completion_tokens: r.completion_tokens,
                    total_tokens: r.total_tokens,
                    context_tokens: 0,
                    tool_calls_count: r.tool_calls_count,
                    duration: None,
                })
                .unwrap_or_default();
            session.end_turn(final_turn_state, stats).await;

            let terminal_turn =
                response
                    .as_ref()
                    .ok()
                    .map(|r| crate::lifecycle::TerminalTurnSignal {
                        turn_id: r.turn_id.clone(),
                        status: match final_turn_state {
                            crate::session::DialogTurnState::Cancelled => {
                                crate::lifecycle::TurnTerminalStatus::Cancelled
                            }
                            crate::session::DialogTurnState::Failed => {
                                crate::lifecycle::TurnTerminalStatus::Failed
                            }
                            crate::session::DialogTurnState::Running
                            | crate::session::DialogTurnState::Completed => {
                                crate::lifecycle::TurnTerminalStatus::Completed
                            }
                        },
                        completed_at: chrono::Utc::now()
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    });

            let content_result = response.map(|r| r.content);

            crate::lifecycle::finalize_session(
                &sid,
                &content_result,
                app_handle.as_ref(),
                Some(workspace_root.as_path()),
                load_workspace_resources,
                terminal_turn,
            )
            .await;

            cancel_flag.store(false, std::sync::atomic::Ordering::SeqCst);

            content_result
        })
    });

    // ── 6. Enqueue and return immediately ────────────────────────────────
    let msg = crate::session::ScheduledMessage {
        kind: crate::session::ScheduledKind::Turn,
        message_id: uuid::Uuid::new_v4().to_string(),
        generation: 0,
        client_message_id,
        turn_intent_id: effective_turn_intent_id.clone(),
        org_run_id: effective_intent_org_run_id.clone(),
        content,
        execute,
    };

    // Lifecycle: record the intent as `queued` before handing the scheduler
    // ownership of the message. The scheduler worker promotes it to
    // `running` / terminal as the turn executes; `invalidate_pending`
    // marks it `stale` if rewound before it ran. See `session_turn_intents`
    // for the state machine.
    crate::foundation::session_bridge::upsert_turn_intent(
        &session_id,
        &effective_turn_intent_id,
        msg.client_message_id.as_deref(),
        effective_intent_org_run_id.as_deref(),
        source,
        crate::foundation::session_bridge::TurnIntentBridgeStatus::Queued,
    );

    let enqueue_result = session_handle
        .scheduler
        .enqueue(msg)
        .await
        .map_err(|err| format!("Failed to enqueue message: {err}"))?;

    tracing::info!(
        "[agent_send_message] Enqueued message {} at position {} for session {}",
        enqueue_result.message_id,
        enqueue_result.queue_position,
        session_id
    );

    Ok(AgentResponse {
        content: serde_json::json!({
            "queued": true,
            "messageId": enqueue_result.message_id,
            "queuePosition": enqueue_result.queue_position,
            "duplicate": enqueue_result.duplicate,
        })
        .to_string(),
        session_id,
        model: effective_model,
    })
}

fn restore_mode_before_plan_entry(
    last_non_plan_mode: Option<crate::session::AgentExecMode>,
) -> crate::session::AgentExecMode {
    last_non_plan_mode.unwrap_or(crate::session::AgentExecMode::Plan)
}

/// Resolve the requested exec mode for an inbound `agent_send_message` call.
///
/// Wire contract:
///   * `None` or empty string → `AgentExecMode::Build` (historical wire default).
///   * `Some("plan" | "build" | …)` → parsed via `AgentExecMode::parse`.
///   * `Some(<unknown>)` → `Err(...)` so a typo cannot silently downgrade a
///     read-only mode (`Plan` / `Ask` / `Review`) into `Build` (full
///     write access).
///
/// Background Agent Org wakes override this fallback only from a durable
/// `TaskAssigned` row whose task still belongs to that member.
/// `Build` remains the compatibility default for direct calls with no task
/// mode signal.
/// `#[doc(hidden)]` — the only external caller is the
/// `app::api::agent::test::workspace` debug route, reached through
/// `agent_core::debug::resolve_agent_mode`. Internal callers in
/// `agent_send_message` use the same function.
#[doc(hidden)]
pub fn resolve_agent_mode(mode: Option<&str>) -> Result<crate::session::AgentExecMode, String> {
    match mode.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(crate::session::AgentExecMode::Build),
        Some(value) => crate::session::AgentExecMode::parse(value)
            .ok_or_else(|| format!("Unknown agent exec mode: {value:?}")),
    }
}

/// Atomically claim a queued Agent Org Wake at the moment the scheduler
/// actually starts it. A pre-enqueue status check is only a snapshot: the Run
/// or member can be paused, archived, replaced, or put under direct user
/// intervention while the Wake waits in the queue.
fn promote_agent_org_wake_session_to_running(
    conn: &rusqlite::Connection,
    run_id: &str,
    session_id: &str,
) -> Result<usize, String> {
    use crate::coordination::agent_org_runs::{AgentOrgRunStatus, COORDINATOR_MEMBER_ID};
    use crate::session::SessionStatus;

    let wakeable = SessionStatus::AGENT_ORG_WAKEABLE;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "WITH RECURSIVE
         run_anchor(root_session_id) AS (
             SELECT root_session_id
             FROM agent_org_runs
             WHERE id=?4 AND status=?5 AND root_session_id IS NOT NULL
         ),
         descendants(session_id) AS (
             SELECT root_session_id FROM run_anchor
             UNION
             SELECT child.session_id
             FROM agent_sessions child
             JOIN descendants parent ON child.parent_session_id=parent.session_id
             WHERE NOT EXISTS (
                 SELECT 1 FROM agent_org_runs nested
                 WHERE nested.id<>?4
                   AND nested.root_session_id=child.session_id
             )
         ),
         ranked(session_id, member_rank) AS (
             SELECT session.session_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY CASE
                            WHEN session.session_id=anchor.root_session_id
                                THEN 'coordinator'
                            ELSE 'member:' || session.org_member_id
                        END
                        ORDER BY session.updated_at DESC, session.session_id DESC
                    )
             FROM agent_sessions session
             JOIN descendants USING (session_id)
             CROSS JOIN run_anchor anchor
             WHERE session.session_id=anchor.root_session_id
                OR (session.agent_definition_id IS NOT NULL
                    AND session.org_member_id IS NOT NULL)
         )
         UPDATE agent_sessions
         SET status=?1, updated_at=?2
         WHERE session_id=?3
           AND status IN (?6, ?7, ?8, ?9, ?10, ?11)
           AND session_id IN (
               SELECT session_id FROM ranked WHERE member_rank=1
           )
           AND NOT EXISTS (
               SELECT 1
               FROM agent_member_interventions intervention
               WHERE intervention.org_run_id=?4
                 AND intervention.member_id=CASE
                     WHEN agent_sessions.session_id=(SELECT root_session_id FROM run_anchor)
                         THEN ?12
                     ELSE agent_sessions.org_member_id
                 END
                 AND intervention.cleared_at IS NULL
                 AND datetime(intervention.resume_after)>datetime(?13)
           )",
        rusqlite::params![
            SessionStatus::Running.as_str(),
            &now,
            session_id,
            run_id,
            AgentOrgRunStatus::Running.as_str(),
            wakeable[0].as_str(),
            wakeable[1].as_str(),
            wakeable[2].as_str(),
            wakeable[3].as_str(),
            wakeable[4].as_str(),
            wakeable[5].as_str(),
            COORDINATOR_MEMBER_ID,
            &now,
        ],
    )
    .map_err(|error| error.to_string())
}

/// Resolve the execution mode for one background Agent Org wake from unread
/// control envelopes in durable inbox order.
///
/// Every applicable row updates the candidate, so the latest valid control
/// signal wins. TaskAssigned is only a doorbell: its mode is re-read from the
/// current durable task rather than trusted from a possibly stale payload.
/// Direct human turns never call this resolver.
fn resolve_agent_org_wake_mode(
    session_id: &str,
    run_id: &str,
) -> Result<Option<crate::session::AgentExecMode>, String> {
    use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
    use crate::coordination::agent_org_tasks::TaskExecutionMode;
    use rusqlite::{params, OptionalExtension, TransactionBehavior};

    let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let member_id: String = tx
        .query_row(
            "SELECT org_member_id FROM agent_sessions
             WHERE session_id=?1 AND org_member_id IS NOT NULL",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Agent Org wake session {session_id} has no canonical member_id"))?;

    let mut stmt = tx
        .prepare(
            "WITH delivery_candidates AS (
                 SELECT id, payload_kind, payload_json, sender_member_id
                 FROM agent_inbox
                 WHERE org_run_id=?1
                   AND recipient_member_id=?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
                   )
                 ORDER BY id ASC
                 LIMIT ?3
             ), delivery_window AS (
                 SELECT id, payload_kind, payload_json, sender_member_id,
                        ROW_NUMBER() OVER (ORDER BY id ASC) AS ordinal,
                        SUM(length(CAST(payload_json AS BLOB))) OVER (
                            ORDER BY id ASC ROWS UNBOUNDED PRECEDING
                        ) AS cumulative_payload_bytes
                 FROM delivery_candidates
             ), control AS (
                 SELECT id, payload_kind, payload_json, sender_member_id
                 FROM delivery_window
                 WHERE (ordinal=1 OR cumulative_payload_bytes<=?4)
                   AND payload_kind IN (
                       'task_assigned',
                       'plan_approval_response',
                       'exec_mode_set_request'
                   )
                   AND json_valid(payload_json)
             )
             SELECT control.payload_kind,
                    control.sender_member_id,
                    assigned.owner,
                    assigned.status,
                    CASE WHEN json_valid(assigned.metadata_json) THEN
                        CASE WHEN json_type(assigned.metadata_json, '$.execution_mode')='text'
                             THEN json_extract(assigned.metadata_json, '$.execution_mode')
                             ELSE 'build' END
                    ELSE 'build' END AS durable_task_mode,
                    approval.source_member_id,
                    approval_task.owner,
                    approval_task.status,
                    CASE WHEN json_type(control.payload_json, '$.accepted') IN ('true','false')
                         THEN json_extract(control.payload_json, '$.accepted')
                         ELSE NULL END,
                    CASE WHEN json_type(control.payload_json, '$.next_mode')='text'
                         THEN json_extract(control.payload_json, '$.next_mode')
                         ELSE NULL END,
                    CASE WHEN json_type(control.payload_json, '$.mode')='text'
                         THEN json_extract(control.payload_json, '$.mode')
                         ELSE NULL END,
                    EXISTS(
                        SELECT 1 FROM agent_org_tasks owned
                        WHERE owned.org_run_id=?1
                          AND owned.owner=?2
                          AND owned.status IN ('pending','in_progress')
                    ) AS has_open_owned_task
             FROM control
             LEFT JOIN agent_org_tasks assigned
               ON control.payload_kind='task_assigned'
              AND json_type(control.payload_json, '$.task_id')='text'
              AND assigned.org_run_id=?1
              AND assigned.id=json_extract(control.payload_json, '$.task_id')
             LEFT JOIN agent_org_plan_approvals approval
               ON control.payload_kind='plan_approval_response'
              AND json_type(control.payload_json, '$.request_id')='text'
              AND approval.org_run_id=?1
              AND approval.request_id=json_extract(control.payload_json, '$.request_id')
             LEFT JOIN agent_org_tasks approval_task
               ON approval_task.org_run_id=?1
              AND approval_task.id=approval.source_task_id
             ORDER BY control.id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![
                run_id,
                &member_id,
                crate::coordination::agent_inbox::MAX_INBOX_DRAIN_ROWS as i64,
                crate::coordination::agent_inbox::MAX_INBOX_DRAIN_PAYLOAD_BYTES as i64,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<bool>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, bool>(11)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let mut resolved = None;
    for row in rows {
        let (
            kind,
            sender_member_id,
            assigned_owner,
            assigned_status,
            durable_task_mode,
            approval_source_member,
            approval_task_owner,
            approval_task_status,
            accepted,
            next_mode,
            requested_mode,
            has_open_owned_task,
        ) = row.map_err(|error| error.to_string())?;
        let mode = match kind.as_str() {
            "task_assigned"
                if assigned_owner.as_deref() == Some(member_id.as_str())
                    && matches!(assigned_status.as_deref(), Some("pending" | "in_progress")) =>
            {
                durable_task_mode
                    .as_deref()
                    .and_then(|mode| TaskExecutionMode::from_wire(mode).ok())
                    .map(|mode| match mode {
                        TaskExecutionMode::Build => crate::session::AgentExecMode::Build,
                        TaskExecutionMode::Plan => crate::session::AgentExecMode::Plan,
                    })
            }
            "plan_approval_response"
                if sender_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID)
                    && approval_source_member.as_deref() == Some(member_id.as_str())
                    && approval_task_owner.as_deref() == Some(member_id.as_str())
                    && matches!(
                        approval_task_status.as_deref(),
                        Some("pending" | "in_progress")
                    ) =>
            {
                next_mode
                    .as_deref()
                    .and_then(crate::session::AgentExecMode::parse)
                    .or_else(|| {
                        accepted.map(|accepted| {
                            if accepted {
                                crate::session::AgentExecMode::Build
                            } else {
                                crate::session::AgentExecMode::Plan
                            }
                        })
                    })
            }
            "exec_mode_set_request"
                if sender_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID)
                    && has_open_owned_task =>
            {
                requested_mode
                    .as_deref()
                    .and_then(crate::session::AgentExecMode::parse)
            }
            _ => None,
        };
        if mode.is_some() {
            resolved = mode;
            break;
        }
    }
    drop(stmt);
    tx.commit().map_err(|error| error.to_string())?;
    Ok(resolved)
}

#[cfg(test)]
mod resolve_agent_mode_tests {
    use super::{
        promote_agent_org_wake_session_to_running, resolve_agent_mode, resolve_agent_org_wake_mode,
        restore_mode_before_plan_entry,
    };
    use crate::coordination::agent_inbox::{
        AgentInboxStore, AgentMessage, InsertInboxParams, RequestId,
    };
    use crate::coordination::agent_member_interventions::{
        can_enter_member_intervention, AgentMemberInterventionStore, EnterMemberInterventionParams,
    };
    use crate::coordination::agent_org_plan_approvals::{
        AgentOrgPlanApprovalStore, CreateAgentOrgPlanApprovalParams,
    };
    use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
    use crate::coordination::agent_org_runs::{
        AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    };
    use crate::coordination::agent_org_tasks::{
        enqueue_task_assigned_to_with_tasks, AgentOrgTaskStore, CreateTaskParams, TaskStatus,
        TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_EXECUTION_MODE,
    };
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};
    use crate::session::{AgentExecMode, SessionStatus};
    use core_types::key_source::KeySource;

    struct WakeModeFixture {
        _sandbox: test_helpers::test_env::SandboxGuard,
        run_id: String,
        session_id: String,
        member_id: String,
        task_id: String,
    }

    fn setup_wake_mode_fixture(execution_mode: &str, task_status: TaskStatus) -> WakeModeFixture {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().expect("test db");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::session::persistence::init(&conn).expect("session schema");
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schema");

        let member_id = "planner".to_string();
        let session_id = "planner-session".to_string();
        let org = OrgDefinition {
            id: format!("org-mode-{}", uuid::Uuid::new_v4()),
            name: "Mode Resolver Org".into(),
            role: "Coordinator".into(),
            agent_id: "coordinator-agent".into(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: vec![OrgMember {
                id: member_id.clone(),
                name: "Planner".into(),
                role: "Planner".into(),
                agent_id: "planner-agent".into(),
                runtime_config: None,
                children: Vec::new(),
            }],
        };
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: org.id.clone(),
            coordinator_agent_id: org.agent_id.clone(),
            root_session_id: Some("root-session".into()),
            org_snapshot: org,
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create run");
        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: "root-session".into(),
                name: "Coordinator".into(),
                status: "idle".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                session_type: "sde".into(),
                org_member_id: Some(COORDINATOR_MEMBER_ID.into()),
                agent_definition_id: Some("coordinator-agent".into()),
                key_source: KeySource::OwnKey,
                ..Default::default()
            },
        )
        .expect("seed coordinator session");
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: session_id.clone(),
                name: "Planner".into(),
                status: "idle".into(),
                created_at: now.clone(),
                updated_at: now,
                session_type: "sde".into(),
                org_member_id: Some(member_id.clone()),
                parent_session_id: Some("root-session".into()),
                agent_definition_id: Some("planner-agent".into()),
                key_source: KeySource::OwnKey,
                ..Default::default()
            },
        )
        .expect("seed member session");
        let task_id = "mode-task".to_string();
        AgentOrgTaskStore::create(CreateTaskParams {
            id: task_id.clone(),
            org_run_id: run.id.clone(),
            subject: "Controlled work".into(),
            description: String::new(),
            active_form: None,
            owner: Some(member_id.clone()),
            status: task_status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                TASK_METADATA_EXECUTION_MODE: execution_mode,
            })),
        })
        .expect("create controlled task");

        WakeModeFixture {
            _sandbox: sandbox,
            run_id: run.id,
            session_id,
            member_id,
            task_id,
        }
    }

    fn insert_control(
        fixture: &WakeModeFixture,
        sender_member_id: &str,
        message: AgentMessage,
    ) -> i64 {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "planner-agent".into(),
            recipient_member_id: Some(fixture.member_id.clone()),
            sender_agent_id: if sender_member_id == COORDINATOR_MEMBER_ID {
                "coordinator-agent".into()
            } else {
                "peer-agent".into()
            },
            sender_member_id: Some(sender_member_id.into()),
            org_run_id: Some(fixture.run_id.clone()),
            message,
        })
        .expect("insert control row")
        .id
    }

    /// Historical callers without a task-scoped mode keep Build semantics.
    #[test]
    fn wake_defaults_to_build() {
        assert_eq!(resolve_agent_mode(None).unwrap(), AgentExecMode::Build);
    }

    #[test]
    fn empty_string_defaults_to_build() {
        assert_eq!(resolve_agent_mode(Some("")).unwrap(), AgentExecMode::Build);
        assert_eq!(
            resolve_agent_mode(Some("   ")).unwrap(),
            AgentExecMode::Build
        );
    }

    #[test]
    fn explicit_plan_parses() {
        assert_eq!(
            resolve_agent_mode(Some("plan")).unwrap(),
            AgentExecMode::Plan
        );
    }

    #[test]
    fn queued_agent_org_wake_rechecks_run_member_and_intervention_at_turn_start() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        let conn = database::db::get_connection().expect("test db");

        assert_eq!(
            promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
                .expect("claim valid wake"),
            1
        );

        for invalid_status in [SessionStatus::Paused, SessionStatus::Archived] {
            conn.execute(
                "UPDATE agent_sessions SET status=?1 WHERE session_id=?2",
                rusqlite::params![invalid_status.as_str(), &fixture.session_id],
            )
            .expect("set invalid member status");
            assert_eq!(
                promote_agent_org_wake_session_to_running(
                    &conn,
                    &fixture.run_id,
                    &fixture.session_id,
                )
                .expect("invalid wake is a no-op"),
                0,
                "queued wake must not revive {invalid_status:?} member"
            );
        }

        conn.execute(
            "UPDATE agent_sessions SET status='idle' WHERE session_id=?1",
            rusqlite::params![&fixture.session_id],
        )
        .expect("restore member idle");
        conn.execute(
            "UPDATE agent_org_runs SET status='paused' WHERE id=?1",
            rusqlite::params![&fixture.run_id],
        )
        .expect("pause run");
        assert_eq!(
            promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
                .expect("paused run wake is a no-op"),
            0
        );

        conn.execute(
            "UPDATE agent_org_runs SET status='running' WHERE id=?1",
            rusqlite::params![&fixture.run_id],
        )
        .expect("resume run");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: fixture.run_id.clone(),
            member_id: fixture.member_id.clone(),
            agent_id: "planner-agent".into(),
            session_id: fixture.session_id.clone(),
            reason: Some("User is directly inspecting the planner".into()),
            ttl_secs: 60,
        })
        .expect("enter intervention");
        assert_eq!(
            promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
                .expect("intervened wake is a no-op"),
            0
        );
    }

    #[test]
    fn queued_outer_run_wake_cannot_claim_a_nested_run_session() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        let nested_root = "nested-root-session";
        let nested_worker = "nested-planner-session";
        let nested_org = OrgDefinition {
            id: format!("nested-org-{}", uuid::Uuid::new_v4()),
            name: "Nested Org".into(),
            role: "Coordinator".into(),
            agent_id: "nested-coordinator-agent".into(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: vec![OrgMember {
                id: fixture.member_id.clone(),
                name: "Nested Planner".into(),
                role: "Planner".into(),
                agent_id: "planner-agent".into(),
                runtime_config: None,
                children: Vec::new(),
            }],
        };
        AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: nested_org.id.clone(),
            coordinator_agent_id: nested_org.agent_id.clone(),
            root_session_id: Some(nested_root.into()),
            org_snapshot: nested_org,
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create nested run");

        let now = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: nested_root.into(),
                name: "Nested Coordinator".into(),
                status: "idle".into(),
                created_at: now.clone(),
                updated_at: now.clone(),
                session_type: "sde".into(),
                org_member_id: Some(COORDINATOR_MEMBER_ID.into()),
                parent_session_id: Some(fixture.session_id.clone()),
                agent_definition_id: Some("nested-coordinator-agent".into()),
                key_source: KeySource::OwnKey,
                ..Default::default()
            },
        )
        .expect("seed nested root");
        crate::session::persistence::upsert_session(
            &crate::session::persistence::UnifiedSessionRecord {
                session_id: nested_worker.into(),
                name: "Nested Planner".into(),
                status: "idle".into(),
                created_at: now.clone(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                session_type: "sde".into(),
                org_member_id: Some(fixture.member_id.clone()),
                parent_session_id: Some(nested_root.into()),
                agent_definition_id: Some("planner-agent".into()),
                key_source: KeySource::OwnKey,
                ..Default::default()
            },
        )
        .expect("seed nested worker");

        let conn = database::db::get_connection().expect("test db");
        assert_eq!(
            promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, nested_worker)
                .expect("reject nested session"),
            0
        );
        assert_eq!(
            promote_agent_org_wake_session_to_running(&conn, &fixture.run_id, &fixture.session_id,)
                .expect("claim outer member despite fresher nested session"),
            1
        );
    }

    #[test]
    fn plan_entry_without_prior_non_plan_mode_restores_to_plan() {
        assert_eq!(restore_mode_before_plan_entry(None), AgentExecMode::Plan);
    }

    #[test]
    fn plan_entry_after_build_restores_to_build() {
        assert_eq!(
            restore_mode_before_plan_entry(Some(AgentExecMode::Build)),
            AgentExecMode::Build
        );
    }

    #[test]
    fn unknown_mode_is_rejected_not_silently_downgraded() {
        let err = resolve_agent_mode(Some("plann")).unwrap_err();
        assert!(
            err.contains("Unknown agent exec mode"),
            "expected typo to fail loudly, got: {err}"
        );
    }

    #[test]
    fn ordinary_coordinator_message_is_not_a_member_takeover() {
        assert!(!can_enter_member_intervention(COORDINATOR_MEMBER_ID));
    }

    #[test]
    fn direct_worker_message_is_a_member_takeover() {
        assert!(can_enter_member_intervention("member-planner"));
    }

    #[test]
    fn plan_changes_request_controls_the_first_revision_wake() {
        let fixture = setup_wake_mode_fixture("plan", TaskStatus::InProgress);
        let approval =
            AgentOrgPlanApprovalStore::create_pending(CreateAgentOrgPlanApprovalParams {
                request_id: "revision-request".into(),
                org_run_id: fixture.run_id.clone(),
                source_task_id: fixture.task_id.clone(),
                source_member_id: fixture.member_id.clone(),
                source_session_id: fixture.session_id.clone(),
                root_session_id: "root-session".into(),
                policy: PlanApprovalPolicy::Coordinator,
                plan_title: "Initial plan".into(),
                plan_path: AgentOrgPlanApprovalStore::managed_plan_path_for_session(
                    &fixture.session_id,
                    "initial.plan.md",
                )
                .expect("managed initial plan path")
                .to_string_lossy()
                .into_owned(),
                plan_content: "# Initial".into(),
            })
            .expect("create plan approval");
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::PlanApprovalResponse {
                request_id: RequestId(approval.request_id),
                accepted: false,
                feedback: Some("revise scope".into()),
                next_mode: Some(AgentExecMode::Plan),
            },
        );

        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("resolve revision mode"),
            Some(AgentExecMode::Plan)
        );
    }

    #[test]
    fn coordinator_exec_override_controls_the_first_wake() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::ExecModeSetRequest {
                request_id: RequestId("override-plan".into()),
                mode: AgentExecMode::Plan,
                reason: Some("plan before implementation".into()),
            },
        );
        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("resolve override"),
            Some(AgentExecMode::Plan)
        );
    }

    #[test]
    fn latest_applicable_control_wins_and_task_mode_comes_from_durable_state() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::ExecModeSetRequest {
                request_id: RequestId("first-plan".into()),
                mode: AgentExecMode::Plan,
                reason: None,
            },
        );
        let tasks = AgentOrgTaskStore::list(&fixture.run_id).expect("list task board");
        let task = tasks
            .iter()
            .find(|task| task.id == fixture.task_id)
            .expect("controlled task");
        enqueue_task_assigned_to_with_tasks(
            task,
            &tasks,
            "planner-agent",
            &fixture.member_id,
            "coordinator-agent",
            Some(COORDINATOR_MEMBER_ID),
            "Coordinator",
        )
        .expect("insert later TaskAssigned");

        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("resolve latest signal"),
            Some(AgentExecMode::Build),
            "later TaskAssigned wins, and its mode is re-read from the durable Build task"
        );
    }

    #[test]
    fn forged_peer_exec_override_is_ignored() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        insert_control(
            &fixture,
            "peer",
            AgentMessage::ExecModeSetRequest {
                request_id: RequestId("forged-plan".into()),
                mode: AgentExecMode::Plan,
                reason: None,
            },
        );
        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("ignore forged override"),
            None
        );
    }

    #[test]
    fn malformed_historical_control_row_is_ignored_without_poisoning_wake() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        let conn = database::db::get_connection().expect("test db");
        conn.execute(
            "INSERT INTO agent_inbox (
                 recipient_agent_id, recipient_member_id, sender_agent_id,
                 sender_member_id, org_run_id, payload_kind, payload_json,
                 created_at
             ) VALUES (
                 'planner-agent', ?1, 'coordinator-agent', 'coordinator', ?2,
                 'exec_mode_set_request',
                 '{\"kind\":\"exec_mode_set_request\",\"request_id\":7,\"mode\":{\"bad\":true}}',
                 ?3
             )",
            rusqlite::params![
                &fixture.member_id,
                &fixture.run_id,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .expect("seed malformed historical control row");

        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("malformed control must degrade to ignored"),
            None
        );
    }

    #[test]
    fn control_beyond_current_drain_row_batch_does_not_change_this_turn_mode() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        for index in 0..crate::coordination::agent_inbox::MAX_INBOX_DRAIN_ROWS {
            insert_control(
                &fixture,
                COORDINATOR_MEMBER_ID,
                AgentMessage::Plain {
                    summary: format!("older-{index}"),
                    text: "ordinary work context".into(),
                },
            );
        }
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::ExecModeSetRequest {
                request_id: RequestId("future-plan".into()),
                mode: AgentExecMode::Plan,
                reason: None,
            },
        );

        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("future batch control must not affect this turn"),
            None
        );
    }

    #[test]
    fn control_beyond_current_drain_byte_budget_does_not_change_this_turn_mode() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        let large_text = "🧭".repeat(19_000);
        for index in 0..20 {
            insert_control(
                &fixture,
                COORDINATOR_MEMBER_ID,
                AgentMessage::Plain {
                    summary: format!("large-{index}"),
                    text: large_text.clone(),
                },
            );
        }
        insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::ExecModeSetRequest {
                request_id: RequestId("later-byte-plan".into()),
                mode: AgentExecMode::Plan,
                reason: None,
            },
        );

        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("byte-deferred control must not affect this turn"),
            None
        );
    }

    #[test]
    fn consumed_plan_control_does_not_repeat_on_next_turn() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        let row_id = insert_control(
            &fixture,
            COORDINATOR_MEMBER_ID,
            AgentMessage::ExecModeSetRequest {
                request_id: RequestId("one-shot-plan".into()),
                mode: AgentExecMode::Plan,
                reason: None,
            },
        );
        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id).unwrap(),
            Some(AgentExecMode::Plan)
        );
        AgentInboxStore::mark_many_read(&[row_id]).expect("commit successful wake");
        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id).unwrap(),
            None
        );
    }

    #[test]
    fn ownerless_plan_task_does_not_select_member_mode() {
        let fixture = setup_wake_mode_fixture("build", TaskStatus::Pending);
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "plan-from-pool".to_string(),
            org_run_id: fixture.run_id.clone(),
            subject: "Plan the work".to_string(),
            description: String::new(),
            active_form: None,
            owner: None,
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["planner"],
                TASK_METADATA_EXECUTION_MODE: "plan",
            })),
        })
        .expect("seed ownerless task");

        assert_eq!(
            resolve_agent_org_wake_mode(&fixture.session_id, &fixture.run_id)
                .expect("resolve mode"),
            None
        );
    }
}
