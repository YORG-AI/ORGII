//! GitHub Issues commands: list/get/create/update, comments, labels, and
//! assignable users.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::github::client::GitHubClient;

use super::shared::make_client;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IssueLabel {
    pub id: u64,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IssueUser {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubIssue {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub state_reason: Option<String>,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub user: IssueUser,
    pub labels: Vec<IssueLabel>,
    pub assignees: Vec<IssueUser>,
    pub comments: u64,
    #[serde(default)]
    pub linked_pull_requests_count: u64,
    pub milestone: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubIssueComment {
    pub id: u64,
    pub body: String,
    pub user: IssueUser,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct IssueTimelineLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct IssueTimelineRename {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct IssueTimelineSource {
    pub number: u64,
    pub title: String,
    pub html_url: String,
    pub state: String,
    pub is_pull_request: bool,
}

/// Normalized issue timeline item sent over Tauri IPC.
///
/// GitHub returns a different JSON shape for comments, cross-references, and
/// common issue events. Keeping a stable superset here prevents those remote
/// variants from leaking into the frontend while retaining the details needed
/// to render assignments, labels, milestones, linked PRs, and state changes.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubIssueTimelineItem {
    pub id: Option<u64>,
    pub event: String,
    pub created_at: Option<String>,
    pub actor: Option<IssueUser>,
    pub body: Option<String>,
    pub html_url: Option<String>,
    pub assignee: Option<IssueUser>,
    pub label: Option<IssueTimelineLabel>,
    pub milestone: Option<String>,
    pub rename: Option<IssueTimelineRename>,
    pub source: Option<IssueTimelineSource>,
    pub commit_id: Option<String>,
    pub lock_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitHubIssueListResponse {
    pub issues: Vec<GitHubIssue>,
    pub total_count: u64,
    pub has_more: bool,
    pub next_page: Option<u32>,
}

pub(crate) fn parse_issue_user(v: &Value) -> IssueUser {
    IssueUser {
        login: v["login"].as_str().unwrap_or("").to_string(),
        avatar_url: v["avatar_url"].as_str().unwrap_or("").to_string(),
    }
}

fn parse_issue_label(v: &Value) -> IssueLabel {
    IssueLabel {
        id: v["id"].as_u64().unwrap_or(0),
        name: v["name"].as_str().unwrap_or("").to_string(),
        color: v["color"].as_str().unwrap_or("").to_string(),
        description: v["description"].as_str().map(|s| s.to_string()),
    }
}

fn parse_issue(v: &Value) -> GitHubIssue {
    GitHubIssue {
        id: v["id"].as_u64().unwrap_or(0),
        number: v["number"].as_u64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").to_string(),
        body: v["body"].as_str().map(|s| s.to_string()),
        state: v["state"].as_str().unwrap_or("open").to_string(),
        state_reason: v["state_reason"].as_str().map(|s| s.to_string()),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
        closed_at: v["closed_at"].as_str().map(|s| s.to_string()),
        user: parse_issue_user(&v["user"]),
        labels: v["labels"]
            .as_array()
            .map(|arr| arr.iter().map(parse_issue_label).collect())
            .unwrap_or_default(),
        assignees: v["assignees"]
            .as_array()
            .map(|arr| arr.iter().map(parse_issue_user).collect())
            .unwrap_or_default(),
        comments: v["comments"].as_u64().unwrap_or(0),
        linked_pull_requests_count: 0,
        milestone: v["milestone"]["title"].as_str().map(|s| s.to_string()),
    }
}

#[derive(Default)]
struct UpdateIssueFields {
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    state_reason: Option<String>,
    duplicate_issue_id: Option<u64>,
    labels: Option<Vec<String>>,
}

fn build_update_issue_payload(fields: UpdateIssueFields) -> Value {
    let mut payload = serde_json::json!({});
    if let Some(title) = fields.title {
        payload["title"] = serde_json::json!(title);
    }
    if let Some(body) = fields.body {
        payload["body"] = serde_json::json!(body);
    }
    if let Some(state) = fields.state {
        payload["state"] = serde_json::json!(state);
    }
    if let Some(state_reason) = fields.state_reason {
        payload["state_reason"] = serde_json::json!(state_reason);
    }
    if let Some(duplicate_issue_id) = fields.duplicate_issue_id {
        payload["duplicate_issue_id"] = serde_json::json!(duplicate_issue_id);
    }
    if let Some(labels) = fields.labels {
        payload["labels"] = serde_json::json!(labels);
    }
    payload
}

fn normalize_assignee_logins(logins: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    logins
        .into_iter()
        .filter_map(|login| {
            let login = login.trim();
            if login.is_empty() || !seen.insert(login.to_lowercase()) {
                return None;
            }
            Some(login.to_string())
        })
        .collect()
}

fn issue_assignee_logins(issue: &Value) -> Vec<String> {
    issue["assignees"]
        .as_array()
        .map(|assignees| {
            assignees
                .iter()
                .filter_map(|assignee| assignee["login"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn assignee_login_keys(logins: &[String]) -> HashSet<String> {
    logins.iter().map(|login| login.to_lowercase()).collect()
}

fn assignee_login_sets_match(left: &[String], right: &[String]) -> bool {
    assignee_login_keys(left) == assignee_login_keys(right)
}

async fn set_issue_assignees(
    client: &GitHubClient,
    issue_path: &str,
    current_issue: Value,
    desired_logins: Vec<String>,
) -> Result<Value, String> {
    let desired_logins = normalize_assignee_logins(desired_logins);
    let desired_keys = assignee_login_keys(&desired_logins);
    let current_logins = issue_assignee_logins(&current_issue);
    let current_keys = assignee_login_keys(&current_logins);
    let additions = desired_logins
        .iter()
        .filter(|login| !current_keys.contains(&login.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();

    let assignees_path = format!("{issue_path}/assignees");
    let mut result = current_issue;
    if !additions.is_empty() {
        result = client
            .post(
                &assignees_path,
                serde_json::json!({ "assignees": additions }),
            )
            .await?;

        let added_logins = issue_assignee_logins(&result);
        let added_keys = assignee_login_keys(&added_logins);
        let missing = desired_logins
            .iter()
            .filter(|login| !added_keys.contains(&login.to_lowercase()))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!(
                "GitHub did not apply the requested assignee addition(s): {}",
                missing.join(", ")
            ));
        }
    }

    let applied_logins = issue_assignee_logins(&result);
    let removals = applied_logins
        .iter()
        .filter(|login| !desired_keys.contains(&login.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    if !removals.is_empty() {
        result = client
            .delete_with_body(
                &assignees_path,
                serde_json::json!({ "assignees": removals }),
            )
            .await?;
    }

    let returned_logins = issue_assignee_logins(&result);
    if !assignee_login_sets_match(&returned_logins, &desired_logins) {
        return Err(format!(
            "GitHub did not apply the exact assignee change (requested: [{}], returned: [{}])",
            desired_logins.join(", "),
            returned_logins.join(", ")
        ));
    }

    log::info!(
        "[GitHub][Cmd] set_issue_assignees requested={} returned={}",
        desired_logins.len(),
        returned_logins.len()
    );
    Ok(result)
}

fn linked_pull_requests_query(issues: &[GitHubIssue]) -> String {
    let issue_fields = issues
        .iter()
        .map(|issue| {
            format!(
                "issue_{}: issue(number: {}) {{ closedByPullRequestsReferences(first: 1, includeClosedPrs: true) {{ totalCount }} }}",
                issue.number, issue.number
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ {issue_fields} }} }}"
    )
}

fn apply_linked_pull_request_counts(issues: &mut [GitHubIssue], response: &Value) {
    let repository = &response["data"]["repository"];
    for issue in issues {
        issue.linked_pull_requests_count = repository[format!("issue_{}", issue.number)]
            ["closedByPullRequestsReferences"]["totalCount"]
            .as_u64()
            .unwrap_or(0);
    }
}

async fn enrich_linked_pull_request_counts(
    client: &GitHubClient,
    repo_full_name: &str,
    issues: &mut [GitHubIssue],
) {
    if issues.is_empty() {
        return;
    }
    let Some((owner, name)) = repo_full_name.split_once('/') else {
        log::warn!("[GitHub][Cmd] cannot resolve linked PRs for malformed repo {repo_full_name}");
        return;
    };
    let variables = serde_json::json!({ "owner": owner, "name": name });
    match client
        .graphql(&linked_pull_requests_query(issues), variables)
        .await
    {
        Ok(response) => {
            if response["errors"].is_array() {
                log::warn!(
                    "[GitHub][Cmd] linked PR GraphQL query returned errors for {repo_full_name}"
                );
            }
            apply_linked_pull_request_counts(issues, &response);
        }
        Err(error) => {
            log::warn!("[GitHub][Cmd] linked PR enrichment failed for {repo_full_name}: {error}");
        }
    }
}

fn parse_issue_comment(v: &Value) -> GitHubIssueComment {
    GitHubIssueComment {
        id: v["id"].as_u64().unwrap_or(0),
        body: v["body"].as_str().unwrap_or("").to_string(),
        user: parse_issue_user(&v["user"]),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
    }
}

fn parse_optional_issue_user(v: &Value) -> Option<IssueUser> {
    v.as_object()
        .filter(|_| v["login"].as_str().is_some())
        .map(|_| parse_issue_user(v))
}

fn parse_issue_timeline_item(v: &Value) -> GitHubIssueTimelineItem {
    let source_issue = &v["source"]["issue"];
    let source = source_issue.as_object().and_then(|_| {
        Some(IssueTimelineSource {
            number: source_issue["number"].as_u64()?,
            title: source_issue["title"].as_str()?.to_string(),
            html_url: source_issue["html_url"].as_str()?.to_string(),
            state: source_issue["state"].as_str()?.to_string(),
            is_pull_request: source_issue["pull_request"].is_object(),
        })
    });

    GitHubIssueTimelineItem {
        id: v["id"].as_u64(),
        event: v["event"].as_str().unwrap_or("unknown").to_string(),
        created_at: v["created_at"]
            .as_str()
            .or_else(|| v["submitted_at"].as_str())
            .or_else(|| v["author"]["date"].as_str())
            .map(str::to_string),
        actor: parse_optional_issue_user(&v["actor"])
            .or_else(|| parse_optional_issue_user(&v["user"])),
        body: v["body"].as_str().map(str::to_string),
        html_url: v["html_url"].as_str().map(str::to_string),
        assignee: parse_optional_issue_user(&v["assignee"]),
        label: v["label"].as_object().and_then(|_| {
            Some(IssueTimelineLabel {
                name: v["label"]["name"].as_str()?.to_string(),
                color: v["label"]["color"].as_str().unwrap_or("").to_string(),
            })
        }),
        milestone: v["milestone"]["title"].as_str().map(str::to_string),
        rename: v["rename"].as_object().and_then(|_| {
            Some(IssueTimelineRename {
                from: v["rename"]["from"].as_str()?.to_string(),
                to: v["rename"]["to"].as_str()?.to_string(),
            })
        }),
        source,
        commit_id: v["commit_id"]
            .as_str()
            .or_else(|| v["sha"].as_str())
            .map(str::to_string),
        lock_reason: v["lock_reason"].as_str().map(str::to_string),
    }
}

/// Max raw API pages fetched per call. The `/issues` endpoint mixes PRs into
/// the results, so a single raw page may contain few (or zero) real issues in
/// PR-heavy repos; we keep paging until enough issues accumulate or this cap.
const ISSUES_MAX_RAW_PAGES: u32 = 10;
/// Maximum raw items requested per API page (GitHub max).
const ISSUES_MAX_RAW_PER_PAGE: u32 = 100;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn github_list_issues(
    repo_full_name: String,
    state: Option<String>,
    labels: Option<String>,
    assignee: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    include_linked_pull_requests: Option<bool>,
) -> Result<GitHubIssueListResponse, String> {
    log::info!("[GitHub][Cmd] list_issues repo={repo_full_name} state={state:?}");
    let client = make_client()?;
    // `per_page` is the number of *issues* the caller wants. The GitHub
    // endpoint returns PRs too, so we may scan several raw pages to collect it.
    let wanted = per_page.unwrap_or(100).clamp(1, ISSUES_MAX_RAW_PER_PAGE) as usize;
    let raw_per_page = wanted as u32;
    let start_raw_page = page.unwrap_or(1);
    let state_str = state.as_deref().unwrap_or("open");

    let mut issues: Vec<GitHubIssue> = Vec::new();
    let mut has_more = false;
    let mut next_page: Option<u32> = None;

    for raw_page in start_raw_page..start_raw_page + ISSUES_MAX_RAW_PAGES {
        let mut url = format!(
            "/repos/{repo_full_name}/issues?state={state_str}&per_page={raw_per_page}&page={raw_page}"
        );
        if let Some(l) = &labels {
            url.push_str(&format!("&labels={l}"));
        }
        if let Some(a) = &assignee {
            url.push_str(&format!("&assignee={a}"));
        }
        let result = client.get(&url).await.map_err(|e| e.to_string())?;
        let raw_items = result
            .as_array()
            .ok_or_else(|| "GitHub issue timeline response was not an array".to_string())?;
        let raw_count = raw_items.len();

        issues.extend(
            raw_items
                .iter()
                .filter(|v| v["pull_request"].is_null())
                .map(parse_issue),
        );

        let page_exhausted = raw_count < raw_per_page as usize;
        if page_exhausted {
            has_more = false;
            next_page = None;
            break;
        }
        has_more = true;
        next_page = Some(raw_page + 1);
        if issues.len() >= wanted {
            break;
        }
    }

    log::info!(
        "[GitHub][Cmd] list_issues returned {} issues (has_more={has_more})",
        issues.len()
    );
    if include_linked_pull_requests.unwrap_or(true) {
        enrich_linked_pull_request_counts(&client, &repo_full_name, &mut issues).await;
    }
    Ok(GitHubIssueListResponse {
        total_count: issues.len() as u64,
        issues,
        has_more,
        next_page,
    })
}

#[tauri::command]
pub async fn github_get_issue(
    repo_full_name: String,
    issue_number: u64,
) -> Result<GitHubIssue, String> {
    log::info!("[GitHub][Cmd] get_issue repo={repo_full_name} issue={issue_number}");
    let client = make_client()?;
    let result = client
        .get(&format!("/repos/{repo_full_name}/issues/{issue_number}"))
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_issue(&result))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn github_create_issue(
    repo_full_name: String,
    title: String,
    body: Option<String>,
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
) -> Result<GitHubIssue, String> {
    log::info!("[GitHub][Cmd] create_issue repo={repo_full_name} title={title}");
    let client = make_client()?;
    let mut payload = serde_json::json!({ "title": title });
    if let Some(b) = body {
        payload["body"] = serde_json::json!(b);
    }
    if let Some(l) = labels {
        payload["labels"] = serde_json::json!(l);
    }
    if let Some(a) = assignees {
        payload["assignees"] = serde_json::json!(a);
    }
    let result = client
        .post(&format!("/repos/{repo_full_name}/issues"), payload)
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_issue(&result))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn github_update_issue(
    repo_full_name: String,
    issue_number: u64,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    state_reason: Option<String>,
    duplicate_issue_id: Option<u64>,
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
) -> Result<GitHubIssue, String> {
    log::info!("[GitHub][Cmd] update_issue repo={repo_full_name} issue={issue_number}");
    let client = make_client()?;
    let issue_path = format!("/repos/{repo_full_name}/issues/{issue_number}");
    let payload = build_update_issue_payload(UpdateIssueFields {
        title,
        body,
        state,
        state_reason,
        duplicate_issue_id,
        labels,
    });
    let mut result = if payload.as_object().is_some_and(|fields| fields.is_empty()) {
        client.get(&issue_path).await?
    } else {
        client.patch(&issue_path, payload).await?
    };
    if let Some(assignees) = assignees {
        result = set_issue_assignees(&client, &issue_path, result, assignees).await?;
    }
    Ok(parse_issue(&result))
}

#[tauri::command]
pub async fn github_list_issue_comments(
    repo_full_name: String,
    issue_number: u64,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<Vec<GitHubIssueComment>, String> {
    log::info!("[GitHub][Cmd] list_issue_comments repo={repo_full_name} issue={issue_number}");
    let client = make_client()?;
    let per_page = per_page.unwrap_or(50);
    let page = page.unwrap_or(1);
    let result = client
        .get(&format!(
            "/repos/{repo_full_name}/issues/{issue_number}/comments?per_page={per_page}&page={page}"
        ))
        .await
        .map_err(|e| e.to_string())?;
    Ok(result
        .as_array()
        .map(|arr| arr.iter().map(parse_issue_comment).collect())
        .unwrap_or_default())
}

const ISSUE_TIMELINE_PAGE_SIZE: usize = 100;

#[tauri::command]
pub async fn github_list_issue_timeline(
    repo_full_name: String,
    issue_number: u64,
) -> Result<Vec<GitHubIssueTimelineItem>, String> {
    log::info!("[GitHub][Cmd] list_issue_timeline repo={repo_full_name} issue={issue_number}");
    let client = make_client()?;
    let mut timeline = Vec::new();
    let mut page = 1_u32;

    loop {
        let result = client
            .get_conditional(&format!(
                "/repos/{repo_full_name}/issues/{issue_number}/timeline?per_page={ISSUE_TIMELINE_PAGE_SIZE}&page={page}"
            ))
            .await
            .map_err(|e| e.to_string())?;
        let raw_items = result.as_array().cloned().unwrap_or_default();
        let raw_count = raw_items.len();
        timeline.extend(raw_items.iter().map(parse_issue_timeline_item));

        if raw_count < ISSUE_TIMELINE_PAGE_SIZE {
            break;
        }
        page = page
            .checked_add(1)
            .ok_or_else(|| "GitHub issue timeline page overflow".to_string())?;
    }

    Ok(timeline)
}

#[tauri::command]
pub async fn github_create_issue_comment(
    repo_full_name: String,
    issue_number: u64,
    body: String,
) -> Result<GitHubIssueComment, String> {
    log::info!("[GitHub][Cmd] create_issue_comment repo={repo_full_name} issue={issue_number}");
    let client = make_client()?;
    let payload = serde_json::json!({ "body": body });
    let result = client
        .post(
            &format!("/repos/{repo_full_name}/issues/{issue_number}/comments"),
            payload,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_issue_comment(&result))
}

#[tauri::command]
pub async fn github_list_repo_labels(repo_full_name: String) -> Result<Vec<IssueLabel>, String> {
    log::info!("[GitHub][Cmd] list_repo_labels repo={repo_full_name}");
    let client = make_client()?;
    let result = client
        .get(&format!("/repos/{repo_full_name}/labels?per_page=100"))
        .await
        .map_err(|e| e.to_string())?;
    Ok(result
        .as_array()
        .map(|arr| arr.iter().map(parse_issue_label).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn github_list_repo_assignees(repo_full_name: String) -> Result<Vec<IssueUser>, String> {
    log::info!("[GitHub][Cmd] list_repo_assignees repo={repo_full_name}");
    let client = make_client()?;
    let result = client
        .get(&format!("/repos/{repo_full_name}/assignees?per_page=100"))
        .await
        .map_err(|e| e.to_string())?;
    Ok(result
        .as_array()
        .map(|arr| arr.iter().map(parse_issue_user).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod issue_tests {
    use serde_json::json;

    use super::{
        apply_linked_pull_request_counts, assignee_login_sets_match, build_update_issue_payload,
        issue_assignee_logins, linked_pull_requests_query, normalize_assignee_logins, parse_issue,
        parse_issue_timeline_item, UpdateIssueFields,
    };

    #[test]
    fn normalizes_assignee_logins_case_insensitively() {
        assert_eq!(
            normalize_assignee_logins(vec![
                " Neonforge98 ".to_string(),
                "neonforge98".to_string(),
                "".to_string(),
                "Harry19081".to_string(),
            ]),
            vec!["Neonforge98".to_string(), "Harry19081".to_string()]
        );
    }

    #[test]
    fn compares_assignee_sets_without_case_or_order() {
        assert!(assignee_login_sets_match(
            &["Harry19081".to_string(), "Neonforge98".to_string()],
            &["neonforge98".to_string(), "harry19081".to_string()]
        ));
        assert!(!assignee_login_sets_match(
            &["Neonforge98".to_string()],
            &["Neonforge98".to_string(), "Harry19081".to_string()]
        ));
    }

    #[test]
    fn extracts_assignee_logins_from_issue_response() {
        assert_eq!(
            issue_assignee_logins(&json!({
                "assignees": [
                    { "login": "Neonforge98" },
                    { "login": "Harry19081" }
                ]
            })),
            vec!["Neonforge98".to_string(), "Harry19081".to_string()]
        );
    }

    #[test]
    fn serializes_close_as_duplicate_payload() {
        let payload = build_update_issue_payload(UpdateIssueFields {
            state: Some("closed".to_string()),
            state_reason: Some("duplicate".to_string()),
            duplicate_issue_id: Some(987_654),
            ..Default::default()
        });

        assert_eq!(
            payload,
            json!({
                "state": "closed",
                "state_reason": "duplicate",
                "duplicate_issue_id": 987_654
            })
        );
    }

    #[test]
    fn maps_batched_linked_pull_request_counts_to_issues() {
        let mut issues = vec![
            parse_issue(&json!({ "number": 42 })),
            parse_issue(&json!({ "number": 77 })),
        ];
        let query = linked_pull_requests_query(&issues);

        assert!(query.contains("issue_42: issue(number: 42)"));
        assert!(query.contains("includeClosedPrs: true"));

        apply_linked_pull_request_counts(
            &mut issues,
            &json!({
                "data": {
                    "repository": {
                        "issue_42": {
                            "closedByPullRequestsReferences": { "totalCount": 2 }
                        },
                        "issue_77": {
                            "closedByPullRequestsReferences": { "totalCount": 1 }
                        }
                    }
                }
            }),
        );

        assert_eq!(issues[0].linked_pull_requests_count, 2);
        assert_eq!(issues[1].linked_pull_requests_count, 1);
    }

    #[test]
    fn normalizes_comment_and_actor() {
        let item = parse_issue_timeline_item(&json!({
            "id": 5034449241_u64,
            "event": "commented",
            "created_at": "2026-07-21T13:09:14Z",
            "user": { "login": "Harry19081", "avatar_url": "https://example.com/avatar.png" },
            "body": "Please work on this",
            "html_url": "https://github.com/org2ai/ORG2/issues/459#issuecomment-5034449241"
        }));

        assert_eq!(item.event, "commented");
        assert_eq!(item.actor.expect("comment actor").login, "Harry19081");
        assert_eq!(item.body.as_deref(), Some("Please work on this"));
        assert_eq!(item.created_at.as_deref(), Some("2026-07-21T13:09:14Z"));
    }

    #[test]
    fn preserves_assignment_label_and_cross_reference_details() {
        let assigned = parse_issue_timeline_item(&json!({
            "id": 1,
            "event": "assigned",
            "created_at": "2026-07-21T05:55:44Z",
            "actor": { "login": "beruro", "avatar_url": "actor.png" },
            "assignee": { "login": "Harry19081", "avatar_url": "assignee.png" }
        }));
        let labeled = parse_issue_timeline_item(&json!({
            "id": 2,
            "event": "labeled",
            "created_at": "2026-07-21T05:55:44Z",
            "label": { "name": "bug", "color": "d73a4a" }
        }));
        let cross_reference = parse_issue_timeline_item(&json!({
            "event": "cross-referenced",
            "created_at": "2026-07-21T06:03:15Z",
            "actor": { "login": "beruro", "avatar_url": "actor.png" },
            "source": {
                "type": "issue",
                "issue": {
                    "number": 460,
                    "title": "fix(chat): refresh question status after answer",
                    "html_url": "https://github.com/org2ai/ORG2/pull/460",
                    "state": "open",
                    "pull_request": { "html_url": "https://github.com/org2ai/ORG2/pull/460" }
                }
            }
        }));

        assert_eq!(assigned.assignee.expect("assignee").login, "Harry19081");
        assert_eq!(labeled.label.expect("label").name, "bug");
        let source = cross_reference.source.expect("cross-reference source");
        assert_eq!(source.number, 460);
        assert!(source.is_pull_request);
        assert_eq!(source.state, "open");
    }
}
