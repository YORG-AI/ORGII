//! Tauri commands for the work item orchestrator.

use tauri::Emitter;

use crate::projects::events::DATA_CHANGED_EVENT;
use crate::projects::io as projects_io;
use crate::projects::types::PrStatus;

use super::proof_of_work;

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
