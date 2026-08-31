use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::command;

use super::super::issues::{parse_issue_user, IssueUser};
use super::super::shared::make_client;
use super::pagination::get_paginated_array;

/// A submitted PR review (Approve / Request-changes / Comment). Mirrors
/// `GET /repos/{repo}/pulls/{n}/reviews` rows.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubPrReview {
    pub id: u64,
    pub user: IssueUser,
    pub body: String,
    /// APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
    pub state: String,
    pub submitted_at: Option<String>,
    pub commit_id: Option<String>,
    pub html_url: String,
}

fn parse_pr_review(v: &Value) -> GitHubPrReview {
    GitHubPrReview {
        id: v["id"].as_u64().unwrap_or(0),
        user: parse_issue_user(&v["user"]),
        body: v["body"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("COMMENTED").to_string(),
        submitted_at: v["submitted_at"].as_str().map(String::from),
        commit_id: v["commit_id"].as_str().map(String::from),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
    }
}

/// An inline review comment anchored to a file + line in the diff. Mirrors
/// `GET /repos/{repo}/pulls/{n}/comments` rows. `line`/`side` place the
/// thread on the post-image (RIGHT) or pre-image (LEFT); `in_reply_to_id`
/// links replies into a thread.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubReviewComment {
    pub id: u64,
    pub body: String,
    pub user: IssueUser,
    pub path: String,
    pub side: Option<String>,
    pub line: Option<u64>,
    pub original_line: Option<u64>,
    pub start_line: Option<u64>,
    pub start_side: Option<String>,
    pub commit_id: String,
    pub diff_hunk: String,
    pub in_reply_to_id: Option<u64>,
    pub pull_request_review_id: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

pub(crate) fn parse_review_comment(v: &Value) -> GitHubReviewComment {
    GitHubReviewComment {
        id: v["id"].as_u64().unwrap_or(0),
        body: v["body"].as_str().unwrap_or("").to_string(),
        user: parse_issue_user(&v["user"]),
        path: v["path"].as_str().unwrap_or("").to_string(),
        side: v["side"].as_str().map(String::from),
        line: v["line"].as_u64(),
        original_line: v["original_line"].as_u64(),
        start_line: v["start_line"].as_u64(),
        start_side: v["start_side"].as_str().map(String::from),
        commit_id: v["commit_id"].as_str().unwrap_or("").to_string(),
        diff_hunk: v["diff_hunk"].as_str().unwrap_or("").to_string(),
        in_reply_to_id: v["in_reply_to_id"].as_u64(),
        pull_request_review_id: v["pull_request_review_id"].as_u64(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
    }
}

#[command]
pub async fn github_list_pr_reviews(
    repo_full_name: String,
    pr_number: u64,
) -> Result<Vec<GitHubPrReview>, String> {
    log::info!("[GitHub][Cmd] list_pr_reviews repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    let result = get_paginated_array(
        &client,
        &format!("/repos/{repo_full_name}/pulls/{pr_number}/reviews"),
    )
    .await?;
    Ok(result.iter().map(parse_pr_review).collect())
}

#[command]
pub async fn github_list_pr_review_comments(
    repo_full_name: String,
    pr_number: u64,
) -> Result<Vec<GitHubReviewComment>, String> {
    log::info!("[GitHub][Cmd] list_pr_review_comments repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    let result = get_paginated_array(
        &client,
        &format!("/repos/{repo_full_name}/pulls/{pr_number}/comments"),
    )
    .await?;
    Ok(result.iter().map(parse_review_comment).collect())
}

/// Submit a PR review. `event` is APPROVE | REQUEST_CHANGES | COMMENT.
/// GitHub requires a non-empty `body` for REQUEST_CHANGES and COMMENT.
#[command]
pub async fn github_create_pr_review(
    repo_full_name: String,
    pr_number: u64,
    event: String,
    body: Option<String>,
    commit_id: Option<String>,
) -> Result<GitHubPrReview, String> {
    log::info!("[GitHub][Cmd] create_pr_review repo={repo_full_name} pr={pr_number} event={event}");
    let client = make_client()?;
    let mut payload = json!({ "event": event });
    if let Some(body) = body {
        payload["body"] = json!(body);
    }
    if let Some(commit_id) = commit_id {
        payload["commit_id"] = json!(commit_id);
    }
    let result = client
        .post(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/reviews"),
            payload,
        )
        .await?;
    Ok(parse_pr_review(&result))
}

/// Create a standalone inline review comment on the PR's diff. Anchored by
/// `path` + `line` + `side` (RIGHT = post-image, LEFT = pre-image) against
/// `commit_id` (the PR head SHA). `start_line`/`start_side` make it multi-line.
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn github_create_pr_review_comment(
    repo_full_name: String,
    pr_number: u64,
    body: String,
    commit_id: String,
    path: String,
    line: u64,
    side: Option<String>,
    start_line: Option<u64>,
    start_side: Option<String>,
) -> Result<GitHubReviewComment, String> {
    log::info!(
        "[GitHub][Cmd] create_pr_review_comment repo={repo_full_name} pr={pr_number} path={path} line={line}"
    );
    let client = make_client()?;
    let mut payload = json!({
        "body": body,
        "commit_id": commit_id,
        "path": path,
        "line": line,
        "side": side.unwrap_or_else(|| "RIGHT".to_string()),
    });
    if let Some(start_line) = start_line {
        payload["start_line"] = json!(start_line);
        payload["start_side"] = json!(start_side.unwrap_or_else(|| "RIGHT".to_string()));
    }
    let result = client
        .post(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/comments"),
            payload,
        )
        .await?;
    Ok(parse_review_comment(&result))
}

/// Reply to an existing inline review comment, threading under it.
#[command]
pub async fn github_reply_pr_review_comment(
    repo_full_name: String,
    pr_number: u64,
    comment_id: u64,
    body: String,
) -> Result<GitHubReviewComment, String> {
    log::info!(
        "[GitHub][Cmd] reply_pr_review_comment repo={repo_full_name} pr={pr_number} comment={comment_id}"
    );
    let client = make_client()?;
    let payload = json!({ "body": body });
    let result = client
        .post(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/comments/{comment_id}/replies"),
            payload,
        )
        .await?;
    Ok(parse_review_comment(&result))
}
