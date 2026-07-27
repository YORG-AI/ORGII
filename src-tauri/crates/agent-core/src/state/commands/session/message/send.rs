//! The single turn-submission path (`agent_send_message` implementation).
//!
//! Every source of a turn — composer submit, force-send, queue flush,
//! plan-approval re-entry, mobile remote, background subagent and Agent Org
//! wakes — funnels through [`send_message_impl`]. It resolves identity, lazily
//! initializes the runtime, persists the identity/user-input snapshot, decides
//! between mid-turn steering and a fresh enqueue, and hands the scheduler a
//! closure that owns the turn's lifecycle from running-status promotion to
//! finalization.

use std::sync::Arc;

use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionStore, EnterMemberInterventionParams,
    DEFAULT_INTERVENTION_TTL_SECS,
};
use crate::foundation::session_bridge::TurnIntentBridgeSource;
use crate::persistence::AgentResponse;
use crate::session::persistence as session_persistence;
use crate::state::commands::session::identity::{resolve_session_identity, IdentityOverrides};
use crate::state::commands::session::org_tasks;
use crate::state::AgentAppState;

use super::exec_mode::{resolve_agent_mode, restore_mode_before_plan_entry};
use super::org_wake::{promote_agent_org_wake_session_to_running, resolve_agent_org_wake_mode};

async fn persist_direct_user_intervention(
    params: Option<EnterMemberInterventionParams>,
) -> Result<(), String> {
    let Some(params) = params else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || AgentMemberInterventionStore::enter(params).map(|_| ()))
        .await
        .map_err(|err| format!("Agent Org intervention worker failed: {err}"))?
}

pub(super) fn should_divert_to_mid_turn_steering(
    source: TurnIntentBridgeSource,
    is_resume: bool,
    content: &str,
    images: Option<&[String]>,
    is_turn_processing: bool,
) -> bool {
    matches!(source, TurnIntentBridgeSource::UserSubmit)
        && !is_resume
        && !content.trim().is_empty()
        && images.map(|items| items.is_empty()).unwrap_or(true)
        && is_turn_processing
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

    // Scheduler messages keep the current run id in memory so post-turn
    // finality can reconcile the run that actually produced this turn. The
    // durable turn-intent bridge remains session-scoped; nested-run intent
    // ownership belongs to the later red-team hardening change.
    let scheduled_org_run_id = runtime
        .agent_org_context
        .as_ref()
        .map(|context| context.run_id.clone());

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
        let _ = org_tasks::resume_paused_run_for_user_message(state, &session_id).await?;
    }

    let direct_user_intervention =
        if mark_direct_user_intervention && !is_resume && !content.trim().is_empty() {
            let runtime_snapshot = session_handle.runtime.read().await.clone();
            match runtime_snapshot.and_then(|runtime| runtime.agent_org_context.clone()) {
                Some(org_context) => {
                    let session_id_for_intervention = session_id.clone();
                    let member_id = tokio::task::spawn_blocking(move || {
                        crate::session::persistence::get_session(&session_id_for_intervention)
                            .map_err(|err| err.to_string())?
                            .and_then(|record| record.org_member_id)
                            .ok_or_else(|| {
                                format!(
                                    "Agent Org session {} has no canonical member_id",
                                    session_id_for_intervention
                                )
                            })
                    })
                    .await
                    .map_err(|err| format!("Agent Org member lookup worker failed: {err}"))??;
                    if can_enter_member_intervention(&member_id) {
                        let agent_id = org_context.require_participant_agent_id(&member_id)?;
                        Some(EnterMemberInterventionParams {
                            org_run_id: org_context.run_id,
                            member_id,
                            agent_id,
                            session_id: session_id.clone(),
                            reason: Some("direct_user_chat".to_string()),
                            ttl_secs: DEFAULT_INTERVENTION_TTL_SECS,
                        })
                    } else {
                        tracing::debug!(
                            org_run_id = %org_context.run_id,
                            session_id = %session_id,
                            "ordinary coordinator message does not enter member intervention"
                        );
                        None
                    }
                }
                None => None,
            }
        } else {
            None
        };

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
    if should_divert_to_mid_turn_steering(
        source,
        is_resume,
        &content,
        images.as_deref(),
        session_handle.scheduler.is_turn_processing(),
    ) {
        // Steering mutates an already-running member turn, so intervention is
        // part of accepting the control action. If the durable takeover row
        // cannot be written, do not inject a message that Wake may race.
        persist_direct_user_intervention(direct_user_intervention.clone()).await?;
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
    let direct_user_intervention_for_closure = direct_user_intervention;
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
        let direct_user_intervention = direct_user_intervention_for_closure;
        let org_wake_run_id = org_wake_run_id;

        Box::pin(async move {
            // The scheduler now owns this accepted turn. Intervention is a
            // turn-start side effect, not submit preflight: queued work that is
            // invalidated before execution must never leave a takeover row.
            persist_direct_user_intervention(direct_user_intervention).await?;
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
                turn_intent_id: turn_intent_id.clone(),
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
                        turn_intent_id: Some(turn_intent_id.clone()),
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
        org_run_id: scheduled_org_run_id,
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
