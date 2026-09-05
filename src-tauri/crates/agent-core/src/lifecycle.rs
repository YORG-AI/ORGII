//! Shared lifecycle helpers for agent sessions.
//!
//! Deduplicates the post-processing that command handlers and background-task
//! launchers perform after `process_message` completes.

use core_types::session_event::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};
use serde::Serialize;
use tauri::Emitter;

use crate::bus::{broadcast_event, event_pipeline_bridge};
use crate::coordination::agent_inbox::MemberIdleReason;
use crate::coordination::agent_org_runs::{AgentOrgRunContext, AgentOrgRunStore};
use crate::coordination::agent_org_tasks::{
    self, AgentOrgTaskStore, Task, TASK_METADATA_REQUIRED_ROLE,
};
use crate::persistence::db_helpers::AgentSessionStatus;
use crate::session::persistence as session_persistence;
use crate::session::turn::streaming::classify_streaming_error_message;
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::InboxWakeHook;

fn e2e_background_llm_disabled() -> bool {
    std::env::var("ORGII_E2E_DISABLE_BACKGROUND_LLM")
        .ok()
        .as_deref()
        == Some("1")
}

/// Wire payload emitted as "session-status-changed" to all Tauri windows so
/// the frontend can update `sessionsAtom` without waiting for the next full
/// session-list poll.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusChangedPayload<'a> {
    session_id: &'a str,
    status: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRenamedPayload<'a> {
    session_id: &'a str,
    name: &'a str,
}

pub fn emit_session_renamed(app_handle: Option<&tauri::AppHandle>, session_id: &str, name: &str) {
    let Some(handle) = app_handle else {
        return;
    };

    if let Err(err) = handle.emit(
        "session-renamed",
        SessionRenamedPayload { session_id, name },
    ) {
        tracing::warn!(
            "[lifecycle] Failed to emit session-renamed for {}: {}",
            session_id,
            err
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnTerminalStatus {
    Completed,
    Cancelled,
    Failed,
}

impl TurnTerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalTurnSignal {
    pub turn_id: String,
    pub turn_intent_id: Option<String>,
    pub status: TurnTerminalStatus,
    pub completed_at: String,
}

fn emit_session_status_changed(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    status: AgentSessionStatus,
) {
    let Some(handle) = app_handle else {
        return;
    };

    if let Err(err) = handle.emit(
        "session-status-changed",
        SessionStatusChangedPayload {
            session_id,
            status: status.as_ref(),
        },
    ) {
        tracing::warn!(
            "[lifecycle] Failed to emit session-status-changed for {}: {}",
            session_id,
            err
        );
    }
}

/// Wire payload emitted as "session-account-switched" to all Tauri windows.
///
/// Single event chokepoint for EVERY path that changes a session's account
/// (session_patch, send_message_impl override sync, channel switch,
/// cli_agent_message). Cross-window UIs listen for this instead of relying
/// on the initiating window's optimistic update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionAccountSwitchedPayload<'a> {
    session_id: &'a str,
    from_account_id: Option<&'a str>,
    to_account_id: &'a str,
    model: Option<&'a str>,
}

pub fn emit_session_account_switched(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    from_account_id: Option<&str>,
    to_account_id: &str,
    model: Option<&str>,
) {
    let Some(handle) = app_handle else {
        return;
    };

    if let Err(err) = handle.emit(
        "session-account-switched",
        SessionAccountSwitchedPayload {
            session_id,
            from_account_id,
            to_account_id,
            model,
        },
    ) {
        tracing::warn!(
            "[lifecycle] Failed to emit session-account-switched for {}: {}",
            session_id,
            err
        );
    }
}

fn persist_and_emit_terminal_turn(
    session_id: &str,
    terminal_turn: &TerminalTurnSignal,
    final_status: AgentSessionStatus,
    app_handle: Option<&tauri::AppHandle>,
) {
    let session_status: crate::session::SessionStatus = final_status.into();
    match session_persistence::finalize_terminal_turn_status(
        session_id,
        &terminal_turn.turn_id,
        terminal_turn.status.as_str(),
        session_status,
        &terminal_turn.completed_at,
    ) {
        Ok(true) => {}
        Ok(false) => tracing::warn!(
            session_id = %session_id,
            turn_id = %terminal_turn.turn_id,
            "[lifecycle] terminal turn marker was not persisted because the session row was missing"
        ),
        Err(err) => tracing::warn!(
            session_id = %session_id,
            turn_id = %terminal_turn.turn_id,
            error = %err,
            "[lifecycle] failed to persist terminal turn marker"
        ),
    }

    emit_session_status_changed(app_handle, session_id, final_status);

    broadcast_event(
        "agent:turn_completed",
        serde_json::json!({
            "sessionId": session_id,
            "turnId": terminal_turn.turn_id,
            "turnIntentId": terminal_turn.turn_intent_id,
            "turnStatus": terminal_turn.status.as_str(),
            "sessionStatus": final_status.as_ref(),
            "completedAt": terminal_turn.completed_at,
            "persisted": true,
        }),
    );
}

pub fn build_session_error_event(session_id: &str, message: &str) -> SessionEvent {
    let now = chrono::Utc::now().to_rfc3339();
    let event_id = format!(
        "session-error-{session_id}-{}",
        uuid::Uuid::new_v4().simple()
    );
    let error_code = classify_streaming_error_message(message);
    let mut event = SessionEvent {
        id: event_id.clone(),
        chunk_id: Some(event_id),
        session_id: session_id.to_string(),
        created_at: now,
        function_name: "system".to_string(),
        ui_canonical: "".to_string(),
        action_type: "assistant".to_string(),
        args: serde_json::json!({
            "errorCode": error_code.wire_value(),
            "isRetryable": error_code.is_retryable(),
        }),
        result: serde_json::json!({
            "observation": format!("Error: {message}"),
        }),
        source: EventSource::Assistant,
        display_text: format!("Error: {message}"),
        display_status: EventDisplayStatus::Failed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    };
    event.recompute_extracted();
    event
}

pub fn persist_session_error_event(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    message: &str,
) {
    let Some(handle) = app_handle else {
        return;
    };
    event_pipeline_bridge::push_events(
        handle,
        session_id,
        vec![build_session_error_event(session_id, message)],
    );
}

#[derive(Debug)]
struct AgentOrgMemberLifecycleSnapshot {
    context: AgentOrgRunContext,
    member_id: String,
    member_agent_id: String,
    requeued_tasks: Vec<Task>,
    agent_exec_mode: Option<crate::session::AgentExecMode>,
}

fn task_required_role(task: &Task) -> Option<&str> {
    task.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(TASK_METADATA_REQUIRED_ROLE))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|role| !role.is_empty())
}

