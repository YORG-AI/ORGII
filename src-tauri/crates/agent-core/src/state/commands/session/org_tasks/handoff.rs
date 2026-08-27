//! Trusted Run View entry points for Task cancellation, reassignment and
//! explicit resolution of uncertain execution handoffs.

use std::sync::Arc;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_task_handoffs::{
    CreateTaskExecutionHandoff, TaskExecutionHandoffReceipt, TaskExecutionHandoffResolution,
    TaskExecutionHandoffState,
};
use crate::coordination::agent_org_tasks::{
    new_task_id, AgentOrgTaskStore, CreatePendingTaskParams, Task, TaskCancelAndReplaceInput,
    TaskStatus, TaskTerminalReason, UserTaskHandoffAdmin,
};
use crate::state::AgentAppState;
use crate::tools::impls::orchestration::agent_org::tasks::{
    task_update::{drive_committed_handoff, prepare_handoff_runtime_evidence},
    TaskOutboxCommit, TaskToolsContext,
};
use crate::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook;
use crate::tools::impls::orchestration::org_send_message::{InboxWakeHook, NoopInboxWakeHook};

use super::context::session_org_read_context;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgTaskHandoffAction {
    Cancel,
    Reassign,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentOrgTaskHandoffRequest {
    pub session_id: String,
    pub request_id: String,
    pub task_id: String,
    pub action: AgentOrgTaskHandoffAction,
    #[serde(default)]
    pub replacement_owner_member_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgTaskHandoffRequestResult {
    pub task: Task,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<Task>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_handoff: Option<TaskExecutionHandoffReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentOrgTaskHandoffResolveRequest {
    pub session_id: String,
    pub request_id: String,
    pub receipt_id: String,
    pub resolution: TaskExecutionHandoffResolution,
}

#[tauri::command]
pub async fn agent_org_task_handoff_request(
    state: tauri::State<'_, AgentAppState>,
    request: AgentOrgTaskHandoffRequest,
) -> Result<AgentOrgTaskHandoffRequestResult, String> {
    crate::coordination::agent_org_runs::require_agent_org_redesign()?;
    validate_request_shape(&request)?;
    let context = task_tools_context_for_root_command(&state, &request.session_id).await?;
    let run_id = context.org_context.run_id.clone();
    let request_digest = crate::coordination::agent_org_task_handoffs::canonical_request_digest(
        &serde_json::to_value(&request).map_err(|error| error.to_string())?,
    )?;

    let _fence = crate::coordination::agent_org_task_execution_fence::acquire_handoff(
        &run_id,
        &request.task_id,
    )
    .await;
    let runtime_evidence = prepare_handoff_runtime_evidence(&context, &request.task_id).await?;
    let authority = _fence.authority();
    let transaction_context = Arc::clone(&context);
    let tx_request = request.clone();
    let (result, outboxes) = tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| -> Result<_, String> {
            let conn = database::db::get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let tasks = AgentOrgTaskStore::list_with_connection(&tx, &run_id)?;
            let generation: i64 = tx
                .query_row(
                    "SELECT activation_generation FROM agent_org_runtime_runs
                     WHERE id=?1 AND status='running'",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if let Some(existing) =
                crate::coordination::agent_org_task_handoffs::load_by_request_with_connection(
                    &tx,
                    &run_id,
                    generation,
                    &tx_request.request_id,
                )?
            {
                if existing.request_digest != request_digest {
                    return Err("task_execution_handoff_request_digest_conflict".to_string());
                }
                let task = tasks
                    .iter()
                    .find(|task| task.id == existing.old_task_id)
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "task_execution_handoff_old_task_missing:{}",
                            existing.old_task_id
                        )
                    })?;
                let replacement = existing
                    .replacement_task_id
                    .as_deref()
                    .map(|replacement_task_id| {
                        tasks
                            .iter()
                            .find(|task| task.id == replacement_task_id)
                            .cloned()
                            .ok_or_else(|| {
                                format!(
                                    "task_execution_handoff_replacement_missing:{replacement_task_id}"
                                )
                            })
                    })
                    .transpose()?;
                tx.commit().map_err(|error| error.to_string())?;
                return Ok((
                    AgentOrgTaskHandoffRequestResult {
                        task,
                        replacement,
                        execution_handoff: Some(existing),
                    },
                    Vec::new(),
                ));
            }
            let previous = tasks
                .iter()
                .find(|task| task.id == tx_request.task_id)
                .cloned()
                .ok_or_else(|| format!("task_not_found:{}", tx_request.task_id))?;
            if previous.status.is_terminal() {
                return Err(format!(
                    "task_terminal_immutable:{}:{}",
                    previous.id,
                    previous.status.as_wire()
                ));
            }
            let actor = UserTaskHandoffAdmin::new(
                &tx_request.session_id,
                &tx_request.request_id,
            )?;
            let reason = TaskTerminalReason {
                code: match tx_request.action {
                    AgentOrgTaskHandoffAction::Cancel => "user_cancelled",
                    AgentOrgTaskHandoffAction::Reassign => "user_reassigned",
                }
                .to_string(),
                message: match tx_request.action {
                    AgentOrgTaskHandoffAction::Cancel => "User cancelled this Task from Run View",
                    AgentOrgTaskHandoffAction::Reassign => {
                        "User reassigned this Task from Run View"
                    }
                }
                .to_string(),
                source_event_id: None,
            };
            let needs_handoff = previous.status == TaskStatus::InProgress;
            let mut outboxes = Vec::<TaskOutboxCommit>::new();
            let result = match tx_request.action {
                AgentOrgTaskHandoffAction::Cancel => {
                    let (outcome, mut outbox) =
                        AgentOrgTaskStore::cancel_with_user_handoff_in_tx(
                            &tx,
                            actor,
                            &run_id,
                            &previous.id,
                            reason,
                            needs_handoff.then_some(&authority),
                            |tx, outcome, tasks| {
                                transaction_context
                                    .persist_task_update_outbox_in_tx(tx, outcome, tasks)
                            },
                        )?;
                    if needs_handoff {
                        outbox.execution_handoff = Some(
                            crate::coordination::agent_org_task_handoffs::create_in_tx(
                                &tx,
                                CreateTaskExecutionHandoff {
                                    request_id: &tx_request.request_id,
                                    request_digest: &request_digest,
                                    old_task: &outcome.previous,
                                    replacement_task: None,
                                    runtime_evidence: runtime_evidence.as_ref(),
                                    external_effect_unknown: crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
                                        &tx,
                                        &outcome.previous.org_run_id,
                                        &outcome.previous.id,
                                    )?,
                                },
                            )?,
                        );
                    }
                    let response = AgentOrgTaskHandoffRequestResult {
                        task: outcome.current,
                        replacement: None,
                        execution_handoff: outbox.execution_handoff.clone(),
                    };
                    outboxes.push(outbox);
                    response
                }
                AgentOrgTaskHandoffAction::Reassign => {
                    let owner = tx_request
                        .replacement_owner_member_id
                        .as_deref()
                        .ok_or_else(|| "reassign requires replacementOwnerMemberId".to_string())?;
                    let owner = transaction_context.resolve_owner_member_id(owner)?;
                    let replacement_input = CreatePendingTaskParams {
                        id: new_task_id(),
                        org_run_id: run_id.clone(),
                        subject: previous.subject.clone(),
                        description: previous.description.clone(),
                        active_form: previous.active_form.clone(),
                        owner: Some(owner),
                        execution_mode: previous.execution_mode,
                        blocked_by: previous.blocked_by.clone(),
                        metadata: previous.metadata.clone(),
                        originating_message_id: previous.originating_message_id.clone(),
                        replaces_task_id: Some(previous.id.clone()),
                    };
                    let (outcome, replacement, outbox) =
                        AgentOrgTaskStore::cancel_and_replace_with_user_handoff_in_tx(
                            &tx,
                            actor,
                            &run_id,
                            &previous.id,
                            TaskCancelAndReplaceInput {
                                reason,
                                replacement: replacement_input,
                                handoff: needs_handoff.then_some(&authority),
                            },
                            |tx, outcome, replacement, tasks| {
                                let outbox = transaction_context
                                    .persist_task_update_outbox_in_tx(tx, outcome, tasks)?;
                                Ok((outbox, replacement.clone(), tasks.to_vec()))
                            },
                        )?;
                    let (mut base_outbox, _, all_tasks) = outbox;
                    if needs_handoff {
                        base_outbox.execution_handoff = Some(
                            crate::coordination::agent_org_task_handoffs::create_in_tx(
                                &tx,
                                CreateTaskExecutionHandoff {
                                    request_id: &tx_request.request_id,
                                    request_digest: &request_digest,
                                    old_task: &outcome.previous,
                                    replacement_task: Some(&replacement),
                                    runtime_evidence: runtime_evidence.as_ref(),
                                    external_effect_unknown: crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
                                        &tx,
                                        &outcome.previous.org_run_id,
                                        &outcome.previous.id,
                                    )?,
                                },
                            )?,
                        );
                    } else {
                        outboxes.push(transaction_context.persist_created_tasks_outbox_in_tx(
                            &tx,
                            std::slice::from_ref(&replacement),
                            &all_tasks,
                        )?);
                    }
                    let response = AgentOrgTaskHandoffRequestResult {
                        task: outcome.current,
                        replacement: Some(replacement),
                        execution_handoff: base_outbox.execution_handoff.clone(),
                    };
                    outboxes.push(base_outbox);
                    response
                }
            };
            tx.commit().map_err(|error| error.to_string())?;
            Ok((result, outboxes))
        })
    })
    .await
    .map_err(|error| format!("Task handoff command worker failed: {error}"))??;
    drop(_fence);

    for outbox in &outboxes {
        context.wake_committed_task_outbox(outbox);
    }
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
        &context.org_context.run_id,
    );
    if let Some(receipt) = result.execution_handoff.clone() {
        drive_committed_handoff(Arc::clone(&context), receipt)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn agent_org_task_handoff_resolve(
    state: tauri::State<'_, AgentAppState>,
    request: AgentOrgTaskHandoffResolveRequest,
) -> Result<TaskExecutionHandoffReceipt, String> {
    crate::coordination::agent_org_runs::require_agent_org_redesign()?;
    if request.session_id.trim().is_empty()
        || request.request_id.trim().is_empty()
        || request.receipt_id.trim().is_empty()
    {
        return Err("Handoff resolution requires sessionId, requestId and receiptId".to_string());
    }
    let context = task_tools_context_for_root_command(&state, &request.session_id).await?;
    let receipt = crate::coordination::agent_org_task_handoffs::load(&request.receipt_id)?
        .ok_or_else(|| format!("task_execution_handoff_not_found:{}", request.receipt_id))?;
    if receipt.org_run_id != context.org_context.run_id {
        return Err("Task handoff receipt belongs to another Team".to_string());
    }
    if let Some(existing) = receipt.resolution {
        if existing == request.resolution {
            return Ok(receipt);
        }
        return Err("task_execution_handoff_resolution_conflict".to_string());
    }

    let mut task_ids = vec![receipt.old_task_id.clone()];
    if request.resolution == TaskExecutionHandoffResolution::AbandonEpisode {
        let run_id = receipt.org_run_id.clone();
        task_ids.extend(
            tokio::task::spawn_blocking(move || {
                let conn = database::db::get_connection().map_err(|error| error.to_string())?;
                let generation: i64 = conn
                    .query_row(
                        "SELECT activation_generation FROM agent_org_runtime_runs WHERE id=?1",
                        [&run_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>(
                    AgentOrgTaskStore::list_with_connection(&conn, &run_id)?
                        .into_iter()
                        .filter(|task| {
                            task.activation_generation == generation && task.status.is_open()
                        })
                        .map(|task| task.id)
                        .collect::<Vec<_>>(),
                )
            })
            .await
            .map_err(|error| format!("Task abandon inventory worker failed: {error}"))??,
        );
    }
    task_ids.sort();
    task_ids.dedup();
    let mut fences = Vec::with_capacity(task_ids.len());
    for task_id in &task_ids {
        fences.push(
            crate::coordination::agent_org_task_execution_fence::acquire_handoff(
                &receipt.org_run_id,
                task_id,
            )
            .await,
        );
    }

    let old_execution_released = ensure_receipt_local_execution_released(
        &state,
        &receipt,
        request.resolution == TaskExecutionHandoffResolution::ContinueReplacement,
    )
    .await?;
    if request.resolution == TaskExecutionHandoffResolution::AbandonEpisode {
        ensure_open_task_executions_released(&state, &context, &receipt.org_run_id).await?;
    }

    let tx_context = Arc::clone(&context);
    let tx_request = request.clone();
    let run_id = receipt.org_run_id.clone();
    let old_task_id = receipt.old_task_id.clone();
    let replacement_task_id = receipt.replacement_task_id.clone();
    let (resolved, outboxes) = tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| -> Result<_, String> {
            let conn = database::db::get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let mut outboxes = Vec::<TaskOutboxCommit>::new();
            // Every resolution is an explicit user disposition of any remote
            // uncertainty attached to the old execution. Clear the sticky
            // Task marker in the same transaction; any later failure rolls it
            // back together with the resolution.
            crate::coordination::agent_org_task_execution_fence::clear_external_effect_unknown_in_tx(
                &tx,
                &run_id,
                &old_task_id,
            )?;
            match tx_request.resolution {
                TaskExecutionHandoffResolution::ContinueReplacement => {
                    if let Some(replacement_task_id) = replacement_task_id.as_deref() {
                        let tasks = AgentOrgTaskStore::list_with_connection(&tx, &run_id)?;
                        let replacement = tasks
                            .iter()
                            .find(|task| task.id == replacement_task_id)
                            .ok_or_else(|| {
                                format!(
                                    "task_execution_handoff_replacement_missing:{replacement_task_id}"
                                )
                            })?;
                        if replacement.status != TaskStatus::Pending {
                            return Err(format!(
                                "task_execution_handoff_replacement_not_pending:{}",
                                replacement.status.as_wire()
                            ));
                        }
                        outboxes.push(tx_context.persist_created_tasks_outbox_in_tx(
                            &tx,
                            std::slice::from_ref(replacement),
                            &tasks,
                        )?);
                    }
                    crate::coordination::agent_org_task_handoffs::resolve_in_tx(
                        &tx,
                        &tx_request.receipt_id,
                        tx_request.resolution,
                        old_execution_released,
                    )?;
                }
                TaskExecutionHandoffResolution::KeepStopped => {
                    if let Some(replacement_task_id) = replacement_task_id.as_deref() {
                        let actor = UserTaskHandoffAdmin::new(
                            &tx_request.session_id,
                            &tx_request.request_id,
                        )?;
                        let (outcome, outbox) =
                            AgentOrgTaskStore::cancel_with_user_handoff_in_tx(
                                &tx,
                                actor,
                                &run_id,
                                replacement_task_id,
                                TaskTerminalReason {
                                    code: "user_keep_stopped".to_string(),
                                    message: "User kept the replacement stopped".to_string(),
                                    source_event_id: None,
                                },
                                None,
                                |tx, outcome, tasks| {
                                    tx_context.persist_task_update_outbox_in_tx(
                                        tx, outcome, tasks,
                                    )
                                },
                            )?;
                        debug_assert_eq!(outcome.current.status, TaskStatus::Cancelled);
                        outboxes.push(outbox);
                    }
                    crate::coordination::agent_org_task_handoffs::resolve_in_tx(
                        &tx,
                        &tx_request.receipt_id,
                        tx_request.resolution,
                        old_execution_released,
                    )?;
                }
                TaskExecutionHandoffResolution::AbandonEpisode => {
                    let actor = UserTaskHandoffAdmin::new(
                        &tx_request.session_id,
                        &tx_request.request_id,
                    )?;
                    AgentOrgTaskStore::cancel_open_for_user_abandon_with_connection(
                        &tx,
                        actor,
                        &run_id,
                        &TaskTerminalReason {
                            code: "user_abandoned_episode".to_string(),
                            message: "User abandoned the current Task episode".to_string(),
                            source_event_id: None,
                        },
                    )?;
                    crate::coordination::agent_org_task_handoffs::resolve_in_tx(
                        &tx,
                        &tx_request.receipt_id,
                        tx_request.resolution,
                        old_execution_released,
                    )?;
                    crate::coordination::agent_org_run_completion::certify_user_abandon_in_tx(
                        &tx,
                        &run_id,
                        &tx_request.session_id,
                        &tx_request.receipt_id,
                    )?;
                }
            }
            let resolved = crate::coordination::agent_org_task_handoffs::load_with_connection(
                &tx,
                &tx_request.receipt_id,
            )?
            .ok_or_else(|| {
                format!(
                    "task_execution_handoff_not_found:{}",
                    tx_request.receipt_id
                )
            })?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok((resolved, outboxes))
        })
    })
    .await
    .map_err(|error| format!("Task handoff resolution worker failed: {error}"))??;
    drop(fences);

    for outbox in &outboxes {
        context.wake_committed_task_outbox(outbox);
    }
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&receipt.org_run_id);
    crate::coordination::agent_org_task_handoffs::observe_handoff("resolved", &resolved);
    Ok(resolved)
}

