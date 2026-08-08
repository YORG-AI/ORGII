//! Tauri commands for the work item orchestrator.

use serde::Serialize;
use tauri::Emitter;

use crate::projects::events::DATA_CHANGED_EVENT;
use crate::projects::io as projects_io;
use crate::projects::io::repo_resolver;
use crate::projects::types::{
    AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType, OrchestratorPhase, PrStatus,
};

use super::branch_health;
use super::proof_of_work;
use super::state_machine;
use crate::projects::io::orchestrator_view;
use core_types::session::PENDING_SESSION_PLACEHOLDER;

fn emit_data_changed(app: &tauri::AppHandle, project_slug: &str, work_item_id: &str) {
    let _ = app.emit(
        DATA_CHANGED_EVENT,
        serde_json::json!({
            "project_slug": project_slug,
            "work_item_id": work_item_id,
            "source": "orchestrator",
        }),
    );
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStatus {
    pub current_phase: String,
    pub retry_count: u32,
    pub interrupted: bool,
    pub has_active_config: bool,
}

/// Start the orchestrator workflow: snapshot config → launch SDE session.
///
/// Returns the session ID that should be launched.
#[tauri::command]
pub async fn orchestrator_start(
    project_slug: String,
    work_item_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let event_project_slug = project_slug.clone();
    let result = tokio::task::spawn_blocking(move || {
        projects_io::update_work_item_atomic(
            &project_slug,
            &work_item_id,
            |frontmatter, _body| {
                let current_phase = frontmatter
                    .orchestrator_state
                    .as_ref()
                    .map(|s| &s.current_phase)
                    .unwrap_or(&OrchestratorPhase::Idle);

                if !matches!(
                    current_phase,
                    OrchestratorPhase::Idle | OrchestratorPhase::Completed
                ) {
                    return Err(format!(
                        "Cannot start: orchestrator is in phase '{:?}', expected idle or completed",
                        current_phase
                    ));
                }

                let now = chrono::Utc::now().to_rfc3339();
                for linked_session in &mut frontmatter.linked_sessions {
                    if linked_session.status == LinkedSessionStatus::Running {
                        linked_session.status = LinkedSessionStatus::Completed;
                        linked_session.completed_at = Some(now.clone());
                    }
                }

                frontmatter.execution_lock = None;
                state_machine::snapshot_config(frontmatter);
                state_machine::add_linked_session(
                    frontmatter,
                    PENDING_SESSION_PLACEHOLDER,
                    AgentRole::Coding,
                    LinkedSessionType::Native,
                );

                frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
                Ok::<(), String>(())
            },
        )?;

        Ok::<String, String>(work_item_id)
    })
    .await
    .map_err(|err| err.to_string())??;

    emit_data_changed(&app, &event_project_slug, &result);
    Ok(result)
}

/// Cancel the active orchestrator workflow.
#[tauri::command]
pub async fn orchestrator_cancel(
    project_slug: String,
    work_item_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let event_project_slug = project_slug.clone();
    let event_work_item_id = work_item_id.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        state_machine::mutate_work_item(&project_slug, &work_item_id, |frontmatter| {
            state_machine::cancel(frontmatter);
            state_machine::TransitionResult::Completed
        })?;
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())??;

    emit_data_changed(&app, &event_project_slug, &event_work_item_id);
    Ok(())
}

/// Retry the SDE phase after a failure. Performs branch health check first.
#[tauri::command]
pub async fn orchestrator_retry(
    project_slug: String,
    work_item_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let event_project_slug = project_slug.clone();
    let event_work_item_id = work_item_id.clone();
    tokio::task::spawn_blocking(move || {
        let state = orchestrator_view::read_orchestrator_state(&project_slug, &work_item_id)?
            .ok_or("No orchestrator state")?;

        if !matches!(
            state.current_phase,
            OrchestratorPhase::Failed | OrchestratorPhase::AwaitingUser
        ) {
            return Err(format!(
                "Cannot retry: orchestrator is in phase '{:?}', expected failed or awaiting_user",
                state.current_phase
            ));
        }

        // Branch health check still needs the on-disk repo (proof_of_work
        // records the branch name; we run `git` against the bound checkout).
        let data = projects_io::read_work_item(&project_slug, &work_item_id)?;
        if let Some(ref pow) = data.frontmatter.proof_of_work {
            if let Some(ref branch) = pow.branch {
                let repo_path =
                    repo_resolver::resolve_repo_for_work_item(&project_slug, &work_item_id)?;
                let health = branch_health::check_branch_health(&repo_path, branch);
                if !health.is_healthy() {
                    return Err(format!("Branch health check failed: {}", health.details));
                }
            }
        }

        state_machine::mutate_work_item(&project_slug, &work_item_id, |fm| {
            state_machine::snapshot_config(fm);
            state_machine::add_linked_session(
                fm,
                PENDING_SESSION_PLACEHOLDER,
                AgentRole::Coding,
                LinkedSessionType::Native,
            );
            state_machine::TransitionResult::RetryAgent
        })?;

        Ok(())
    })
    .await
    .map_err(|err| err.to_string())??;

    emit_data_changed(&app, &event_project_slug, &event_work_item_id);
    Ok(())
}