fn member_failure_recovery_guidance(failure_reason: &str, requeued_tasks: &[Task]) -> String {
    let mut lines = vec![
        failure_reason.trim().to_string(),
        String::new(),
        "Requeued tasks from the failed member:".to_string(),
    ];

    if requeued_tasks.is_empty() {
        lines.push("- none".to_string());
    } else {
        for task in requeued_tasks {
            let eligible_member_ids = agent_org_tasks::eligible_member_ids(task);
            let eligible = if eligible_member_ids.is_empty() {
                "none".to_string()
            } else {
                eligible_member_ids.join(", ")
            };
            let required_role = task_required_role(task).unwrap_or("unspecified");
            let disposition =
                "awaiting_coordinator_assignment — failed owner removed; no worker may self-claim";
            lines.push(format!("- {}: {}", task.id, task.subject));
            lines.push(format!("  status: {}", task.status.as_wire()));
            lines.push(format!("  disposition: {disposition}"));
            lines.push(format!("  eligible_member_ids: [{eligible}]"));
            lines.push(format!("  required_role: {required_role}"));
        }
    }

    lines.extend([
        String::new(),
        "Recommended recovery:".to_string(),
        "1. Inspect the failure and choose a replacement owner explicitly with task_update operation=patch_pending owner_member_id=...".to_string(),
        "2. If retrying the same member is appropriate, explicitly assign the task back to it; the system will not do so automatically.".to_string(),
        "3. Never assign outside eligible_member_ids; repair eligibility first when the intended replacement is missing.".to_string(),
        "4. If no eligible member is available, pause and report to the user.".to_string(),
    ]);

    lines.join("\n")
}