async fn ensure_receipt_local_execution_released(
    state: &AgentAppState,
    receipt: &TaskExecutionHandoffReceipt,
    require_exact_terminal_proof: bool,
) -> Result<bool, String> {
    if crate::coordination::agent_org_task_execution_fence::active_effect_count(
        &receipt.org_run_id,
        &receipt.old_task_id,
    ) != 0
    {
        return Err("task_execution_handoff_local_writer_still_active".to_string());
    }
    let (Some(session_id), Some(turn_intent_id), Some(runtime_lease_id), Some(dialog_generation)) = (
        receipt.old_session_id.as_deref(),
        receipt.old_turn_intent_id.as_deref(),
        receipt.runtime_lease_id.as_deref(),
        receipt.dialog_turn_generation.as_deref(),
    ) else {
        if require_exact_terminal_proof {
            return Err("task_execution_handoff_runtime_evidence_missing".to_string());
        }
        return Ok(false);
    };
    let process_owner = crate::tools::call_context::TurnProcessOwner {
        session_id: session_id.to_string(),
        turn_intent_id: turn_intent_id.to_string(),
        runtime_lease_id: runtime_lease_id.to_string(),
        dialog_turn_generation: dialog_generation.to_string(),
    };
    if let Some(session) = state.get_session(session_id).await {
        let exact_live = session
            .runtime_turn_identity()
            .await
            .is_some_and(|identity| {
                identity.runtime_lease_id == runtime_lease_id
                    && identity.dialog_turn_generation == dialog_generation
                    && identity.turn_intent_id.as_deref() == Some(turn_intent_id)
            });
        if exact_live {
            session
                .cancel_active_turn(crate::state::control_flow::CancelReason::OrgTaskHandoff)
                .await;
            let (turn_released, jobs_released) = tokio::join!(
                session.wait_for_turn_end(turn_intent_id, std::time::Duration::from_secs(10)),
                crate::tools::impls::coding::exec::registry::cancel_and_await_jobs_for_owner(
                    &process_owner,
                    std::time::Duration::from_secs(10),
                )
            );
            if !turn_released || jobs_released.is_err() {
                return Err("task_execution_handoff_local_execution_not_released".to_string());
            }
            let _ = session
                .release_runtime_if_current(runtime_lease_id, dialog_generation)
                .await
                || session
                    .release_yielded_runtime_if_idle(runtime_lease_id)
                    .await;
        }
    }
    let persisted_session_id = session_id.to_string();
    let persisted_turn_intent_id = turn_intent_id.to_string();
    let persisted_run_id = receipt.org_run_id.clone();
    let terminal = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM session_turn_intents
                 WHERE session_id=?1 AND turn_intent_id=?2 AND org_run_id=?3",
                rusqlite::params![
                    persisted_session_id,
                    persisted_turn_intent_id,
                    persisted_run_id,
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(status.is_some_and(|status| {
            matches!(
                status.as_str(),
                "completed" | "failed" | "cancelled" | "abandoned"
            )
        }))
    })
    .await
    .map_err(|error| format!("Task handoff terminal proof worker failed: {error}"))??;
    if !terminal {
        if require_exact_terminal_proof {
            return Err("task_execution_handoff_old_turn_not_terminal".to_string());
        }
        return Ok(false);
    }
    if !crate::tools::impls::coding::exec::registry::owned_jobs_are_terminal(&process_owner) {
        return Err("task_execution_handoff_owned_process_still_active".to_string());
    }
    Ok(true)
}