/// Get the current orchestrator status for a work item.
///
/// Reads `orchestrator_state` out of `workitem_extras.extras_json` —
/// the same blob `update_work_item_atomic` writes during every
/// transition. No parallel mirror; this is the single source of
/// truth.
#[tauri::command]
pub async fn orchestrator_get_status(
    project_slug: String,
    work_item_id: String,
) -> Result<OrchestratorStatus, String> {
    tokio::task::spawn_blocking(move || {
        let state = orchestrator_view::read_orchestrator_state(&project_slug, &work_item_id)?;

        Ok(match state {
            Some(state) => OrchestratorStatus {
                current_phase: format!("{:?}", state.current_phase).to_lowercase(),
                retry_count: state.retry_count,
                interrupted: state.interrupted,
                has_active_config: state.active_config.is_some(),
            },
            None => OrchestratorStatus {
                current_phase: "idle".to_string(),
                retry_count: 0,
                interrupted: false,
                has_active_config: false,
            },
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// List all linked sessions for a work item, sorted by start order.
///
/// Reads `linked_sessions` out of `workitem_extras.extras_json` —
/// every state-machine transition that pushes / mutates a session
/// also rewrites this vec atomically inside `update_work_item_atomic`.
#[tauri::command]
pub async fn orchestrator_list_sessions(
    project_slug: String,
    work_item_id: String,
) -> Result<Vec<LinkedSession>, String> {
    tokio::task::spawn_blocking(move || {
        orchestrator_view::read_linked_sessions(&project_slug, &work_item_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Create a follow-up work item from review feedback.
/// Returns the new work item's short ID.
#[tauri::command]
pub async fn orchestrator_create_follow_up(
    project_slug: String,
    parent_short_id: String,
    review_feedback: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let event_project_slug = project_slug.clone();
    let event_parent_short_id = parent_short_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        super::follow_up::create_follow_up(&project_slug, &parent_short_id, &review_feedback)
    })
    .await
    .map_err(|err| err.to_string())??;

    emit_data_changed(&app, &event_project_slug, &event_parent_short_id);
    Ok(result)
}

/// Get all interrupted work items for recovery UI.
#[tauri::command]
pub async fn orchestrator_get_interrupted_items(
) -> Result<Vec<super::recovery::InterruptedItem>, String> {
    tokio::task::spawn_blocking(super::recovery::scan_interrupted_items)
        .await
        .map_err(|err| err.to_string())?
}

/// Get cumulative diff stats between a base branch and a work item branch.
///
/// Used for live file change polling during SDE runs and for the final
/// changed files list in the work item detail view.
#[tauri::command]
pub async fn orchestrator_get_diff_stats(
    repo_path: String,
    base_branch: String,
    work_item_branch: String,
) -> Result<crate::projects::types::WorkItemDiffStats, String> {
    tokio::task::spawn_blocking(move || {
        super::diff_stats::compute_diff_stats(&repo_path, &base_branch, &work_item_branch)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Persist a PR URL and status into a work item's proof of work.
///
/// Called by the frontend after successfully creating a PR via the GitHub API.
#[tauri::command]
pub async fn orchestrator_set_pr(
    project_slug: String,
    work_item_id: String,
    pr_url: String,
    pr_status: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let event_project_slug = project_slug.clone();
    let event_work_item_id = work_item_id.clone();
    tokio::task::spawn_blocking(move || {
        let status = match pr_status.as_str() {
            "open" => PrStatus::Open,
            "draft" => PrStatus::Draft,
            "merged" => PrStatus::Merged,
            "closed" => PrStatus::Closed,
            other => return Err(format!("Unknown PR status: {}", other)),
        };

        projects_io::update_work_item_atomic(&project_slug, &work_item_id, |frontmatter, _body| {
            proof_of_work::set_pr(frontmatter, &pr_url, status);
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })
    })
    .await
    .map_err(|err| err.to_string())??;

    emit_data_changed(&app, &event_project_slug, &event_work_item_id);
    Ok(())
}