fn parse_agent_exec_mode(value: Option<&str>) -> Option<crate::session::AgentExecMode> {
    value.and_then(crate::session::AgentExecMode::parse)
}

fn requeue_agent_org_member_in_progress_work(
    session_id: &str,
    failed_turn_intent_id: Option<&str>,
    requeue_work: bool,
) -> Result<Option<AgentOrgMemberLifecycleSnapshot>, String> {
    let Some(record) =
        session_persistence::get_session(session_id).map_err(|err| err.to_string())?
    else {
        return Ok(None);
    };
    let Some(member_id) = record.org_member_id else {
        return Ok(None);
    };
    let Some(context) = AgentOrgRunStore::context_for_session_with_parent_walk(session_id)? else {
        return Ok(None);
    };
    let member_agent_id = context
        .require_participant_agent_id(&member_id)?
        .to_string();
    let requeued = if requeue_work {
        let failed_turn_intent_id = failed_turn_intent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "task_failure_recovery_requires_exact_turn_context".to_string())?;
        AgentOrgTaskStore::recover_task_execution_failure(session_id, failed_turn_intent_id)?
    } else {
        Vec::new()
    };
    Ok(Some(AgentOrgMemberLifecycleSnapshot {
        context,
        member_id,
        member_agent_id,
        requeued_tasks: requeued,
        agent_exec_mode: parse_agent_exec_mode(record.agent_exec_mode.as_deref()),
    }))
}

