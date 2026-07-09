//! Session messaging logic (`agent_send_message` implementation).

use std::sync::Arc;

use crate::foundation::session_bridge::TurnIntentBridgeSource;
use crate::persistence::AgentResponse;
use crate::session::persistence as session_persistence;
use crate::state::AgentAppState;

use super::identity::{resolve_session_identity, IdentityOverrides};
use crate::coordination::agent_member_interventions::{
    AgentMemberInterventionStore, EnterMemberInterventionParams, DEFAULT_INTERVENTION_TTL_SECS,
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
        TurnIntentBridgeSource::Resume,
    )
    .await
}

/// Wake-only entry point for the inbox auto-resume hook.
///
/// Equivalent to calling [`send_message_impl`] with empty content,
/// `is_resume = true`, and otherwise default identity. The combination
/// `(content="", is_resume=true)` triggers the
/// `should_save_user_msg = !(context.is_resume && content.is_empty())`
/// branch in the unified processor, which deliberately skips persisting
/// an empty user row. The `inbox_drain` hook then injects the
/// recipient's unread inbox payload as the actual user attachment at
/// turn-boundary entry, so the resumed turn opens with a real user
/// message instead of a synthetic empty one.
pub async fn send_message_impl_for_wake(
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
                    let agent_id = org_context.require_participant_agent_id(&member_id)?;
                    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
                        org_run_id,
                        member_id,
                        agent_id,
                        session_id: session_id_for_intervention,
                        reason: Some("direct_user_chat".to_string()),
                        ttl_secs: DEFAULT_INTERVENTION_TTL_SECS,
                    })
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

    // ── 4. Persist initial status and user_input (single DB write) ───────
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
                db_session.status = crate::session::SessionStatus::Running.as_str().to_owned();
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
    // If the coordinator queued an `ExecModeSetRequest` override on
    // this member, consume it now (before defaulting to the
    // wire-supplied mode). The override is one-shot — `take` clears
    // it so a follow-up turn falls back to the regular wire value
    // unless the coordinator sends another override.
    let coordinator_mode_override = session_handle.requested_exec_mode_cache.take(&session_id);
    let agent_mode = match coordinator_mode_override {
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

        Box::pin(async move {
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
        source,
        crate::foundation::session_bridge::TurnIntentBridgeStatus::Queued,
    );

    let enqueue_result = session_handle
        .scheduler
        .enqueue(msg)
        .await
        .map_err(|err| format!("Failed to enqueue message: {}", err))?;

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
/// **Pinned invariant for `send_message_impl_for_wake`**: that helper
/// always passes `mode = None`, so a wake-resumed turn ALWAYS opens in
/// `Build`. This is what the plan-approval flow depends on — after the
/// coordinator approves a member's plan and wakes the member session,
/// the resumed turn must run in `Build` (write-enabled), not stay in
/// `Plan` (read-only). Changing the `None` arm to anything other than
/// `Build` would silently strand approved members in read-only mode;
/// the `wake_defaults_to_build` unit test below pins this contract.
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

#[cfg(test)]
mod resolve_agent_mode_tests {
    use super::{resolve_agent_mode, restore_mode_before_plan_entry};
    use crate::session::AgentExecMode;

    /// Pins the implicit contract used by `send_message_impl_for_wake`:
    /// passing `None` (the wake helper's default) yields `Build`. If
    /// this assertion ever flips, the plan-approval wake path silently
    /// keeps the member session in `Plan` mode after the coordinator
    /// approves, leaving the resumed turn read-only when it should be
    /// write-enabled.
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
}
