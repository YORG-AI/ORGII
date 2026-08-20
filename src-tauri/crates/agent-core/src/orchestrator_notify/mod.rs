//! Orchestrator notification, review feedback extraction, and proof-of-work collection.

use crate::persistence::db_helpers::AgentSessionStatus;
use crate::session::persistence as session_persistence;

/// Rough session cost estimate: $0.003 / 1K tokens, the same placeholder
/// rate `session_directory` uses. Real billing comes from the hosted service;
/// this replaces the previous hardcoded `0.0` so proof-of-work totals
/// accumulate something meaningful.
fn estimate_cost_usd(total_tokens: u64) -> f64 {
    (total_tokens as f64 / 1000.0) * 0.003
}

/// Reconcile pre-Session Routine failures left behind by a process exit or an
/// older build, then unblock the routine's configured concurrency queue.
pub(crate) async fn reconcile_terminal_routine_dispatches(app: &tauri::AppHandle) {
    let fires = match tokio::task::spawn_blocking(
        project_management::projects::io::reconcile_terminal_dispatch_fires,
    )
    .await
    {
        Ok(Ok(fires)) => fires,
        Ok(Err(err)) => {
            tracing::warn!(error = %err, "[routine] terminal dispatch reconciliation failed");
            return;
        }
        Err(err) => {
            tracing::warn!(error = %err, "[routine] terminal dispatch reconciliation task failed");
            return;
        }
    };

    for fire in fires {
        crate::state::commands::routines::emit_routine_changed(
            app,
            &fire.routine_id,
            Some(&fire.id),
            "failed",
        );
        dequeue_next_routine_fire(app, &fire.routine_id).await;
    }
}

/// A Routine-backed dispatch can fail before a Session exists, so the normal
/// Session-terminal notifier never gets a chance to close its fire. Reconcile
/// that terminal edge directly from the durable Work Item Run and continue
/// the routine's queued-fire policy.
pub(crate) async fn notify_routine_fire_dispatch_terminal(
    run: &project_management::projects::types::WorkItemRun,
    app: &tauri::AppHandle,
) {
    use project_management::projects::types::{WorkItemRunStatus, WorkItemRunTrigger};

    if !matches!(
        run.status,
        WorkItemRunStatus::Failed | WorkItemRunStatus::Cancelled
    ) {
        return;
    }
    let origin = match &run.trigger {
        WorkItemRunTrigger::Routine {
            routine_id,
            fire_id,
        } => Some((routine_id.clone(), fire_id.clone())),
        WorkItemRunTrigger::Retry { .. } => {
            let run_id = run.id.clone();
            match tokio::task::spawn_blocking(move || {
                project_management::work_run_service::routine_origin(&run_id)
            })
            .await
            {
                Ok(Ok(origin)) => origin,
                Ok(Err(err)) => {
                    tracing::warn!(
                        run_id = %run.id,
                        error = %err,
                        "[routine] retry provenance lookup failed"
                    );
                    None
                }
                Err(err) => {
                    tracing::warn!(
                        run_id = %run.id,
                        error = %err,
                        "[routine] retry provenance task failed"
                    );
                    None
                }
            }
        }
        _ => None,
    };
    let Some((routine_id, fire_id)) = origin else {
        return;
    };

    let fire_id_for_update = fire_id.clone();
    let message = run
        .failure
        .as_ref()
        .map(|failure| failure.message.clone())
        .unwrap_or_else(|| "Work Item dispatch terminated before Session launch".to_string());
    let result = tokio::task::spawn_blocking(move || {
        project_management::projects::io::mark_routine_fire_failed(&fire_id_for_update, &message)
    })
    .await;

    match result {
        Ok(Ok(updated)) => {
            crate::state::commands::routines::emit_routine_changed(
                app,
                &updated.routine_id,
                Some(&updated.id),
                "failed",
            );
            dequeue_next_routine_fire(app, &routine_id).await;
        }
        Ok(Err(err)) => tracing::warn!(
            run_id = %run.id,
            fire_id,
            error = %err,
            "[routine] failed to close fire after terminal dispatch"
        ),
        Err(err) => tracing::warn!(
            run_id = %run.id,
            fire_id,
            error = %err,
            "[routine] fire close task failed after terminal dispatch"
        ),
    }
}

