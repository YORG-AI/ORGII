use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::command;

use super::super::super::client::GitHubClient;
use super::super::shared::make_client;
use super::merge::graphql_error;

const PULL_REQUEST_LIST_METADATA_QUERY: &str = r#"
query PullRequestListMetadata($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      number
      additions
      deletions
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { conclusion }
                  ... on StatusContext { state }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

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

    let data = client
        .get(&format!(
            "/repos/{repo_full_name}/pulls?state=open&head={owner}:{head_branch}&per_page=1"
        ))
        .await?;
    let pr = parse_pr(&data);
    if let Some(pr) = &pr {
        log::info!(
            "[GitHub][Cmd] find_pull_request found open PR #{}",
            pr.number
        );
    } else {
        log::info!("[GitHub][Cmd] find_pull_request not found");
    }
    Ok(pr)
}

/// Response item for a single PR in `github_list_prs`.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestCiStatus {
    Success,
    Failure,
    Pending,
    None,
    Unavailable,
}

#[derive(Debug, Serialize)]
pub struct OpenPRItem {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: String,
    pub author_login: String,
    pub author_avatar_url: Option<String>,
    /// GitHub removes a reviewer from this list after they submit a review,
    /// unless another review is explicitly requested.
    pub requested_reviewer_logins: Vec<String>,
    pub head_branch: String,
    pub base_branch: String,
    pub draft: bool,
    pub ci_status: PullRequestCiStatus,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
}

fn parse_open_pr_item(item: &Value) -> OpenPRItem {
    OpenPRItem {
        number: item["number"].as_u64().unwrap_or(0),
        url: item["html_url"].as_str().unwrap_or("").to_string(),
        title: item["title"].as_str().unwrap_or("").to_string(),
        state: if item["merged_at"].is_null() {
            item["state"].as_str().unwrap_or("open").to_string()
        } else {
            "merged".to_string()
        },
        author_login: item["user"]["login"].as_str().unwrap_or("").to_string(),
        author_avatar_url: item["user"]["avatar_url"].as_str().map(String::from),
        requested_reviewer_logins: item["requested_reviewers"]
            .as_array()
            .map(|reviewers| {
                reviewers
                    .iter()
                    .filter_map(|reviewer| reviewer["login"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        head_branch: item["head"]["ref"].as_str().unwrap_or("").to_string(),
        base_branch: item["base"]["ref"].as_str().unwrap_or("").to_string(),
        draft: item["draft"].as_bool().unwrap_or(false),
        ci_status: PullRequestCiStatus::Unavailable,
        additions: item["additions"].as_u64(),
        deletions: item["deletions"].as_u64(),
        created_at: item["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: item["updated_at"].as_str().unwrap_or("").to_string(),
    }
}

fn parse_pull_request_ci_status(node: &Value) -> PullRequestCiStatus {
    let rollup = &node["commits"]["nodes"][0]["commit"]["statusCheckRollup"];
    if rollup.is_null() {
        return PullRequestCiStatus::None;
    }
    let has_failed_context = rollup["contexts"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|context| match context["__typename"].as_str() {
            Some("CheckRun") => matches!(
                context["conclusion"].as_str(),
                Some("FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "CANCELLED" | "STARTUP_FAILURE")
            ),
            Some("StatusContext") => {
                matches!(context["state"].as_str(), Some("FAILURE" | "ERROR"))
            }
            _ => false,
        });
    if has_failed_context {
        return PullRequestCiStatus::Failure;
    }
    match rollup["state"].as_str() {
        Some("SUCCESS") => PullRequestCiStatus::Success,
        Some("FAILURE" | "ERROR") => PullRequestCiStatus::Failure,
        Some("PENDING" | "EXPECTED") => PullRequestCiStatus::Pending,
        _ => PullRequestCiStatus::Unavailable,
    }
}

fn apply_pull_request_list_metadata(items: &mut [OpenPRItem], response: &Value) {
    let metadata = response["data"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| {
            node["number"].as_u64().map(|number| {
                (
                    number,
                    (
                        parse_pull_request_ci_status(node),
                        node["additions"].as_u64(),
                        node["deletions"].as_u64(),
                    ),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    for item in items {
        if let Some((status, additions, deletions)) = metadata.get(&item.number) {
            item.ci_status = *status;
            item.additions = *additions;
            item.deletions = *deletions;
        }
    }
}

async fn enrich_pull_request_list_metadata(
    client: &GitHubClient,
    repo_full_name: &str,
    source_items: &[Value],
    items: &mut [OpenPRItem],
) {
    let ids = source_items
        .iter()
        .filter_map(|item| item["node_id"].as_str())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return;
    }
    match client
        .graphql(PULL_REQUEST_LIST_METADATA_QUERY, json!({ "ids": ids }))
        .await
    {
        Ok(response) => {
            if let Some(error) = graphql_error(&response) {
                log::warn!(
                    "[GitHub][Cmd] PR list metadata GraphQL query returned errors for {repo_full_name}: {error}"
                );
            }
            apply_pull_request_list_metadata(items, &response);
        }
        Err(error) => {
            log::warn!(
                "[GitHub][Cmd] PR list metadata enrichment failed for {repo_full_name}: {error}"
            );
        }
    }
}

fn validate_pull_request_state(state: String) -> Result<String, String> {
    match state.as_str() {
        "open" | "closed" => Ok(state),
        _ => Err("pull request state must be open or closed".to_string()),
    }
}

#[command]
pub async fn github_list_prs(
    repo_full_name: String,
    state: String,
    per_page: Option<u64>,
) -> Result<Vec<OpenPRItem>, String> {
    let state = validate_pull_request_state(state)?;
    let limit = per_page.unwrap_or(30).min(100);
    log::info!("[GitHub][Cmd] list_prs repo={repo_full_name} state={state} per_page={limit}");
    let client = make_client()?;
    let data = client
        .get_conditional(&format!(
            "/repos/{repo_full_name}/pulls?state={state}&sort=updated&direction=desc&per_page={limit}"
        ))
        .await?;
    let source_items = data.as_array().cloned().unwrap_or_default();
    let mut items: Vec<OpenPRItem> = source_items.iter().map(parse_open_pr_item).collect();
    enrich_pull_request_list_metadata(&client, &repo_full_name, &source_items, &mut items).await;
    log::info!(
        "[GitHub][Cmd] list_prs state={state} found {} PRs",
        items.len()
    );
    Ok(items)
}

#[command]
pub async fn github_update_pr_state(
    repo_full_name: String,
    pr_number: u64,
    state: String,
) -> Result<OpenPRItem, String> {
    let state = validate_pull_request_state(state)?;
    log::info!("[GitHub][Cmd] update_pr_state repo={repo_full_name} pr={pr_number} state={state}");
    let client = make_client()?;
    let data = client
        .patch(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}"),
            json!({ "state": state }),
        )
        .await?;
    Ok(parse_open_pr_item(&data))
}

#[cfg(test)]
#[path = "open_pr_item_tests.rs"]
mod open_pr_item_tests;
