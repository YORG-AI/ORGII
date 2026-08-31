use std::collections::HashSet;

use serde_json::{json, Value};
use tauri::command;

use super::super::issues::{parse_issue_user, IssueUser};
use super::super::shared::make_client;

pub(super) fn normalize_reviewer_logins(reviewers: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let normalized = reviewers
        .into_iter()
        .filter_map(|reviewer| {
            let reviewer = reviewer.trim().to_string();
            if reviewer.is_empty() || !seen.insert(reviewer.to_lowercase()) {
                None
            } else {
                Some(reviewer)
            }
        })
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Err("At least one reviewer login is required".to_string());
    }
    Ok(normalized)
}

fn parse_requested_reviewers(value: &Value) -> Vec<IssueUser> {
    value["requested_reviewers"]
        .as_array()
        .or_else(|| value["users"].as_array())
        .map(|reviewers| reviewers.iter().map(parse_issue_user).collect())
        .unwrap_or_default()
}

#[command]
pub async fn github_request_pr_reviewers(
    repo_full_name: String,
    pr_number: u64,
    reviewers: Vec<String>,
) -> Result<Vec<IssueUser>, String> {
    let reviewers = normalize_reviewer_logins(reviewers)?;
    log::info!(
        "[GitHub][Cmd] request_pr_reviewers repo={repo_full_name} pr={pr_number} count={}",
        reviewers.len()
    );
    let client = make_client()?;
    let data = client
        .post(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/requested_reviewers"),
            json!({ "reviewers": reviewers }),
        )
        .await?;
    Ok(parse_requested_reviewers(&data))
}

#[command]
pub async fn github_remove_pr_reviewers(
    repo_full_name: String,
    pr_number: u64,
    reviewers: Vec<String>,
) -> Result<Vec<IssueUser>, String> {
    let reviewers = normalize_reviewer_logins(reviewers)?;
    log::info!(
        "[GitHub][Cmd] remove_pr_reviewers repo={repo_full_name} pr={pr_number} count={}",
        reviewers.len()
    );
    let client = make_client()?;
    let data = client
        .delete_with_body(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/requested_reviewers"),
            json!({ "reviewers": reviewers }),
        )
        .await?;
    Ok(parse_requested_reviewers(&data))
}
