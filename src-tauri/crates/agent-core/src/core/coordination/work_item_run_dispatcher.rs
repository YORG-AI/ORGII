//! Durable Work Item Run dispatcher.
//!
//! Producers commit a `pm_work_item_runs` row and its outbox row in one
//! transaction. This worker is the only runtime delivery path: it claims an
//! expiring lease, materializes or resumes the target Session with the Run id
//! as the durable turn intent, then acknowledges delivery. A process crash at
//! any boundary is reconciled from the persisted Session/intent state.

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use project_management::projects::types::{
    WorkItemDispatchLease, WorkItemExecutionLockReason, WorkItemRunStatus, WorkItemRunTarget,
    WorkItemRunTrigger, WorkItemRunUsage,
};
use project_management::work_run_service::{self, WorkItemRunTerminalOutcome};
use tauri::Manager;
use tracing::{debug, error, info, warn};

use super::conversation_turn_bridge;
use crate::foundation::session_bridge::TurnIntentBridgeStatus;

const LEASE_MS: i64 = 30_000;
// Normal delivery is event-driven: in-process commits notify `DISPATCH_WAKE`
// and external CLI/desktop commits advance the PM watermark, which wakes this
// loop within the watermark observer's short window. Keep a coarse final
// safety net for corrupted/missed signals without turning an idle desktop
// into a recurring SQLite scan.
const CRASH_RECOVERY_POLL_MS: u64 = 5 * 60_000;
const BLOCKED_PATH_RECHECK_MS: u64 = 5_000;
const MAX_BATCH: usize = 8;
static DISPATCH_WAKE: OnceLock<Arc<tokio::sync::Notify>> = OnceLock::new();

/// Wake the process-local dispatcher after the cross-process PM watermark
/// observes a durable outbox write.
pub fn wake_from_watermark() {
    if let Some(wake) = DISPATCH_WAKE.get() {
        wake.notify_one();
    }
}

/// Start the single durable dispatcher loop. The first readiness probe is
/// immediate so fully-quit recovery does not wait for the recovery interval.
pub fn spawn(app: tauri::AppHandle) {
    let worker_id = format!("desktop_{}", uuid::Uuid::new_v4().simple());
    let wake = Arc::clone(DISPATCH_WAKE.get_or_init(|| Arc::new(tokio::sync::Notify::new())));
    let notifier = Arc::clone(&wake);
    project_management::projects::events::register_work_item_dispatch_ready_notifier(Box::new(
        move || notifier.notify_one(),
    ));
    tauri::async_runtime::spawn(async move {
        info!(worker_id, "[work-run-dispatcher] started");
        reconcile_interrupted_session_runs(&app).await;
        crate::orchestrator_notify::reconcile_terminal_routine_dispatches(&app).await;
        loop {
            let ready =
                match tokio::task::spawn_blocking(work_run_service::has_claimable_dispatch).await {
                    Ok(Ok(ready)) => ready,
                    Ok(Err(err)) => {
                        error!(error = %err, "[work-run-dispatcher] readiness probe failed");
                        false
                    }
                    Err(err) => {
                        error!(error = %err, "[work-run-dispatcher] readiness task failed");
                        false
                    }
                };

            if !ready {
                let delay = dispatcher_wait_duration().await;
                tokio::select! {
                    _ = wake.notified() => {}
                    _ = tokio::time::sleep(delay) => {}
                }
                continue;
            }

            let mut handled = 0usize;
            for _ in 0..MAX_BATCH {
                let claim_worker_id = worker_id.clone();
                let lease = match tokio::task::spawn_blocking(move || {
                    work_run_service::claim_next_dispatch(&claim_worker_id, LEASE_MS)
                })
                .await
                {
                    Ok(Ok(lease)) => lease,
                    Ok(Err(err)) => {
                        error!(error = %err, "[work-run-dispatcher] claim failed");
                        break;
                    }
                    Err(err) => {
                        error!(error = %err, "[work-run-dispatcher] claim task failed");
                        break;
                    }
                };
                let Some(lease) = lease else {
                    break;
                };
                handled += 1;
                if let Err(err) = dispatch_claim(&app, &lease).await {
                    let dispatch_id = lease.dispatch_id.clone();
                    let lease_token = lease.lease_token.clone();
                    let failure_message = err.clone();
                    match tokio::task::spawn_blocking(move || {
                        work_run_service::record_dispatch_failure(
                            &dispatch_id,
                            &lease_token,
                            &failure_message,
                        )
                    })
                    .await
                    {
                        Ok(Ok(run)) => {
                            warn!(
                                run_id = %run.id,
                                status = run.status.as_str(),
                                error = %err,
                                "[work-run-dispatcher] delivery failed"
                            );
                            crate::orchestrator_notify::notify_routine_fire_dispatch_terminal(
                                &run, &app,
                            )
                            .await;
                        }
                        Ok(Err(nack_err)) => error!(
                            run_id = %lease.run.id,
                            error = %err,
                            nack_error = %nack_err,
                            "[work-run-dispatcher] failed to record delivery failure"
                        ),
                        Err(join_err) => error!(
                            run_id = %lease.run.id,
                            error = %err,
                            join_error = %join_err,
                            "[work-run-dispatcher] failure task crashed"
                        ),
                    }
                }
            }

            if handled > 0 {
                tokio::task::yield_now().await;
            }
        }
    });
}

