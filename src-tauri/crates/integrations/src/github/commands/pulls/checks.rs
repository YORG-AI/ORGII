use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::command;

use super::super::shared::make_client;
use super::pagination::get_paginated_field_array;

/// A single CI check run. Mirrors `GET /repos/{repo}/commits/{ref}/check-runs`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubCheckRun {
    pub id: u64,
    pub name: String,
    /// queued | in_progress | completed
    pub status: String,
    /// success | failure | neutral | cancelled | timed_out | action_required | skipped | stale
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub output_title: Option<String>,
    pub app_name: Option<String>,
}

pub(crate) fn parse_check_run(v: &Value) -> GitHubCheckRun {
    GitHubCheckRun {
        id: v["id"].as_u64().unwrap_or(0),
        name: v["name"].as_str().unwrap_or("").to_string(),
        status: v["status"].as_str().unwrap_or("completed").to_string(),
        conclusion: v["conclusion"].as_str().map(String::from),
        details_url: v["details_url"].as_str().map(String::from),
        started_at: v["started_at"].as_str().map(String::from),
        completed_at: v["completed_at"].as_str().map(String::from),
        output_title: v["output"]["title"].as_str().map(String::from),
        app_name: v["app"]["name"].as_str().map(String::from),
    }
}

/// A legacy commit-status context (Travis-era statuses, still used by some
/// integrations). Mirrors entries in `GET /repos/{repo}/commits/{ref}/status`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubStatusContext {
    pub context: String,
    /// success | pending | failure | error
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
    pub avatar_url: Option<String>,
}

pub(crate) fn parse_status_context(v: &Value) -> GitHubStatusContext {
    GitHubStatusContext {
        context: v["context"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("pending").to_string(),
        description: v["description"].as_str().map(String::from),
        target_url: v["target_url"].as_str().map(String::from),
        avatar_url: v["avatar_url"].as_str().map(String::from),
    }
}

/// Combined checks view for a commit: modern check-runs + legacy statuses,
/// plus a single rolled-up `state` for the header badge.
#[derive(Debug, Serialize)]
pub struct GitHubChecksSummary {
    pub sha: String,
    pub check_runs: Vec<GitHubCheckRun>,
    pub statuses: Vec<GitHubStatusContext>,
    /// success | pending | failure — rolled up across runs + statuses.
    pub state: String,
}

/// Roll up an overall state from check-run conclusions and status states.
/// Any hard failure wins; else anything still running/queued is pending;
/// else success (including the empty case).
pub(crate) fn roll_up_checks_state(
    runs: &[GitHubCheckRun],
    statuses: &[GitHubStatusContext],
) -> String {
    let mut has_pending = false;
    for run in runs {
        if run.status != "completed" {
            has_pending = true;
            continue;
        }
        match run.conclusion.as_deref() {
            Some("failure")
            | Some("timed_out")
            | Some("action_required")
            | Some("cancelled")
            | Some("startup_failure") => return "failure".to_string(),
            None => has_pending = true,
            _ => {}
        }
    }
    for status in statuses {
        match status.state.as_str() {
            "failure" | "error" => return "failure".to_string(),
            "pending" => has_pending = true,
            _ => {}
        }
    }
    if has_pending {
        "pending".to_string()
    } else {
        "success".to_string()
    }
}

/// Combined CI status for a commit `ref` (usually the PR head SHA): modern
/// check-runs plus legacy commit statuses, rolled up into one `state`.
#[command]
pub async fn github_get_checks(
    repo_full_name: String,
    git_ref: String,
) -> Result<GitHubChecksSummary, String> {
    log::info!("[GitHub][Cmd] get_checks repo={repo_full_name} ref={git_ref}");
    let client = make_client()?;

    let check_runs = match get_paginated_field_array(
        &client,
        &format!("/repos/{repo_full_name}/commits/{git_ref}/check-runs"),
        "check_runs",
    )
    .await
    {
        Ok(values) => values.iter().map(parse_check_run).collect(),
        Err(err) if err.contains("GitHubReAuthRequired") => return Err(err),
        // Some repos / refs 404 or 422 for check-runs — treat as "no runs".
        Err(err) => {
            log::warn!("[GitHub][Cmd] get_checks check-runs failed: {err}");
            Vec::new()
        }
    };

    let status_value = match client
        .get_conditional(&format!("/repos/{repo_full_name}/commits/{git_ref}/status"))
        .await
    {
        Ok(value) => value,
        Err(err) if err.contains("GitHubReAuthRequired") => return Err(err),
        Err(err) => {
            log::warn!("[GitHub][Cmd] get_checks status failed: {err}");
            Value::Null
        }
    };
    let statuses: Vec<GitHubStatusContext> = status_value["statuses"]
        .as_array()
        .map(|arr| arr.iter().map(parse_status_context).collect())
        .unwrap_or_default();

    let state = roll_up_checks_state(&check_runs, &statuses);

    Ok(GitHubChecksSummary {
        sha: git_ref,
        check_runs,
        statuses,
        state,
    })
}