pub fn finalize_agent_org_member_turn(
    app_handle: Option<&tauri::AppHandle>,
    session_id: &str,
    turn_intent_id: Option<&str>,
    response: &Result<String, String>,
) {
    let typed_failure = response.as_ref().err().and_then(|error| {
        crate::coordination::agent_org_finality::AgentOrgTurnFailure::decode(error)
    });
    let requeue_work = response.is_err()
        && typed_failure
            .as_ref()
            .is_none_or(|failure| failure.kind.permits_task_recovery());
    let outcome: Result<(Option<AgentOrgMemberLifecycleSnapshot>, Vec<String>), String> =
        crate::tools::impls::orchestration::member_idle::run_agent_org_blocking_section(|| {
            // Recovery still validates the exact running TaskExecution. Let
            // that transaction settle the Task before terminalizing the same
            // Turn; deterministic authority failures skip recovery entirely.
            let snapshot = requeue_agent_org_member_in_progress_work(
                session_id,
                turn_intent_id,
                requeue_work,
            )?;
            let completion_receipts = if let Some(turn_intent_id) = turn_intent_id {
                crate::coordination::agent_org_finality::finalize_turn(
                    session_id,
                    turn_intent_id,
                    response.is_ok(),
                    typed_failure
                        .as_ref()
                        .map(|failure| failure.reason_code.as_str())
                        .unwrap_or(if response.is_ok() {
                            "turn_completed"
                        } else {
                            "provider_failed"
                        }),
                )?
            } else {
                Vec::new()
            };
            Ok((snapshot, completion_receipts))
        });
    let reconcile_run_id = outcome
        .as_ref()
        .ok()
        .and_then(|(snapshot, _)| snapshot.as_ref())
        .map(|snapshot| snapshot.context.run_id.clone());

    match outcome {
        Ok((Some(snapshot), completion_receipts)) => {
            if !completion_receipts.is_empty() {
                if let Some(handle) = app_handle {
                    AppHandleInboxWakeHook::new(handle.clone()).wake_member_for_formal_receipts(
                        crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
                        &snapshot.context.run_id,
                        &completion_receipts,
                    );
                }
            }
            if !snapshot.requeued_tasks.is_empty() {
                tracing::info!(
                    session_id = %session_id,
                    run_id = %snapshot.context.run_id,
                    member_id = %snapshot.member_id,
                    requeued_count = snapshot.requeued_tasks.len(),
                    "[lifecycle] requeued unfinished Agent Org member work after turn finalize"
                );
                // Failure recovery is coordinator-owned. The failed tasks are
                // now durable ownerless rows and the typed `MemberIdle::Failed`
                // notice below wakes the coordinator; no worker is woken to
                // race for them.
            }

            if response.is_ok() {
                if let Err(err) = crate::coordination::agent_org_watchdog::clear_rewake_budget(
                    &snapshot.context.run_id,
                    &snapshot.member_id,
                ) {
                    tracing::warn!(run_id = %snapshot.context.run_id, member_id = %snapshot.member_id, error = %err, "failed to clear Agent Org recovery budget after successful turn");
                }
                // Race-condition guard: a peer may have written an inbox row
                // while this session was Running (which caused the
                // `should_dispatch_wake` gate to skip the wake). Now that the
                // session is transitioning to Idle, check for unread rows and
                // self-wake if any exist. This also runs after task requeue:
                // user group-chat rows must not be stranded behind a requeued
                // TaskAssigned row when a turn is interrupted.
                if let Some(handle) = app_handle {
                    let member_id = snapshot.member_id.clone();
                    let run_id = snapshot.context.run_id.clone();
                    let handle_clone = handle.clone();
                    tokio::spawn(async move {
                        let should_rewake = tokio::task::spawn_blocking({
                            let mid = member_id.clone();
                            let rid = run_id.clone();
                            move || should_rewake_agent_org_member_after_turn(&rid, &mid)
                        })
                        .await
                        .unwrap_or_else(|err| Err(err.to_string()));

                        if matches!(should_rewake, Ok(true)) {
                            tracing::info!(
                                member_id = %member_id,
                                run_id = %run_id,
                                "[lifecycle] inbox has unread rows after turn end (race-guard); \
                                 re-waking member"
                            );
                            AppHandleInboxWakeHook::new(handle_clone)
                                .wake_member(&member_id, &run_id);
                        } else if let Err(err) = should_rewake {
                            tracing::warn!(
                                run_id = %run_id,
                                member_id = %member_id,
                                error = %err,
                                "[lifecycle] unread-inbox race-guard check failed; refusing wake"
                            );
                        }
                    });
                }
            }

            if let Err(err) = response {
                let failure_guidance =
                    member_failure_recovery_guidance(err, &snapshot.requeued_tasks);
                let unfinished_task_ids = snapshot
                    .requeued_tasks
                    .iter()
                    .map(|task| task.id.clone())
                    .collect();
                crate::session::turn::member_idle::maybe_emit_member_idle_with_details(
                    Some(&snapshot.context),
                    Some(&snapshot.member_id),
                    MemberIdleReason::Failed,
                    snapshot.agent_exec_mode,
                    Some("Member failed; inspect failure_reason for requeued tasks and recovery guidance.".to_string()),
                    Some(failure_guidance),
                    unfinished_task_ids,
                );
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %snapshot.context.run_id,
                    member_id = %snapshot.member_id,
                    member_agent_id = %snapshot.member_agent_id,
                    error = %err,
                    "[lifecycle] Agent Org member turn failed; coordinator was notified and unfinished work was released for review"
                );
            }
        }
        Ok((None, _)) => {}
        Err(err) => {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[lifecycle] failed to finalize Agent Org member turn work"
            );
        }
    }

    // Successful Agent Org turns settle back to Idle, not terminal. Reconcile
    // after every member/coordinator boundary so an all-completed, fully
    // quiescent run closes without requiring the user to pause/resume it.
    // The store re-checks tasks, inbox, interventions and queued turn
    // intents in one IMMEDIATE transaction before committing quiescence.
    if let Some(run_id) = reconcile_run_id {
        let transition = AgentOrgRunStore::assess_run_quiescence(&run_id).and_then(|assessment| {
            let Some(generation) = assessment.facts.activation_generation else {
                return Ok(false);
            };
            let Some(work_revision) = assessment
                .facts
                .progress
                .as_ref()
                .map(|progress| progress.work_revision)
            else {
                return Ok(false);
            };
            AgentOrgRunStore::try_transition_working_to_idle(&run_id, generation, work_revision)
        });
        match transition {
            Ok(true) => {
                tracing::info!(run_id = %run_id, "[lifecycle] idled quiescent Agent Org run");
            }
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(run_id = %run_id, error = %err, "[lifecycle] failed to reconcile Agent Org run after turn finalization");
            }
        }
    }
}