/// Close the loop on routine fires when their session terminates:
/// mark the fire succeeded/failed, then execute the oldest queued fire
/// of the same routine (QueueIfActive dequeue).
pub async fn notify_routine_fire_session_terminal(
    session_id: &str,
    status: AgentSessionStatus,
    app_handle: Option<&tauri::AppHandle>,
) {
    let sid = session_id.to_string();
    let fire = match tokio::task::spawn_blocking(move || {
        project_management::projects::io::find_started_fire_by_session(&sid)
    })
    .await
    {
        Ok(Ok(Some(fire))) => fire,
        Ok(Ok(None)) => return,
        Ok(Err(err)) => {
            tracing::warn!("[routine] fire lookup failed for {}: {}", session_id, err);
            return;
        }
        Err(err) => {
            tracing::warn!("[routine] fire lookup join error: {}", err);
            return;
        }
    };

    let fire_id = fire.id.clone();
    let succeeded = matches!(status, AgentSessionStatus::Completed);
    let mark_result = tokio::task::spawn_blocking(move || {
        if succeeded {
            project_management::projects::io::mark_routine_fire_succeeded(&fire_id)
        } else {
            project_management::projects::io::mark_routine_fire_failed(
                &fire_id,
                "Session terminated without success",
            )
        }
    })
    .await;
    match mark_result {
        Ok(Ok(updated)) => {
            tracing::info!(
                "[routine] fire {} closed as {:?} (session {})",
                updated.id,
                updated.status,
                session_id
            );
            if let Some(app) = app_handle {
                crate::state::commands::routines::emit_routine_changed(
                    app,
                    &updated.routine_id,
                    Some(&updated.id),
                    if succeeded { "succeeded" } else { "failed" },
                );
            }
        }
        Ok(Err(err)) => {
            tracing::warn!("[routine] fire close failed for {}: {}", session_id, err);
            return;
        }
        Err(err) => {
            tracing::warn!("[routine] fire close join error: {}", err);
            return;
        }
    }

    let Some(app) = app_handle else { return };
    dequeue_next_routine_fire(app, &fire.routine_id).await;
}

/// Promote and execute the oldest queued fire of `routine_id`, if any.
async fn dequeue_next_routine_fire(app: &tauri::AppHandle, routine_id: &str) {
    let routine_id_owned = routine_id.to_string();
    let promoted = match tokio::task::spawn_blocking(move || {
        project_management::projects::io::take_next_queued_fire(&routine_id_owned)
    })
    .await
    {
        Ok(Ok(Some(fire))) => fire,
        Ok(Ok(None)) => return,
        Ok(Err(err)) => {
            tracing::warn!("[routine] dequeue failed for {}: {}", routine_id, err);
            return;
        }
        Err(err) => {
            tracing::warn!("[routine] dequeue join error: {}", err);
            return;
        }
    };

    let routine_id_owned = routine_id.to_string();
    let routine = match tokio::task::spawn_blocking(move || {
        project_management::projects::io::read_routine(&routine_id_owned)
    })
    .await
    {
        Ok(Ok(routine)) if routine.enabled => routine,
        Ok(Ok(_)) => {
            let fire_id = promoted.id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                project_management::projects::io::mark_routine_fire_failed(
                    &fire_id,
                    "Routine was disabled while the fire was queued",
                )
            })
            .await;
            return;
        }
        _ => return,
    };

    tracing::info!(
        "[routine] executing dequeued fire {} for routine {}",
        promoted.id,
        routine.id
    );
    spawn_execute_pending_fire(app.clone(), routine, promoted);
}

/// Detached execution of a promoted fire. Deliberately a plain (non-async)
/// fn: the spawned future transitively awaits `launch_rust_agent_run`, whose
/// session-terminal path re-enters this module — keeping the Send proof in a
/// separate non-async borrow-check query breaks the E0391 opaque-type cycle.
fn spawn_execute_pending_fire(
    app: tauri::AppHandle,
    routine: project_management::projects::types::RoutineDefinition,
    fire: project_management::projects::types::RoutineFire,
) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state = app.state::<crate::state::AgentAppState>();
        let org_store = app.state::<std::sync::Arc<crate::definitions::orgs::AgentOrgsStore>>();
        if let Err(err) = crate::state::commands::routines::execute_pending_fire(
            state.inner(),
            org_store.inner(),
            &app,
            &routine,
            &fire,
        )
        .await
        {
            tracing::warn!(
                "[routine] dequeued fire {} execution failed: {}",
                fire.id,
                err
            );
        }
    });
}