async fn dispatcher_wait_duration() -> Duration {
    let due_at = tokio::task::spawn_blocking(work_run_service::next_dispatch_due_at_ms)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    let Some(due_at) = due_at else {
        return Duration::from_millis(CRASH_RECOVERY_POLL_MS);
    };
    let now = chrono::Utc::now().timestamp_millis();
    if due_at <= now {
        // A ready deadline with no claimable row is normally a path-lock
        // conflict. Recheck read-only at a coarse cadence until the terminal
        // signal releases the lock; never spin or reserve SQLite's writer.
        return Duration::from_millis(BLOCKED_PATH_RECHECK_MS);
    }
    Duration::from_millis(
        u64::try_from(due_at - now)
            .unwrap_or(CRASH_RECOVERY_POLL_MS)
            .min(CRASH_RECOVERY_POLL_MS),
    )
}

/// Close the crash window between dispatch acknowledgement and provider
/// terminal persistence.
///
/// `AgentAppState` first converts every process-interrupted Session to
/// `abandoned`. The dispatcher then settles the owning execution episode and,
/// while budget remains, enqueues a new episode that resumes the same Session.
/// Routine fires deliberately stay active across that retry and are closed by
/// the ordinary Session-terminal path once the resumed turn really finishes.
async fn reconcile_interrupted_session_runs(app: &tauri::AppHandle) {
    let candidates = match tokio::task::spawn_blocking(|| {
        let runs = work_run_service::list_active_session_runs()?;
        runs.into_iter()
            .map(|run| {
                let session = run
                    .session_id
                    .as_deref()
                    .map(crate::session::persistence::get_session)
                    .transpose()
                    .map_err(|err| err.to_string())?
                    .flatten();
                Ok((run, session))
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    {
        Ok(Ok(candidates)) => candidates,
        Ok(Err(err)) => {
            error!(error = %err, "[work-run-dispatcher] startup recovery query failed");
            return;
        }
        Err(err) => {
            error!(error = %err, "[work-run-dispatcher] startup recovery task failed");
            return;
        }
    };

    for (run, session) in candidates {
        if let Some(prepared_runner) =
            prepared_remote_runner_for(&run.target_snapshot.target, run.session_id.as_deref())
        {
            let intent =
                crate::foundation::session_bridge::get_turn_intent_status(prepared_runner, &run.id);
            if intent.is_some_and(|status| {
                matches!(
                    status,
                    TurnIntentBridgeStatus::Completed
                        | TurnIntentBridgeStatus::Cancelled
                        | TurnIntentBridgeStatus::Failed
                        | TurnIntentBridgeStatus::Stale
                        | TurnIntentBridgeStatus::Coalesced
                        | TurnIntentBridgeStatus::Rejected
                )
            }) {
                reconcile_terminal_intent(&run.id, prepared_runner).await;
                continue;
            }
            if run.status == WorkItemRunStatus::Dispatching && intent.is_none() {
                // Prepare persisted only a runner hint; transport never
                // accepted this Run. Leave the leased outbox reclaimable so
                // the next fenced offer can reuse or replace the hint.
                continue;
            }
        }

        let Some(session) = session else {
            warn!(
                run_id = %run.id,
                session_id = ?run.session_id,
                "[work-run-dispatcher] active Run references a missing Session"
            );
            continue;
        };
        let Some(status) = crate::session::SessionStatus::parse(&session.status) else {
            warn!(
                run_id = %run.id,
                session_id = %session.session_id,
                status = %session.status,
                "[work-run-dispatcher] active Run references a Session with unknown status"
            );
            continue;
        };

        use crate::session::SessionStatus;
        let (outcome, message, routine_status, should_retry) = match status {
            SessionStatus::Completed => (
                WorkItemRunTerminalOutcome::Succeeded,
                None,
                Some(crate::persistence::db_helpers::AgentSessionStatus::Completed),
                false,
            ),
            SessionStatus::Abandoned | SessionStatus::Timeout => (
                WorkItemRunTerminalOutcome::Failed,
                Some(
                    "request timed out because the app restarted before the turn reached a durable terminal"
                        .to_string(),
                ),
                Some(crate::persistence::db_helpers::AgentSessionStatus::Cancelled),
                true,
            ),
            SessionStatus::Failed | SessionStatus::Archived => (
                WorkItemRunTerminalOutcome::Failed,
                Some("runtime crashed or failed before Run terminal persistence".to_string()),
                Some(crate::persistence::db_helpers::AgentSessionStatus::Failed),
                false,
            ),
            SessionStatus::Cancelled => (
                WorkItemRunTerminalOutcome::Cancelled,
                Some("session was cancelled before Run terminal persistence".to_string()),
                Some(crate::persistence::db_helpers::AgentSessionStatus::Cancelled),
                false,
            ),
            SessionStatus::Pending
            | SessionStatus::Idle
            | SessionStatus::Running
            | SessionStatus::WaitingForUser
            | SessionStatus::WaitingForFunds
            | SessionStatus::Paused => continue,
        };

        let run_id = run.id.clone();
        let session_id = session.session_id.clone();
        let usage = WorkItemRunUsage {
            total_tokens: session.total_tokens.max(0) as u64,
            ..Default::default()
        };
        let terminal_message = message.clone();
        let settled = match tokio::task::spawn_blocking(move || {
            work_run_service::record_run_terminal(
                &run_id,
                Some(&session_id),
                outcome,
                usage,
                terminal_message.as_deref(),
            )
        })
        .await
        {
            Ok(Ok(run)) => run,
            Ok(Err(err)) => {
                error!(
                    run_id = %run.id,
                    session_id = %session.session_id,
                    error = %err,
                    "[work-run-dispatcher] startup Run settlement failed"
                );
                continue;
            }
            Err(err) => {
                error!(
                    run_id = %run.id,
                    session_id = %session.session_id,
                    error = %err,
                    "[work-run-dispatcher] startup Run settlement task failed"
                );
                continue;
            }
        };

        if should_retry
            && settled
                .failure
                .as_ref()
                .is_some_and(|failure| failure.retryable)
        {
            let failed_run_id = settled.id.clone();
            let retry_key = format!("startup-recovery:{}:{}", settled.id, settled.generation);
            match tokio::task::spawn_blocking(move || {
                work_run_service::retry(&failed_run_id, &retry_key)
            })
            .await
            {
                Ok(Ok(retry)) => {
                    info!(
                        run_id = %settled.id,
                        retry_run_id = %retry.id,
                        session_id = %session.session_id,
                        attempt = retry.attempt,
                        max_attempts = retry.max_attempts,
                        "[work-run-dispatcher] recovered interrupted Run with durable retry"
                    );
                    continue;
                }
                Ok(Err(err)) => warn!(
                    run_id = %settled.id,
                    session_id = %session.session_id,
                    error = %err,
                    "[work-run-dispatcher] interrupted Run could not be retried"
                ),
                Err(err) => warn!(
                    run_id = %settled.id,
                    session_id = %session.session_id,
                    error = %err,
                    "[work-run-dispatcher] interrupted Run retry task failed"
                ),
            }
        }

        if let Some(status) = routine_status {
            crate::orchestrator_notify::notify_routine_fire_session_terminal(
                &session.session_id,
                status,
                Some(app),
            )
            .await;
        }
    }
}

async fn dispatch_claim(
    app: &tauri::AppHandle,
    lease: &WorkItemDispatchLease,
) -> Result<(), String> {
    let run = &lease.run;

    // A previous claimant may have prepared and sent this exact turn before
    // crashing ahead of ack. Reclaim by acknowledging the persisted intent;
    // never offer/send the same `(runner Session, Run)` twice.
    if let Some(prepared_session_id) =
        prepared_remote_runner_for(&run.target_snapshot.target, run.session_id.as_deref())
    {
        if session_is_local(prepared_session_id).await?
            && crate::foundation::session_bridge::get_turn_intent_status(
                prepared_session_id,
                &run.id,
            )
            .is_some()
        {
            acknowledge_dispatch_delivery(
                app,
                &run.id,
                &lease.dispatch_id,
                &lease.lease_token,
                None,
                prepared_session_id,
            )
            .await?;
            return Ok(());
        }
    }

    let session_id = match &run.target_snapshot.target {
        WorkItemRunTarget::StartWorkItem {
            account_id,
            model_id,
        } => {
            if let Some(launch_snapshot) = run.input.get("sessionLaunchParams") {
                dispatch_snapshotted_session_launch(app, run, launch_snapshot.clone()).await?
            } else {
                let project_slug = run.project_slug.as_deref().ok_or_else(|| {
                    "starting a standalone Work Item is not supported by the native launcher"
                        .to_string()
                })?;
                let started = crate::tool_infra::start_work_item_session_with_reason(
                    crate::tool_infra::StartWorkItemSessionRequest {
                        project_slug,
                        short_id: &run.work_item_id,
                        app,
                        session_account_id: account_id.as_deref(),
                        session_model_id: model_id.as_deref(),
                        lock_reason: lock_reason(&run.trigger),
                        durable_run_id: Some(&run.id),
                        execution_snapshot: Some(&run.target_snapshot),
                    },
                )
                .await?;
                started.session_id
            }
        }
        WorkItemRunTarget::ResumeSession { session_id } => {
            if session_is_local(session_id).await? {
                dispatch_session_turn(app, lease, session_id).await?;
            } else {
                request_remote_root_turn(app, lease, session_id).await?;
                // Frontend acceptance only claims the offer. The durable
                // outbox stays leased until prepare→send→ack names the exact
                // local runner selected by the winning window.
                return Ok(());
            }
            session_id.clone()
        }
    };

    acknowledge_dispatch_delivery(
        app,
        &run.id,
        &lease.dispatch_id,
        &lease.lease_token,
        None,
        &session_id,
    )
    .await
}

async fn acknowledge_dispatch_delivery(
    app: &tauri::AppHandle,
    run_id: &str,
    dispatch_id: &str,
    lease_token: &str,
    claim_token: Option<&str>,
    session_id: &str,
) -> Result<(), String> {
    let dispatch_id = dispatch_id.to_string();
    let lease_token = lease_token.to_string();
    let ack_claim_token = claim_token.map(str::to_string);
    let ack_session_id = session_id.to_string();
    let durable_ack = tokio::task::spawn_blocking(move || match ack_claim_token.as_deref() {
        Some(claim_token) => work_run_service::acknowledge_claimed_dispatch_started(
            &dispatch_id,
            &lease_token,
            claim_token,
            &ack_session_id,
        ),
        None => work_run_service::acknowledge_dispatch_started(
            &dispatch_id,
            &lease_token,
            &ack_session_id,
        ),
    })
    .await
    .map_err(|err| format!("dispatch acknowledgement task failed: {err}"))?;
    let acknowledged = match durable_ack {
        Ok(run) => run,
        Err(err) => {
            // The exact runtime terminal may win the race and retire the
            // still-leased outbox. In that case the desired terminal is
            // already durable and a late ack is an idempotent success.
            let terminal_won = work_run_service::read(run_id)
                .map(|run| {
                    run.status.is_terminal() && run.session_id.as_deref() == Some(session_id)
                })
                .unwrap_or(false);
            if terminal_won {
                return Ok(());
            }
            return Err(err);
        }
    };

    let routine_origin = match &acknowledged.trigger {
        WorkItemRunTrigger::Routine {
            routine_id,
            fire_id,
        } => Some((routine_id.clone(), fire_id.clone())),
        WorkItemRunTrigger::Retry { .. } => {
            let run_id = acknowledged.id.clone();
            match tokio::task::spawn_blocking(move || work_run_service::routine_origin(&run_id))
                .await
            {
                Ok(Ok(origin)) => origin,
                Ok(Err(err)) => {
                    warn!(
                        run_id = %acknowledged.id,
                        error = %err,
                        "[work-run-dispatcher] retry Routine provenance lookup failed"
                    );
                    None
                }
                Err(err) => {
                    warn!(
                        run_id = %acknowledged.id,
                        error = %err,
                        "[work-run-dispatcher] retry Routine provenance task failed"
                    );
                    None
                }
            }
        }
        _ => None,
    };
    if let Some((routine_id, fire_id)) = routine_origin {
        let fire_id_for_update = fire_id.clone();
        let work_item_id = acknowledged.work_item_id.clone();
        let fire_session_id = session_id.to_string();
        let linked = tokio::task::spawn_blocking(move || {
            project_management::projects::io::mark_routine_fire_work_item_started(
                &fire_id_for_update,
                &work_item_id,
                Some(&fire_session_id),
            )
        })
        .await;
        match linked {
            Ok(Ok(_)) => crate::state::commands::routines::emit_routine_changed(
                app,
                &routine_id,
                Some(&fire_id),
                "started",
            ),
            Ok(Err(err)) => warn!(
                run_id = %acknowledged.id,
                error = %err,
                "[work-run-dispatcher] routine fire link failed after delivery"
            ),
            Err(err) => warn!(
                run_id = %acknowledged.id,
                error = %err,
                "[work-run-dispatcher] routine fire link task failed after delivery"
            ),
        }
    }

    reconcile_terminal_intent(&acknowledged.id, &session_id).await;
    debug!(
        run_id = %acknowledged.id,
        session_id,
        "[work-run-dispatcher] delivered"
    );
    Ok(())
}

/// Prepare the real local runner for an accepted remote-root hand-off. This
/// does not acknowledge delivery: the frontend prepares before transport
/// send, then calls the separate ack only after the exact intent is accepted.
pub(crate) async fn prepare_remote_conversation_runner(
    run_id: &str,
    claim_token: &str,
    root_session_id: &str,
    runner_session_id: &str,
) -> Result<(), String> {
    if runner_session_id.trim().is_empty() {
        return Err("runner_session_id is required".to_string());
    }
    if !session_is_local(runner_session_id).await? {
        return Err(format!(
            "conversation turn runner {runner_session_id} is not a local Session"
        ));
    }
    conversation_turn_bridge::prepare_bound_claim(
        run_id,
        claim_token,
        root_session_id,
        runner_session_id,
    )?;
    let claim = conversation_turn_bridge::prepared_claim(
        run_id,
        claim_token,
        root_session_id,
        runner_session_id,
    )?;
    let dispatch_id = claim.dispatch_id;
    let lease_token = claim.lease_token;
    let prepared_claim_token = claim_token.to_string();
    let prepared_session_id = runner_session_id.to_string();
    tokio::task::spawn_blocking(move || {
        work_run_service::prepare_dispatch_session(
            &dispatch_id,
            &lease_token,
            &prepared_claim_token,
            &prepared_session_id,
        )
    })
    .await
    .map_err(|err| format!("dispatch prepare task failed: {err}"))??;
    Ok(())
}

/// Acknowledge only the exact runner prepared under this claim. The in-memory
/// claim is consumed after the durable acknowledgement commits, so response
/// loss can be retried idempotently from the stored claim receipt.
pub(crate) async fn ack_remote_conversation_runner(
    app: &tauri::AppHandle,
    run_id: &str,
    claim_token: &str,
    root_session_id: &str,
    runner_session_id: &str,
) -> Result<(), String> {
    if runner_session_id.trim().is_empty() {
        return Err("runner_session_id is required".to_string());
    }
    if !session_is_local(runner_session_id).await? {
        return Err(format!(
            "conversation turn runner {runner_session_id} is not a local Session"
        ));
    }
    let claim = match conversation_turn_bridge::prepared_claim(
        run_id,
        claim_token,
        root_session_id,
        runner_session_id,
    ) {
        Ok(claim) => claim,
        Err(claim_error) => {
            if durable_remote_ack_is_exact(run_id, claim_token, root_session_id, runner_session_id)
                .await?
            {
                reconcile_terminal_intent(run_id, runner_session_id).await;
                return Ok(());
            }
            return Err(claim_error);
        }
    };

    let acknowledged = acknowledge_dispatch_delivery(
        app,
        run_id,
        &claim.dispatch_id,
        &claim.lease_token,
        Some(claim_token),
        runner_session_id,
    )
    .await;
    match acknowledged {
        Ok(()) => {
            conversation_turn_bridge::consume_prepared_claim(
                run_id,
                &claim.lease_token,
                claim_token,
                root_session_id,
                runner_session_id,
            );
            Ok(())
        }
        Err(ack_error) => {
            if durable_remote_ack_is_exact(run_id, claim_token, root_session_id, runner_session_id)
                .await?
            {
                conversation_turn_bridge::consume_prepared_claim(
                    run_id,
                    &claim.lease_token,
                    claim_token,
                    root_session_id,
                    runner_session_id,
                );
                reconcile_terminal_intent(run_id, runner_session_id).await;
                Ok(())
            } else {
                Err(ack_error)
            }
        }
    }
}

async fn durable_remote_ack_is_exact(
    run_id: &str,
    claim_token: &str,
    root_session_id: &str,
    runner_session_id: &str,
) -> Result<bool, String> {
    let durable_run_id = run_id.to_string();
    let durable_claim_token = claim_token.to_string();
    let durable_root_session_id = root_session_id.to_string();
    let durable_runner_session_id = runner_session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let run = work_run_service::read(&durable_run_id)?;
        let delivered = work_run_service::delivered_dispatch_matches_claim(
            &durable_run_id,
            &durable_claim_token,
        )?;
        Ok(durable_remote_ack_identity_matches(
            delivered,
            &run.target_snapshot.target,
            run.session_id.as_deref(),
            &durable_root_session_id,
            &durable_runner_session_id,
        ))
    })
    .await
    .map_err(|err| format!("durable conversation ack lookup task failed: {err}"))?
}

fn durable_remote_ack_identity_matches(
    delivered: bool,
    target: &WorkItemRunTarget,
    bound_session_id: Option<&str>,
    root_session_id: &str,
    runner_session_id: &str,
) -> bool {
    delivered
        && bound_session_id == Some(runner_session_id)
        && matches!(
            target,
            WorkItemRunTarget::ResumeSession { session_id } if session_id == root_session_id
        )
}

async fn dispatch_snapshotted_session_launch(
    app: &tauri::AppHandle,
    run: &project_management::projects::types::WorkItemRun,
    launch_snapshot: serde_json::Value,
) -> Result<String, String> {
    let mut params: crate::state::commands::session::launch::SessionLaunchParams =
        serde_json::from_value(launch_snapshot)
            .map_err(|err| format!("invalid durable session launch snapshot: {err}"))?;
    params.durable_run_id = Some(run.id.clone());
    let state = app.state::<crate::state::AgentAppState>();
    let org_store = app.state::<std::sync::Arc<crate::definitions::orgs::AgentOrgsStore>>();
    let result = crate::state::commands::session::launch::session_launch_impl(
        &state,
        Some(org_store.inner()),
        params,
    )
    .await?;
    Ok(result.session_id)
}

async fn dispatch_session_turn(
    app: &tauri::AppHandle,
    lease: &WorkItemDispatchLease,
    session_id: &str,
) -> Result<(), String> {
    let run_id = &lease.run.id;
    if crate::foundation::session_bridge::get_turn_intent_status(session_id, run_id).is_some() {
        return Ok(());
    }

    let content = durable_resume_content(&lease.run.input)
        .unwrap_or_default()
        .to_string();
    if content.trim().is_empty() {
        return Err("durable resume dispatch is missing input.content".to_string());
    }
    let display_text = lease
        .run
        .input
        .get("displayText")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let client_message_id = lease
        .run
        .input
        .get("clientMessageId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(run_id)
        .to_string();

    if crate::foundation::session_bridge::get_cli_tools_snapshot(session_id)?.is_some() {
        return crate::foundation::session_bridge::dispatch_cli_turn(
            crate::foundation::session_bridge::CliTurnDispatchParams {
                session_id: session_id.to_string(),
                content,
                turn_intent_id: run_id.clone(),
                client_message_id,
            },
        )
        .await;
    }

    let state: tauri::State<'_, crate::state::AgentAppState> = app.state();
    crate::state::commands::session::message::send_message_impl(
        &state,
        session_id.to_string(),
        content,
        display_text,
        crate::state::commands::session::identity::IdentityOverrides::default(),
        None,
        None,
        None,
        false,
        false,
        Some(client_message_id),
        Some(run_id.clone()),
        None,
        None,
        crate::foundation::session_bridge::TurnIntentBridgeSource::Queue,
    )
    .await
    .map(|_| ())
}

async fn session_is_local(session_id: &str) -> Result<bool, String> {
    let lookup_id = session_id.to_string();
    let persisted = tokio::task::spawn_blocking(move || {
        crate::session::persistence::get_session(&lookup_id).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("session lookup task failed: {err}"))??;
    if persisted.is_some() {
        return Ok(true);
    }
    Ok(crate::foundation::session_bridge::get_cli_tools_snapshot(session_id)?.is_some())
}

fn prepared_remote_runner_for<'a>(
    target: &WorkItemRunTarget,
    bound_session_id: Option<&'a str>,
) -> Option<&'a str> {
    let WorkItemRunTarget::ResumeSession { session_id } = target else {
        return None;
    };
    bound_session_id.filter(|runner_session_id| *runner_session_id != session_id)
}

/// The target Session belongs to another member: offer the turn to a local
/// conversation runner instead of treating the remote root as missing.
async fn request_remote_root_turn(
    app: &tauri::AppHandle,
    lease: &WorkItemDispatchLease,
    root_session_id: &str,
) -> Result<(), String> {
    let run = &lease.run;
    let content = durable_resume_content(&run.input)
        .unwrap_or_default()
        .to_string();
    if content.trim().is_empty() {
        return Err("durable resume dispatch is missing input.content".to_string());
    }
    let discussion_comment_ids = run
        .input
        .get("discussionCommentIds")
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    info!(
        run_id = %run.id,
        root_session_id,
        "[work-run-dispatcher] target Session is not local; offering conversation turn"
    );
    conversation_turn_bridge::request_conversation_turn(
        app,
        conversation_turn_bridge::ConversationTurnRequest {
            run_id: run.id.clone(),
            dispatch_id: lease.dispatch_id.clone(),
            org_id: run.org_id.clone(),
            project_slug: run.project_slug.clone(),
            work_item_id: run.work_item_id.clone(),
            work_item_title: run.target_snapshot.work_item_title.clone(),
            assigned_agent_id: run.target_snapshot.agent_definition_id.clone(),
            root_session_id: root_session_id.to_string(),
            prepared_runner_session_id: prepared_remote_runner_for(
                &run.target_snapshot.target,
                run.session_id.as_deref(),
            )
            .map(str::to_string),
            content,
            display_text: run
                .input
                .get("displayText")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            discussion_comment_ids,
        },
        lease.lease_token.clone(),
    )
    .await
}

fn durable_resume_content(input: &serde_json::Value) -> Option<&str> {
    ["content", "prompt", "instruction"]
        .into_iter()
        .find_map(|key| input.get(key).and_then(serde_json::Value::as_str))
        .or_else(|| input.as_str())
}

async fn reconcile_terminal_intent(run_id: &str, session_id: &str) {
    let Some(status) =
        crate::foundation::session_bridge::get_turn_intent_status(session_id, run_id)
    else {
        return;
    };
    let (outcome, message) = match status {
        TurnIntentBridgeStatus::Completed => (WorkItemRunTerminalOutcome::Succeeded, None),
        TurnIntentBridgeStatus::Cancelled => (
            WorkItemRunTerminalOutcome::Cancelled,
            Some("durable turn was cancelled".to_string()),
        ),
        TurnIntentBridgeStatus::Failed => (
            WorkItemRunTerminalOutcome::Failed,
            Some("runtime crashed or failed while executing durable turn".to_string()),
        ),
        TurnIntentBridgeStatus::Stale
        | TurnIntentBridgeStatus::Coalesced
        | TurnIntentBridgeStatus::Rejected => (
            WorkItemRunTerminalOutcome::Failed,
            Some(format!(
                "durable turn became terminal before execution: {}",
                status.as_str()
            )),
        ),
        TurnIntentBridgeStatus::Optimistic
        | TurnIntentBridgeStatus::Queued
        | TurnIntentBridgeStatus::Running => return,
    };
    let terminal_run_id = run_id.to_string();
    let terminal_session_id = session_id.to_string();
    match tokio::task::spawn_blocking(move || {
        work_run_service::record_run_terminal(
            &terminal_run_id,
            Some(&terminal_session_id),
            outcome,
            WorkItemRunUsage::default(),
            message.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(run)) => info!(
            run_id = %run.id,
            status = run.status.as_str(),
            "[work-run-dispatcher] reconciled persisted terminal intent"
        ),
        Ok(Err(err)) => error!(
            run_id,
            session_id,
            error = %err,
            "[work-run-dispatcher] terminal reconciliation failed"
        ),
        Err(err) => error!(
            run_id,
            session_id,
            error = %err,
            "[work-run-dispatcher] terminal reconciliation task failed"
        ),
    }
}

fn lock_reason(trigger: &WorkItemRunTrigger) -> WorkItemExecutionLockReason {
    match trigger {
        WorkItemRunTrigger::Manual => WorkItemExecutionLockReason::ManualStart,
        WorkItemRunTrigger::Schedule { .. } | WorkItemRunTrigger::Routine { .. } => {
            WorkItemExecutionLockReason::RoutineAutoStart
        }
        WorkItemRunTrigger::DiscussionComment { .. } | WorkItemRunTrigger::StageBarrier { .. } => {
            WorkItemExecutionLockReason::AssignmentWakeup
        }
        WorkItemRunTrigger::Review { .. }
        | WorkItemRunTrigger::FollowUp { .. }
        | WorkItemRunTrigger::Retry { .. } => WorkItemExecutionLockReason::FollowUp,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        durable_remote_ack_identity_matches, durable_resume_content, lock_reason,
        prepared_remote_runner_for,
    };
    use project_management::projects::types::{
        WorkItemExecutionLockReason, WorkItemRunTarget, WorkItemRunTrigger,
    };

    #[test]
    fn trigger_maps_to_auditable_lock_reason() {
        assert_eq!(
            lock_reason(&WorkItemRunTrigger::Manual),
            WorkItemExecutionLockReason::ManualStart
        );
        assert_eq!(
            lock_reason(&WorkItemRunTrigger::StageBarrier {
                parent_work_item_id: "WI-1".to_string(),
                stage: Some(2),
                settled_key: "stage2".to_string(),
            }),
            WorkItemExecutionLockReason::AssignmentWakeup
        );
    }

    #[test]
    fn routine_prompt_is_valid_durable_resume_content() {
        let input = serde_json::json!({"prompt": "finish the routine"});
        assert_eq!(durable_resume_content(&input), Some("finish the routine"));
    }

    #[test]
    fn prepared_remote_runner_never_replaces_the_immutable_root_target() {
        let target = WorkItemRunTarget::ResumeSession {
            session_id: "shared-root".to_string(),
        };
        assert_eq!(
            prepared_remote_runner_for(&target, Some("hidden-runner")),
            Some("hidden-runner")
        );
        assert_eq!(prepared_remote_runner_for(&target, Some("shared-root")), None);
        assert!(durable_remote_ack_identity_matches(
            true,
            &target,
            Some("hidden-runner"),
            "shared-root",
            "hidden-runner",
        ));
        assert!(!durable_remote_ack_identity_matches(
            true,
            &target,
            Some("runner-other"),
            "shared-root",
            "hidden-runner",
        ));
    }
}