async fn ensure_open_task_executions_released(
    state: &AgentAppState,
    context: &Arc<TaskToolsContext>,
    org_run_id: &str,
) -> Result<(), String> {
    let run_id = org_run_id.to_string();
    let open = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let generation: i64 = conn
            .query_row(
                "SELECT activation_generation FROM agent_org_runtime_runs WHERE id=?1",
                [&run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(
            AgentOrgTaskStore::list_with_connection(&conn, &run_id)?
                .into_iter()
                .filter(|task| {
                    task.activation_generation == generation
                        && task.status == TaskStatus::InProgress
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|error| format!("Task abandon running inventory worker failed: {error}"))??;
    for task in open {
        let evidence = prepare_handoff_runtime_evidence(context, &task.id)
            .await?
            .ok_or_else(|| format!("task_abandon_runtime_evidence_unknown:{}", task.id))?;
        let synthetic = TaskExecutionHandoffReceipt {
            id: format!("abandon-check:{}", task.id),
            org_run_id: task.org_run_id.clone(),
            activation_generation: task.activation_generation,
            request_id: String::new(),
            request_digest: String::new(),
            old_task_id: task.id,
            old_owner_member_id: task.owner.unwrap_or_default(),
            old_session_id: Some(evidence.old_session_id),
            old_turn_intent_id: Some(evidence.old_turn_intent_id),
            runtime_lease_id: Some(evidence.runtime_lease_id),
            dialog_turn_generation: Some(evidence.dialog_turn_generation),
            replacement_task_id: None,
            state: TaskExecutionHandoffState::Unknown,
            slo_missed: false,
            external_effect_unknown: false,
            local_effect_count: 0,
            resolution: None,
            requested_at: String::new(),
            released_at: None,
            resolved_at: None,
            updated_at: String::new(),
        };
        ensure_receipt_local_execution_released(state, &synthetic, true).await?;
    }
    Ok(())
}

fn validate_request_shape(request: &AgentOrgTaskHandoffRequest) -> Result<(), String> {
    if request.session_id.trim().is_empty()
        || request.request_id.trim().is_empty()
        || request.task_id.trim().is_empty()
    {
        return Err("Task handoff requires sessionId, requestId and taskId".to_string());
    }
    crate::coordination::agent_org_payload_limits::validate_task_identifier(
        "task handoff taskId",
        &request.task_id,
    )?;
    match request.action {
        AgentOrgTaskHandoffAction::Cancel if request.replacement_owner_member_id.is_some() => {
            Err("cancel does not accept replacementOwnerMemberId".to_string())
        }
        AgentOrgTaskHandoffAction::Reassign
            if request
                .replacement_owner_member_id
                .as_deref()
                .is_none_or(|owner| owner.trim().is_empty()) =>
        {
            Err("reassign requires replacementOwnerMemberId".to_string())
        }
        _ => Ok(()),
    }
}

pub(super) async fn task_tools_context_for_root_command(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Arc<TaskToolsContext>, String> {
    let read = session_org_read_context(state, session_id)
        .await?
        .ok_or_else(|| "Agent Org session context not found".to_string())?;
    let context = read
        .context
        .ok_or_else(|| "Agent Org run context not found".to_string())?;
    let is_root = crate::coordination::agent_org_runs::AgentOrgRunStore::is_root_session(
        &context.run_id,
        session_id,
    )?;
    if !is_root {
        return Err("Task handoff UI is available only in the canonical root Session".to_string());
    }
    let wake_hook: Arc<dyn InboxWakeHook> = match state.app_handle.clone() {
        Some(handle) => AppHandleInboxWakeHook::new(handle),
        None => Arc::new(NoopInboxWakeHook),
    };
    Ok(Arc::new(TaskToolsContext {
        org_context: Arc::new(context.clone()),
        caller_agent_id: context.coordinator_agent_id,
        caller_member_id: COORDINATOR_MEMBER_ID.to_string(),
        wake_hook,
        app_state: Some(state.clone()),
    }))
}

#[allow(dead_code)]
fn _assert_handoff_state_is_exhaustive(state: TaskExecutionHandoffState) {
    match state {
        TaskExecutionHandoffState::Requested
        | TaskExecutionHandoffState::Yielding
        | TaskExecutionHandoffState::Released
        | TaskExecutionHandoffState::Timeout
        | TaskExecutionHandoffState::Unknown
        | TaskExecutionHandoffState::Failed => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(action: AgentOrgTaskHandoffAction) -> AgentOrgTaskHandoffRequest {
        AgentOrgTaskHandoffRequest {
            session_id: "root-session".to_string(),
            request_id: "request-1".to_string(),
            task_id: "task-1".to_string(),
            action,
            replacement_owner_member_id: None,
        }
    }

    #[test]
    fn trusted_handoff_request_shape_is_action_exhaustive() {
        let cancel = request(AgentOrgTaskHandoffAction::Cancel);
        validate_request_shape(&cancel).expect("canonical cancel");

        let mut cancel_with_owner = cancel;
        cancel_with_owner.replacement_owner_member_id = Some("member-a".to_string());
        assert_eq!(
            validate_request_shape(&cancel_with_owner).unwrap_err(),
            "cancel does not accept replacementOwnerMemberId"
        );

        let reassign = request(AgentOrgTaskHandoffAction::Reassign);
        assert_eq!(
            validate_request_shape(&reassign).unwrap_err(),
            "reassign requires replacementOwnerMemberId"
        );
    }

    #[test]
    fn handoff_command_wire_rejects_unknown_enums_and_uses_camel_case() {
        let decoded: AgentOrgTaskHandoffRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "root-session",
            "requestId": "request-1",
            "taskId": "task-1",
            "action": "reassign",
            "replacementOwnerMemberId": "member-b"
        }))
        .expect("canonical request wire");
        assert_eq!(decoded.action, AgentOrgTaskHandoffAction::Reassign);
        assert_eq!(
            decoded.replacement_owner_member_id.as_deref(),
            Some("member-b")
        );
        assert!(
            serde_json::from_value::<AgentOrgTaskHandoffRequest>(serde_json::json!({
                "sessionId": "root-session",
                "requestId": "request-1",
                "taskId": "task-1",
                "action": "retry"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentOrgTaskHandoffResolveRequest>(serde_json::json!({
                "sessionId": "root-session",
                "requestId": "request-2",
                "receiptId": "receipt-1",
                "resolution": "resume_old"
            }))
            .is_err()
        );
    }

    #[test]
    fn receipt_wire_preserves_unknown_evidence_and_resolution() {
        let receipt = TaskExecutionHandoffReceipt {
            id: "receipt-1".to_string(),
            org_run_id: "run-1".to_string(),
            activation_generation: 7,
            request_id: "request-1".to_string(),
            request_digest: "a".repeat(64),
            old_task_id: "task-old".to_string(),
            old_owner_member_id: "member-a".to_string(),
            old_session_id: Some("session-a".to_string()),
            old_turn_intent_id: Some("turn-a".to_string()),
            runtime_lease_id: Some("lease-a".to_string()),
            dialog_turn_generation: Some("dialog-a".to_string()),
            replacement_task_id: Some("task-new".to_string()),
            state: TaskExecutionHandoffState::Unknown,
            slo_missed: true,
            external_effect_unknown: true,
            local_effect_count: 0,
            resolution: Some(TaskExecutionHandoffResolution::KeepStopped),
            requested_at: "2026-08-27T00:00:00Z".to_string(),
            released_at: None,
            resolved_at: Some("2026-08-27T00:00:10Z".to_string()),
            updated_at: "2026-08-27T00:00:10Z".to_string(),
        };
        let wire = serde_json::to_value(receipt).expect("receipt wire");
        assert_eq!(wire["orgRunId"], "run-1");
        assert_eq!(wire["state"], "unknown");
        assert_eq!(wire["resolution"], "keep_stopped");
        assert_eq!(wire["externalEffectUnknown"], true);
        assert_eq!(wire["localEffectCount"], 0);
    }
}