/// Notify the orchestrator that a session reached a terminal state.
pub async fn notify_orchestrator_session_terminal(
    session_id: &str,
    status: AgentSessionStatus,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    tracing::debug!(
        "[orchestrator] notify_orchestrator_session_terminal called: session={}, status={:?}",
        session_id,
        status
    );

    let sid = session_id.to_string();
    let session = tokio::task::spawn_blocking(move || session_persistence::get_session(&sid))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    let session = match session {
        Some(session) => session,
        None => {
            tracing::warn!("[orchestrator] Session not found in DB: {}", session_id);
            return Ok(());
        }
    };

    let work_item_id = match session.work_item_id {
        Some(ref wid) if !wid.is_empty() => wid.clone(),
        _ => {
            tracing::debug!(
                "[orchestrator] Session {} has no work_item_id, skipping",
                session_id
            );
            return Ok(());
        }
    };

    // CLI sessions and legacy transports do not always expose the exact
    // durable turn-intent id at their terminal callback. Reconcile the
    // newest active Run for this Session before touching Work Item workflow
    // state. Rust turns normally arrive here already terminal and this call
    // becomes a no-op, preserving their exact per-turn usage snapshot.
    let run_outcome = match status {
        AgentSessionStatus::Completed => {
            project_management::work_run_service::WorkItemRunTerminalOutcome::Succeeded
        }
        AgentSessionStatus::Cancelled => {
            project_management::work_run_service::WorkItemRunTerminalOutcome::Cancelled
        }
        _ => project_management::work_run_service::WorkItemRunTerminalOutcome::Failed,
    };
    let run_terminal_session_id = session_id.to_string();
    let run_terminal_total_tokens = session.total_tokens.max(0) as u64;
    let run_terminal_error = if matches!(status, AgentSessionStatus::Failed) {
        Some("Session failed".to_string())
    } else {
        None
    };
    match tokio::task::spawn_blocking(move || {
        project_management::work_run_service::record_session_terminal(
            &run_terminal_session_id,
            run_outcome,
            project_management::projects::types::WorkItemRunUsage {
                total_tokens: run_terminal_total_tokens,
                cost_usd: estimate_cost_usd(run_terminal_total_tokens),
                ..Default::default()
            },
            run_terminal_error.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => tracing::warn!(
            session_id,
            error = %err,
            "[work-run] compatibility terminal reconciliation failed"
        ),
        Err(err) => tracing::warn!(
            session_id,
            error = %err,
            "[work-run] compatibility terminal reconciliation task failed"
        ),
    }

    let workspace_path = match session.workspace_path {
        Some(ref path) if !path.is_empty() => path.clone(),
        _ => {
            tracing::debug!(
                "[orchestrator] Session {} has no workspace_path, skipping",
                session_id
            );
            return Ok(());
        }
    };

    let worktree_path = session
        .worktree_path
        .as_ref()
        .filter(|p| !p.is_empty())
        .cloned();

    let session_id_owned = session.session_id.clone();
    let total_tokens = session.total_tokens as u64;
    let db_project_slug = session.project_slug.clone();
    let work_item_id_for_launch = work_item_id.clone();

    tracing::debug!(
        "[orchestrator] Transitioning work_item={}, workspace_path={}, slug={:?}",
        work_item_id,
        workspace_path,
        db_project_slug
    );

    let transition_result = tokio::task::spawn_blocking(move || {
        use project_management::orchestrator::state_machine;
        use core_types::workflow::LinkedSessionStatus;

        // Proof-of-work collection shells out to git and MUST run before
        // the atomic mutation opens its BEGIN IMMEDIATE transaction — a
        // hung subprocess inside the transaction holds the projects.db
        // write lock indefinitely and starves every other writer (seen
        // on-device). Bounded so a sick git also can't stall completion.
        let collected_proof = if matches!(status, AgentSessionStatus::Completed) {
            let diff_repo = worktree_path.as_deref().unwrap_or(&workspace_path);
            collect_proof_of_work_data_bounded(
                diff_repo,
                std::time::Duration::from_secs(10),
            )
        } else {
            None
        };

        let apply_transition = |slug: &str| -> Result<state_machine::TransitionResult, String> {
            state_machine::mutate_work_item(
                slug,
                &work_item_id,
                |frontmatter| {
                    // Stale-signal rejection (design §12.4): a terminal
                    // event from a session that no longer holds the
                    // execution claim must not complete a newer episode.
                    if let Some(active_session) = frontmatter
                        .execution_lock
                        .as_ref()
                        .and_then(|lock| lock.active_session_id.as_deref())
                    {
                        if active_session != session_id_owned {
                            tracing::warn!(
                                "[orchestrator] ignoring stale terminal from session {} \
                                 (active claim: {}) for work_item {}",
                                session_id_owned,
                                active_session,
                                frontmatter.short_id
                            );
                            return state_machine::TransitionResult::Ignored;
                        }
                    }
                    let linked_status = match status {
                        AgentSessionStatus::Completed => {
                            LinkedSessionStatus::Completed
                        }
                        AgentSessionStatus::Failed => {
                            LinkedSessionStatus::Failed
                        }
                        AgentSessionStatus::Cancelled => {
                            LinkedSessionStatus::Cancelled
                        }
                        _ => LinkedSessionStatus::Completed,
                    };

                    let agent_role = frontmatter
                        .linked_sessions
                        .iter()
                        .find(|ls| ls.session_id == session_id_owned)
                        .map(|ls| ls.agent_role.clone());

                    state_machine::complete_linked_session(
                        frontmatter,
                        &session_id_owned,
                        linked_status,
                        estimate_cost_usd(total_tokens),
                        total_tokens,
                    );

                    let _ = agent_role;
                    match status {
                        AgentSessionStatus::Completed => {
                            if let Some(ref collected) = collected_proof {
                                apply_proof_of_work(frontmatter, collected);
                            }
                            state_machine::on_session_complete(frontmatter)
                        }
                        AgentSessionStatus::Failed => state_machine::on_session_failed(
                            frontmatter,
                            &session_id_owned,
                            "Session failed",
                        ),
                        _ => {
                            state_machine::cancel(frontmatter);
                            state_machine::TransitionResult::Completed
                        }
                    }
                },
            )
        };

        if let Some(ref slug) = db_project_slug {
            tracing::debug!(
                "[orchestrator] Applying transition with slug='{}' for work_item={}",
                slug,
                work_item_id
            );
            match apply_transition(slug) {
                Ok(tr) => {
                    tracing::debug!(
                        "[orchestrator] Transition succeeded for work_item={}: {:?}",
                        work_item_id,
                        tr
                    );
                    return Some((tr, slug.clone()));
                }
                Err(err) => {
                    tracing::warn!(
                        "[orchestrator] Failed to transition work item {}: {}",
                        work_item_id,
                        err
                    );
                    return None;
                }
            }
        }

        // Every work-item launch path persists project_slug on the session
        // row (create_session_impl), so a missing slug means the row predates
        // that guarantee or was hand-edited. Surface it instead of falling
        // back to the old O(projects × items) full scan.
        tracing::warn!(
            "[orchestrator] Session for work_item={} has no project_slug; \
             skipping orchestrator transition",
            work_item_id
        );
        None
    })
    .await
    .map_err(|err| {
        tracing::error!("[orchestrator] spawn_blocking join error: {}", err);
        err.to_string()
    })?;

    tracing::debug!(
        "[orchestrator] transition_result={:?} for session {}",
        transition_result,
        session_id
    );

    if let Some((ref tr, ref transition_slug)) = transition_result {
        if let Some(handle) = app_handle {
            use project_management::orchestrator::state_machine::TransitionResult;
            use tauri::Emitter;
            let ts = chrono::Utc::now().to_rfc3339();
            let _ = handle.emit(
                project_management::projects::events::DATA_CHANGED_EVENT,
                &ts,
            );

            match tr {
                TransitionResult::Completed | TransitionResult::Failed => {
                    // Work-item learning pipeline removed. Learnings are now
                    // extracted exclusively through the
                    // agent session's post-session reflection path
                    // (see agent_core/core/session/reflection.rs), gated by
                    // the per-agent `learnings.enabled` switch.

                    // Close the routine fire driving this work item, if any
                    // (CreateWorkItem auto_start / UpdateExistingWorkItem).
                    notify_routine_fire_work_item_terminal(
                        handle,
                        &work_item_id_for_launch,
                        matches!(tr, TransitionResult::Completed),
                    )
                    .await;
                }
                TransitionResult::RetryAgent => {
                    spawn_phase_launch(
                        handle,
                        transition_slug,
                        &work_item_id_for_launch,
                        crate::tool_infra::PhaseLaunch::Retry,
                    );
                }
                TransitionResult::Ignored => {
                    // Stale terminal from a session that lost the claim —
                    // already logged inside the mutator; no follow-on.
                }
            }
        }
    }

    Ok(())
}

/// Spawn the next orchestrator session (review / fix / retry) in a detached
/// task. Spawned, not awaited: the launched session's own terminal path
/// re-enters `notify_orchestrator_session_terminal`, so awaiting here would
/// make the async call graph recursive (E0391 opaque-type cycle).
fn spawn_phase_launch(
    app: &tauri::AppHandle,
    project_slug: &str,
    work_item_id: &str,
    phase: crate::tool_infra::PhaseLaunch,
) {
    let app = app.clone();
    let slug = project_slug.to_string();
    let wid = work_item_id.to_string();
    // Boxed for the same E0391 reason as the dequeue path above.
    let fut: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
        Box::pin(async move {
            match crate::tool_infra::launch_phase_session(&slug, &wid, &app, phase).await {
                Ok(session) => tracing::info!(
                    "[orchestrator] {:?} session {} launched for {}",
                    phase,
                    session,
                    wid
                ),
                Err(err) => {
                    tracing::warn!(
                        "[orchestrator] {:?} launch failed for {}: {}",
                        phase,
                        wid,
                        err
                    );
                    notify_inbox_phase_launch_failed(&wid, phase, &err);
                }
            }
        });
    tauri::async_runtime::spawn(fut);
}

/// Inbox notification for a failed automatic phase launch — without it an
/// unattended pipeline would stall silently in Review/Coding phase.
fn notify_inbox_phase_launch_failed(
    work_item_id: &str,
    phase: crate::tool_infra::PhaseLaunch,
    reason: &str,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let msg = inbox::persistence::InboxMessage {
        id: format!(
            "orchestrator-launch-failed-{}-{}",
            work_item_id,
            chrono::Utc::now().timestamp()
        ),
        title: format!(
            "[Orchestration Blocked] {:?} launch failed for {}",
            phase, work_item_id
        ),
        preview: format!(
            "Reason: {}",
            crate::utils::safe_truncate_chars_to_string(&reason, 100)
        ),
        content: format!(
            "Work item {} could not launch its {:?} session automatically.\n\n\
             **Reason:** {}\n\n\
             **Action needed:** open the work item and retry, or fix the configuration.",
            work_item_id, phase, reason
        ),
        category: "workitems".to_string(),
        priority: "high".to_string(),
        status: "unread".to_string(),
        sender_name: Some("Orchestrator".to_string()),
        metadata: "{}".to_string(),
        labels: serde_json::to_string(&["orchestration-blocked"])
            .expect("serializing a static [&str] is infallible"),
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(err) = inbox::persistence::upsert_message(&msg) {
        tracing::warn!(
            "[orchestrator] Failed to write launch-failed inbox notification for {}: {}",
            work_item_id,
            err
        );
    }
}

/// Close the routine fire that drives `work_item_id` (if any) when the
/// orchestrator reaches a terminal phase.
async fn notify_routine_fire_work_item_terminal(
    app: &tauri::AppHandle,
    work_item_id: &str,
    succeeded: bool,
) {
    let wid = work_item_id.to_string();
    let fire = match tokio::task::spawn_blocking(move || {
        project_management::projects::io::find_started_fire_by_work_item(&wid)
    })
    .await
    {
        Ok(Ok(Some(fire))) => fire,
        Ok(Ok(None)) => return,
        Ok(Err(err)) => {
            tracing::warn!(
                "[routine] work-item fire lookup failed for {}: {}",
                work_item_id,
                err
            );
            return;
        }
        Err(err) => {
            tracing::warn!("[routine] work-item fire lookup join error: {}", err);
            return;
        }
    };

    let fire_id = fire.id.clone();
    let result = tokio::task::spawn_blocking(move || {
        if succeeded {
            project_management::projects::io::mark_routine_fire_succeeded(&fire_id)
        } else {
            project_management::projects::io::mark_routine_fire_failed(
                &fire_id,
                "Work item orchestration failed",
            )
        }
    })
    .await;
    if let Ok(Ok(updated)) = result {
        crate::state::commands::routines::emit_routine_changed(
            app,
            &updated.routine_id,
            Some(&updated.id),
            if succeeded { "succeeded" } else { "failed" },
        );
        dequeue_next_routine_fire(app, &fire.routine_id).await;
    }
}

mod handlers;
use handlers::{apply_proof_of_work, collect_proof_of_work_data_bounded};