/// Decide whether the post-turn unread-inbox race guard should issue one wake.
///
/// A direct user intervention owns the member's next turn and deliberately
/// pauses inbox drain. Treating its unread rows as actionable here caused a
/// tight WakeNoop → finalize → wake loop. Keeping the decision in one helper
/// makes the lifecycle caller and its regression test share the exact gate.
fn should_rewake_agent_org_member_after_turn(
    run_id: &str,
    member_id: &str,
) -> Result<bool, String> {
    if !matches!(
        crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(run_id)?,
        Some(crate::coordination::agent_org_runs::AgentOrgRunStatus::Running)
    ) {
        return Ok(false);
    }
    if crate::coordination::agent_member_interventions::AgentMemberInterventionStore::active_for_member(
        run_id,
        member_id,
    )?
    .is_some()
    {
        return Ok(false);
    }
    if member_id == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        return conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1
                     FROM agent_org_runtime_formal_trigger_receipts receipt
                     WHERE receipt.org_run_id=?1
                       AND receipt.status='pending'
                       AND receipt.doorbell_status IN ('missing','delivered')
                       AND NOT EXISTS (
                           SELECT 1
                           FROM agent_org_runtime_formal_trigger_attempts attempt
                           WHERE attempt.receipt_id=receipt.receipt_id
                             AND attempt.status IN ('queued','running')
                       )
                 )",
                [run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string());
    }
    crate::coordination::agent_inbox::AgentInboxStore::has_unread_for_member(member_id, run_id)
}

