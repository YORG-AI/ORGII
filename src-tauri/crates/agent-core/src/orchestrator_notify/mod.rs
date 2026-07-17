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

        let apply_transition = |slug: &str| -> Result<state_machine::TransitionResult, String> {
            state_machine::mutate_work_item(
                slug,
                &work_item_id,
                |frontmatter| {
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

                    use core_types::workflow::{AgentRole, OrchestratorPhase};
                    let effective_role = agent_role.or_else(|| {
                        let phase = frontmatter
                            .orchestrator_state
                            .as_ref()
                            .map(|s| &s.current_phase);
                        match phase {
                            Some(OrchestratorPhase::Review) => {
                                tracing::debug!(
                                    "[orchestrator] Session {} not in linked_sessions, inferring Review from phase",
                                    session_id_owned
                                );
                                Some(AgentRole::Review)
                            }
                            _ => None,
                        }
                    });

                    match effective_role {
                        Some(AgentRole::Review) => match status {
                            AgentSessionStatus::Completed => {
                                let review_result = extract_review_feedback(
                                    &session_id_owned,
                                );
                                let outcome = review_result
                                    .as_ref()
                                    .map(|rf| rf.outcome.clone())
                                    .unwrap_or(project_management::projects::types::ReviewOutcome::Approved);

                                if let Some(feedback) = review_result {
                                    project_management::orchestrator::proof_of_work::set_review_feedback(
                                        frontmatter,
                                        feedback,
                                    );
                                }

                                state_machine::on_review_complete(frontmatter, &outcome)
                            }
                            AgentSessionStatus::Failed => {
                                state_machine::on_review_failed(
                                    frontmatter,
                                    &session_id_owned,
                                    "Review session failed",
                                )
                            }
                            _ => {
                                state_machine::cancel(frontmatter);
                                state_machine::TransitionResult::Completed
                            }
                        },
                        _ => match status {
                            AgentSessionStatus::Completed => {
                                let diff_repo = worktree_path.as_deref().unwrap_or(&workspace_path);
                                collect_proof_of_work(frontmatter, diff_repo);
                                state_machine::on_session_complete(frontmatter)
                            }
                            AgentSessionStatus::Failed => {
                                state_machine::on_session_failed(
                                    frontmatter,
                                    &session_id_owned,
                                    "Session failed",
                                )
                            }
                            _ => {
                                state_machine::cancel(frontmatter);
                                state_machine::TransitionResult::Completed
                            }
                        },
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
                TransitionResult::LaunchReview => {
                    spawn_phase_launch(
                        handle,
                        transition_slug,
                        &work_item_id_for_launch,
                        crate::tool_infra::PhaseLaunch::Review,
                    );
                }
                TransitionResult::LaunchFix => {
                    spawn_phase_launch(
                        handle,
                        transition_slug,
                        &work_item_id_for_launch,
                        crate::tool_infra::PhaseLaunch::Fix,
                    );
                }
                TransitionResult::RetryAgent => {
                    spawn_phase_launch(
                        handle,
                        transition_slug,
                        &work_item_id_for_launch,
                        crate::tool_infra::PhaseLaunch::Retry,
                    );
                }
                TransitionResult::CreateFollowUp => {
                    // Dead enum value today — the state machine never returns
                    // it. Kept as an explicit no-op so a future producer
                    // fails loudly in review rather than silently here.
                    tracing::warn!(
                        "[orchestrator] CreateFollowUp transition for session {} has no producer",
                        session_id
                    );
                }
                TransitionResult::AwaitingUser => {
                    tracing::debug!("[orchestrator] Session {} awaiting user action", session_id);
                    notify_inbox_awaiting_user(&work_item_id_for_launch);
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

/// Write an inbox notification when a work item needs the user's decision
/// (AwaitingUser) so unattended runs surface instead of silently stalling.
fn notify_inbox_awaiting_user(work_item_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    let msg = inbox::persistence::InboxMessage {
        id: format!(
            "orchestrator-awaiting-{}-{}",
            work_item_id,
            chrono::Utc::now().timestamp()
        ),
        title: format!(
            "[Action Needed] Work item {} awaits your review",
            work_item_id
        ),
        preview: "Orchestration paused: review outcome needs a human decision".to_string(),
        content: format!(
            "Work item {} reached the **awaiting user** state.\n\n\
             The automated review loop could not resolve on its own \
             (changes requested beyond max rounds, or an inconclusive review).\n\n\
             **Action needed:** open the work item and approve, retry, or close it.",
            work_item_id
        ),
        category: "workitems".to_string(),
        priority: "high".to_string(),
        status: "unread".to_string(),
        sender_name: Some("Orchestrator".to_string()),
        metadata: "{}".to_string(),
        labels: serde_json::to_string(&["awaiting-user"])
            .expect("serializing a static [&str] is infallible"),
        created_at: now.clone(),
        updated_at: now,
    };
    if let Err(err) = inbox::persistence::upsert_message(&msg) {
        tracing::warn!(
            "[orchestrator] Failed to write awaiting-user inbox notification for {}: {}",
            work_item_id,
            err
        );
    }
}

mod handlers;
use handlers::{collect_proof_of_work, extract_review_feedback};

#[cfg(test)]
pub(crate) use handlers::{
    extract_first_sentence, parse_file_location, parse_issue_line, parse_structured_review_block,
};

#[cfg(test)]
#[path = "../tests/orchestrator_notify_tests.rs"]
mod tests;
