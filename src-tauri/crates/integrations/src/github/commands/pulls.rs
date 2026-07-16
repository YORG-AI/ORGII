//! Pull request commands: create/find/list, per-PR detail (commits, files),
//! reviews, inline review comments, and CI checks.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::command;

use super::super::client::GitHubClient;
use super::issues::{parse_issue_user, IssueUser};
use super::shared::make_client;

const GITHUB_PAGE_SIZE: usize = 100;

fn paged_path(base_path: &str, page: usize) -> String {
    let separator = if base_path.contains('?') { '&' } else { '?' };
    format!("{base_path}{separator}per_page={GITHUB_PAGE_SIZE}&page={page}")
}

async fn get_paginated_array(client: &GitHubClient, base_path: &str) -> Result<Vec<Value>, String> {
    let mut page = 1;
    let mut items = Vec::new();
    loop {
        let data = client.get_conditional(&paged_path(base_path, page)).await?;
        let page_items = data
            .as_array()
            .ok_or_else(|| format!("GitHub API returned non-array for {base_path}"))?;
        let page_len = page_items.len();
        items.extend(page_items.iter().cloned());
        if page_len < GITHUB_PAGE_SIZE {
            break;
        }
        page += 1;
    }
    Ok(items)
}

async fn get_paginated_field_array(
    client: &GitHubClient,
    base_path: &str,
    field: &str,
) -> Result<Vec<Value>, String> {
    let mut page = 1;
    let mut items = Vec::new();
    loop {
        let data = client.get_conditional(&paged_path(base_path, page)).await?;
        let page_items = data[field]
            .as_array()
            .ok_or_else(|| format!("GitHub API returned missing array field `{field}` for {base_path}"))?;
        let page_len = page_items.len();
        items.extend(page_items.iter().cloned());
        if page_len < GITHUB_PAGE_SIZE {
            break;
        }
        page += 1;
    }
    Ok(items)
}