/// Post-process after `process_message` completes: determine final status,
/// persist it, notify the orchestrator, and broadcast any error event.
///
/// Returns the final `AgentSessionStatus` so callers can act on it.
pub async fn finalize_session(
    session_id: &str,
    response: &Result<String, String>,
    app_handle: Option<&tauri::AppHandle>,
    workspace_path: Option<&std::path::Path>,
    load_workspace_resources: bool,
    terminal_turn: Option<TerminalTurnSignal>,
) -> AgentSessionStatus {
    let (is_agent_org_member_session, session_agent_definition_id) = {
        let sid = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            session_persistence::get_session(&sid)
                .ok()
                .flatten()
                .map(|record| {
                    (
                        record.session_type
                            == crate::session::persistence::session_type::ORG_MEMBER
                            || record.org_member_id.is_some(),
                        record.agent_definition_id,
                    )
                })
                .unwrap_or((false, None))
        })
        .await
        .unwrap_or((false, None))
    };
    let (
        user_directed_turn,
        intervention_suspended_formal_turn,
        final_summary_turn,
        authority_error,
    ) = if is_agent_org_member_session {
        let sid = session_id.to_string();
        let turn_intent_id = terminal_turn
            .as_ref()
            .and_then(|signal| signal.turn_intent_id.clone());
        match tokio::task::spawn_blocking(move || -> Result<(bool, bool, bool), String> {
                let Some(turn_intent_id) = turn_intent_id else {
                    return Ok((false, false, false));
                };
                let connection = database::db::get_connection().map_err(|error| error.to_string())?;
                let context =
                    crate::coordination::agent_org_turn_contexts::require_context_with_connection(
                        &connection,
                        &sid,
                        &turn_intent_id,
                    )?;
                let user_directed = context.is_user_directed_work();
                let suspended_formal = !user_directed
                    && crate::coordination::agent_member_interventions::AgentMemberInterventionStore::open_receipt_for_original_turn(
                        &sid,
                        &turn_intent_id,
                    )?
                    .is_some();
                let final_summary =
                    crate::coordination::agent_org_final_summary::has_summary_receipt_for_turn_with_connection(
                        &connection,
                        &sid,
                        &turn_intent_id,
                    )?;
                Ok((user_directed, suspended_formal, final_summary))
            })
            .await
            {
                Ok(Ok((user_directed, suspended_formal, final_summary))) => {
                    (user_directed, suspended_formal, final_summary, None)
                }
                Ok(Err(error)) => (false, false, false, Some(error)),
                Err(error) => (false, false, false, Some(error.to_string())),
            }
    } else {
        // Ordinary SDE finalization never reads Agent Org Turn context or
        // intervention state.
        (false, false, false, None)
    };

    if let Some(error) = authority_error.as_deref() {
        tracing::error!(
            session_id,
            error,
            "Agent Org finalizer could not prove the persisted Turn authority; formal lifecycle hooks are suppressed"
        );
    }

    let final_status = if authority_error.is_some() {
        AgentSessionStatus::Failed
    } else if user_directed_turn || intervention_suspended_formal_turn || final_summary_turn {
        // UDW failure belongs to that direct Turn/receipt, not to the durable
        // Member or Team lifecycle. The structured agent:error still renders
        // the failure while the canonical Session returns to Idle.
        AgentSessionStatus::Idle
    } else if response.is_ok() {
        if is_agent_org_member_session {
            AgentSessionStatus::Idle
        } else {
            AgentSessionStatus::Completed
        }
    } else {
        AgentSessionStatus::Failed
    };

    if let Some(ref terminal_turn) = terminal_turn {
        persist_and_emit_terminal_turn(session_id, terminal_turn, final_status, app_handle);
    } else {
        let sid = session_id.to_string();
        if let Err(err) = tokio::task::spawn_blocking(move || {
            let status: crate::session::SessionStatus = final_status.into();
            if let Err(err) = session_persistence::update_status(&sid, status) {
                tracing::warn!("[lifecycle] Failed to update terminal status for {sid}: {err}");
            }
        })
        .await
        {
            tracing::warn!("[lifecycle] spawn_blocking panicked during status update: {err}");
        }

        emit_session_status_changed(app_handle, session_id, final_status);
    }

    if is_agent_org_member_session
        && !user_directed_turn
        && !intervention_suspended_formal_turn
        && !final_summary_turn
        && authority_error.is_none()
    {
        // Member finalization performs several synchronous SQLite operations
        // under the shared writer lock (task requeue, recovery-budget cleanup,
        // MemberIdle persistence, and Team quiescence reconciliation). Keep the
        // complete blocking phase off the Tokio worker that is finalizing the
        // provider turn; moving only the first query still leaves the later
        // writes able to stall unrelated async sessions.
        let sid = session_id.to_string();
        let response = response.clone();
        let turn_intent_id = terminal_turn
            .as_ref()
            .and_then(|signal| signal.turn_intent_id.clone());
        let app_handle = app_handle.cloned();
        if let Err(err) = tokio::task::spawn_blocking(move || {
            finalize_agent_org_member_turn(
                app_handle.as_ref(),
                &sid,
                turn_intent_id.as_deref(),
                &response,
            );
        })
        .await
        {
            tracing::warn!(
                session_id = %session_id,
                error = %err,
                "[lifecycle] Agent Org member finalization worker panicked"
            );
        }
    }

    if final_status.is_terminal() {
        let sid = session_id.to_string();
        let app_handle_clone = app_handle.cloned();
        if let Err(err) = crate::orchestrator_notify::notify_orchestrator_session_terminal(
            &sid,
            final_status,
            app_handle_clone.as_ref(),
        )
        .await
        {
            tracing::warn!(
                "[lifecycle] Orchestrator notification failed for {}: {}",
                sid,
                err
            );
        }

        crate::orchestrator_notify::notify_routine_fire_session_terminal(
            &sid,
            final_status,
            app_handle_clone.as_ref(),
        )
        .await;
    }

    if let Err(message) = response {
        persist_session_error_event(app_handle, session_id, message);
    }

    // Turn-end wake re-check (one of the two triggers feeding the single
    // job-wake coordinator). A background job — subagent worker or
    // backgrounded shell — that completed while THIS turn was still running
    // had its completion-push wake released back (the owner wasn't idle yet).
    // Now that the turn has ended and the session row is idle/terminal,
    // re-invoke the coordinator so the result is delivered. The coordinator
    // is the sole decision point: it atomically claims the result
    // (exactly-once across both triggers), checks the owner is wakeable, and
    // dispatches — so this call is an unconditional no-op when there is
    // nothing new to deliver. No `response.is_ok()` / unread-precheck gating
    // here anymore: the claim flag makes re-waking a failed/ignored result
    // impossible, which is what previously required the ad-hoc retry-storm
    // guard.
    if !is_agent_org_member_session {
        crate::tools::impls::orchestration::job_wake::current_job_completion_wake_hook()
            .wake_owner(session_id);
    }

    // NOTE: Error broadcasting is handled by the scheduler. Do NOT broadcast here
    // to avoid duplicate transient error notifications; this path only persists
    // the authoritative EventStore row for UI history/replay.

    if final_status.is_terminal() {
        crate::session::file_registry::unregister_session(session_id);

        // Fire HookEvent::SessionStop — session lifecycle ended.
        if let Some(root) = workspace_path {
            let executor = crate::specialization::hooks::HookExecutor::load_with_workspace_scope(
                root,
                load_workspace_resources,
            );
            if executor.has_hooks_for(crate::specialization::hooks::HookEvent::SessionStop) {
                let ctx =
                    crate::specialization::hooks::events::HookContext::for_session(session_id)
                        .with_var("ORGII_SESSION_STATUS", final_status.as_ref());
                let sid = session_id.to_string();
                tokio::spawn(async move {
                    executor
                        .run(crate::specialization::hooks::HookEvent::SessionStop, &ctx)
                        .await;
                    tracing::info!("[lifecycle] SessionStop hooks fired for {}", sid);
                });
            }
        }
    }

    // Post-session reflection and active observation are coordinator-owned.
    // The current policy is checked after admission and again inside each
    // subsystem before any LLM call, so the settings switch is a hot gate.
    if final_status == AgentSessionStatus::Completed && !e2e_background_llm_disabled() {
        const REFLECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
        const SESSION_QUIESCENCE_DELAY: std::time::Duration =
            std::time::Duration::from_secs(5 * 60);
        let sid = session_id.to_string();
        let agent_id = session_agent_definition_id.clone();
        let job_agent_id = agent_id.clone();
        crate::memory::background::submit_memory_job(
            crate::memory::background::MemoryJob::new(
                sid.clone(),
                agent_id,
                crate::memory::background::MemoryJobKind::Reflection,
                REFLECTION_TIMEOUT,
                move |_cancel| async move {
                    if let Some(agent_id) = job_agent_id.as_deref() {
                        if !crate::memory::background::memory_job_is_enabled(
                            agent_id,
                            crate::memory::background::MemoryJobKind::Reflection,
                        ) {
                            return Ok(());
                        }
                    }
                    let count = crate::memory::reflection::maybe_reflect_on_session(&sid).await?;
                    tracing::info!(
                        "[lifecycle] Post-session reflection stored {} learnings for {}",
                        count,
                        sid
                    );
                    Ok(())
                },
            )
            .with_debounce(SESSION_QUIESCENCE_DELAY),
        );

        let sid = session_id.to_string();
        let agent_id = session_agent_definition_id;
        let job_agent_id = agent_id.clone();
        crate::memory::background::submit_memory_job(
            crate::memory::background::MemoryJob::new(
                sid.clone(),
                agent_id,
                crate::memory::background::MemoryJobKind::ActiveObservation,
                REFLECTION_TIMEOUT,
                move |_cancel| async move {
                    if let Some(agent_id) = job_agent_id.as_deref() {
                        if !crate::memory::background::memory_job_is_enabled(
                            agent_id,
                            crate::memory::background::MemoryJobKind::ActiveObservation,
                        ) {
                            return Ok(());
                        }
                    }
                    let count =
                        crate::memory::reflection::active_learning::maybe_observe_tool_failures(
                            &sid,
                        )
                        .await?;
                    tracing::info!(
                        "[lifecycle] Post-session active observation stored {} learnings for {}",
                        count,
                        sid
                    );
                    Ok(())
                },
            )
            .with_debounce(SESSION_QUIESCENCE_DELAY),
        );
    }

    final_status
}

#[cfg(test)]
#[path = "tests/lifecycle_tests.rs"]
mod tests;