#[derive(Debug, Deserialize)]
pub struct CreatePRRequest {
    pub repo_full_name: String,
    pub title: String,
    pub head: String,
    pub base: String,
    pub body: Option<String>,
    pub draft: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct PRResponse {
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct FindPRResponse {
    pub number: u64,
    pub url: String,
    pub state: String,
}

#[command]
pub async fn github_create_pr(
    repo_full_name: String,
    title: String,
    head: String,
    base: String,
    body: Option<String>,
    draft: Option<bool>,
) -> Result<PRResponse, String> {
    log::info!("[GitHub][Cmd] create_pr repo={repo_full_name} head={head} base={base}");
    let client = make_client()?;
    let data = client
        .post(
            &format!("/repos/{repo_full_name}/pulls"),
            json!({
                "title": title,
                "head": head,
                "base": base,
                "body": body.unwrap_or_default(),
                "draft": draft.unwrap_or(false)
            }),
        )
        .await?;
    let pr = PRResponse {
        number: data["number"].as_u64().unwrap_or(0),
        url: data["html_url"].as_str().unwrap_or("").to_string(),
    };
    log::info!("[GitHub][Cmd] create_pr done PR #{}", pr.number);
    Ok(pr)
}

#[command]
pub async fn github_find_pull_request(
    repo_full_name: String,
    head_branch: String,
) -> Result<Option<FindPRResponse>, String> {
    log::info!("[GitHub][Cmd] find_pull_request repo={repo_full_name} head={head_branch}");
    let client = make_client()?;
    let owner = repo_full_name
        .split('/')
        .next()
        .ok_or_else(|| format!("Invalid repo name: {repo_full_name}"))?;

    let parse_pr = |data: &Value| -> Option<FindPRResponse> {
        data.as_array()
            .and_then(|items| items.first())
            .map(|item| FindPRResponse {
                number: item["number"].as_u64().unwrap_or(0),
                url: item["html_url"].as_str().unwrap_or("").to_string(),
                state: item["state"].as_str().unwrap_or("open").to_string(),
            })
    };

    let open_data = client
        .get(&format!(
            "/repos/{repo_full_name}/pulls?state=open&head={owner}:{head_branch}&per_page=1"
        ))
        .await?;
    if let Some(pr) = parse_pr(&open_data) {
        log::info!(
            "[GitHub][Cmd] find_pull_request found open PR #{}",
            pr.number
        );
        return Ok(Some(pr));
    }

    let all_data = client
        .get(&format!(
            "/repos/{repo_full_name}/pulls?state=all&head={owner}:{head_branch}&per_page=1"
        ))
        .await?;
    let pr = parse_pr(&all_data);
    log::info!(
        "[GitHub][Cmd] find_pull_request {}",
        match &pr {
            Some(p) => format!("found {} PR #{}", p.state, p.number),
            None => "not found".to_string(),
        }
    );
    Ok(pr)
}

/// Response item for a single PR in `github_list_open_prs`.
#[derive(Debug, Serialize)]
pub struct OpenPRItem {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: String,
    pub head_branch: String,
    pub base_branch: String,
    pub draft: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[command]
pub async fn github_list_open_prs(
    repo_full_name: String,
    per_page: Option<u64>,
) -> Result<Vec<OpenPRItem>, String> {
    let limit = per_page.unwrap_or(30).min(100);
    log::info!("[GitHub][Cmd] list_open_prs repo={repo_full_name} per_page={limit}");
    let client = make_client()?;
    let data = client
        .get_conditional(&format!(
            "/repos/{repo_full_name}/pulls?state=open&sort=updated&direction=desc&per_page={limit}"
        ))
        .await?;
    let items: Vec<OpenPRItem> = data
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|item| OpenPRItem {
                    number: item["number"].as_u64().unwrap_or(0),
                    url: item["html_url"].as_str().unwrap_or("").to_string(),
                    title: item["title"].as_str().unwrap_or("").to_string(),
                    state: item["state"].as_str().unwrap_or("open").to_string(),
                    head_branch: item["head"]["ref"].as_str().unwrap_or("").to_string(),
                    base_branch: item["base"]["ref"].as_str().unwrap_or("").to_string(),
                    draft: item["draft"].as_bool().unwrap_or(false),
                    created_at: item["created_at"].as_str().unwrap_or("").to_string(),
                    updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    log::info!("[GitHub][Cmd] list_open_prs found {} PRs", items.len());
    Ok(items)
}

#[command]
pub async fn github_get_pr(repo_full_name: String, pr_number: u64) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] get_pr repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    let mut detail = client
        .get_conditional(&format!("/repos/{repo_full_name}/pulls/{pr_number}"))
        .await?;

    let base_sha = detail["base"]["sha"].as_str().map(String::from);
    let head_sha = detail["head"]["sha"].as_str().map(String::from);
    if let (Some(base_sha), Some(head_sha)) = (base_sha, head_sha) {
        match client
            .get_conditional(&format!(
                "/repos/{repo_full_name}/compare/{base_sha}...{head_sha}"
            ))
            .await
        {
            Ok(compare) => {
                if let Some(merge_base_sha) = compare["merge_base_commit"]["sha"].as_str() {
                    detail["merge_base_sha"] = json!(merge_base_sha);
                }
            }
            Err(err) if err.contains("GitHubReAuthRequired") => return Err(err),
            Err(err) => {
                log::warn!("[GitHub][Cmd] get_pr compare failed: {err}");
            }
        }
    }

    Ok(detail)
}

#[command]
pub async fn github_list_pr_commits(
    repo_full_name: String,
    pr_number: u64,
) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] list_pr_commits repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    Ok(Value::Array(
        get_paginated_array(&client, &format!("/repos/{repo_full_name}/pulls/{pr_number}/commits"))
            .await?,
    ))
}

#[command]
pub async fn github_list_pr_files(repo_full_name: String, pr_number: u64) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] list_pr_files repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    Ok(Value::Array(
        get_paginated_array(&client, &format!("/repos/{repo_full_name}/pulls/{pr_number}/files"))
            .await?,
    ))
}

// ============================================
// Reviews, review comments, checks
// ============================================

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
            Some("failure") | Some("timed_out") | Some("action_required")
            | Some("cancelled") | Some("startup_failure") => return "failure".to_string(),
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

#[command]
pub async fn github_list_pr_reviews(
    repo_full_name: String,
    pr_number: u64,
) -> Result<Vec<GitHubPrReview>, String> {
    log::info!("[GitHub][Cmd] list_pr_reviews repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    let result =
        get_paginated_array(&client, &format!("/repos/{repo_full_name}/pulls/{pr_number}/reviews"))
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
    let result =
        get_paginated_array(&client, &format!("/repos/{repo_full_name}/pulls/{pr_number}/comments"))
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
        .get_conditional(&format!(
            "/repos/{repo_full_name}/commits/{git_ref}/status"
        ))
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
