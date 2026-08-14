//! Pull request commands: create/find/list, per-PR detail (commits, files),
//! reviews, inline review comments, and CI checks.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::command;

use super::super::client::GitHubClient;
use super::issues::{parse_issue_user, IssueUser};
use super::shared::make_client;

const GITHUB_PAGE_SIZE: usize = 100;

const ENABLE_AUTO_MERGE_MUTATION: &str = r#"
mutation EnablePullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) {
    pullRequest { id }
  }
}
"#;

const DISABLE_AUTO_MERGE_MUTATION: &str = r#"
mutation DisablePullRequestAutoMerge($input: DisablePullRequestAutoMergeInput!) {
  disablePullRequestAutoMerge(input: $input) {
    pullRequest { id }
  }
}
"#;

const CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION: &str = r#"
mutation ConvertPullRequestToDraft($input: ConvertPullRequestToDraftInput!) {
  convertPullRequestToDraft(input: $input) {
    pullRequest { id isDraft }
  }
}
"#;

const MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION: &str = r#"
mutation MarkPullRequestReadyForReview($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) {
    pullRequest { id isDraft }
  }
}
"#;

const ENQUEUE_PULL_REQUEST_MUTATION: &str = r#"
mutation EnqueuePullRequest($input: EnqueuePullRequestInput!) {
  enqueuePullRequest(input: $input) {
    mergeQueueEntry { id }
  }
}
"#;

const DEQUEUE_PULL_REQUEST_MUTATION: &str = r#"
mutation DequeuePullRequest($input: DequeuePullRequestInput!) {
  dequeuePullRequest(input: $input) {
    mergeQueueEntry { id }
  }
}
"#;

const PULL_REQUEST_MERGE_AUTOMATION_QUERY: &str = r#"
query PullRequestMergeAutomation($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      isMergeQueueEnabled
      mergeQueueEntry { id }
      mergeStateStatus
      reviewDecision
    }
  }
}
"#;

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
        let page_items = data[field].as_array().ok_or_else(|| {
            format!("GitHub API returned missing array field `{field}` for {base_path}")
        })?;
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

fn validate_merge_method(method: &str) -> Result<&'static str, String> {
    match method {
        "merge" => Ok("merge"),
        "squash" => Ok("squash"),
        "rebase" => Ok("rebase"),
        _ => Err(format!(
            "Invalid pull request merge method `{method}`; expected merge, squash, or rebase"
        )),
    }
}

fn graphql_merge_method(method: &str) -> Result<&'static str, String> {
    match validate_merge_method(method)? {
        "merge" => Ok("MERGE"),
        "squash" => Ok("SQUASH"),
        "rebase" => Ok("REBASE"),
        _ => unreachable!("validate_merge_method returns only known methods"),
    }
}

fn graphql_error(response: &Value) -> Option<String> {
    let messages = response["errors"]
        .as_array()?
        .iter()
        .filter_map(|error| error["message"].as_str())
        .collect::<Vec<_>>();
    (!messages.is_empty()).then(|| messages.join("; "))
}

#[derive(Default)]
struct PullRequestMergeAutomationContext {
    merge_queue_enabled: bool,
    merge_queue_entry_id: Option<String>,
    merge_state_status: Option<String>,
    review_decision: Option<String>,
}

impl PullRequestMergeAutomationContext {
    fn ready_for_merge_queue(&self) -> bool {
        self.merge_state_status.as_deref() == Some("CLEAN")
            && !matches!(
                self.review_decision.as_deref(),
                Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED")
            )
    }
}

/// Adds GraphQL-only merge metadata to the REST pull-request detail payload.
fn apply_pull_request_merge_context(
    detail: &mut Value,
    context: PullRequestMergeAutomationContext,
) {
    detail["merge_queue_required"] = json!(context.merge_queue_enabled);
    detail["is_in_merge_queue"] = json!(context.merge_queue_entry_id.is_some());
    if let Some(merge_state_status) = context.merge_state_status {
        detail["merge_state_status"] = json!(merge_state_status);
    }
    if let Some(review_decision) = context.review_decision {
        detail["review_decision"] = json!(review_decision);
    }
}

async fn get_pull_request_merge_automation_context(
    client: &GitHubClient,
    pull_request_id: &str,
) -> Result<PullRequestMergeAutomationContext, String> {
    let response = client
        .graphql(
            PULL_REQUEST_MERGE_AUTOMATION_QUERY,
            json!({ "id": pull_request_id }),
        )
        .await?;
    if let Some(error) = graphql_error(&response) {
        return Err(error);
    }
    let pull_request = &response["data"]["node"];
    if pull_request.is_null() {
        return Err("GitHub did not return pull request merge metadata".to_string());
    }
    Ok(PullRequestMergeAutomationContext {
        merge_queue_enabled: pull_request["isMergeQueueEnabled"]
            .as_bool()
            .unwrap_or(false),
        merge_queue_entry_id: pull_request["mergeQueueEntry"]["id"]
            .as_str()
            .map(String::from),
        merge_state_status: pull_request["mergeStateStatus"].as_str().map(String::from),
        review_decision: pull_request["reviewDecision"].as_str().map(String::from),
    })
}

fn normalize_reviewer_logins(reviewers: Vec<String>) -> Result<Vec<String>, String> {
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

fn build_merge_payload(method: &str, expected_head_sha: Option<&str>) -> Result<Value, String> {
    let method = validate_merge_method(method)?;
    let mut payload = json!({ "merge_method": method });
    if let Some(expected_head_sha) = expected_head_sha {
        payload["sha"] = json!(expected_head_sha);
    }
    Ok(payload)
}

struct AutoMergeGraphqlRequest {
    mutation: &'static str,
    mutation_field: &'static str,
    input: Value,
}

#[derive(Debug)]
struct DraftStateGraphqlRequest {
    mutation: &'static str,
    mutation_field: &'static str,
    input: Value,
}

fn build_draft_state_graphql_request(
    draft: bool,
    pull_request_id: &str,
) -> DraftStateGraphqlRequest {
    let (mutation, mutation_field) = if draft {
        (
            CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION,
            "convertPullRequestToDraft",
        )
    } else {
        (
            MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION,
            "markPullRequestReadyForReview",
        )
    };
    DraftStateGraphqlRequest {
        mutation,
        mutation_field,
        input: json!({ "pullRequestId": pull_request_id }),
    }
}

fn build_auto_merge_graphql_request(
    enabled: bool,
    method: Option<&str>,
    pull_request_id: &str,
    expected_head_oid: &str,
) -> Result<AutoMergeGraphqlRequest, String> {
    if enabled {
        let merge_method = graphql_merge_method(method.unwrap_or("merge"))?;
        Ok(AutoMergeGraphqlRequest {
            mutation: ENABLE_AUTO_MERGE_MUTATION,
            mutation_field: "enablePullRequestAutoMerge",
            input: json!({
                "pullRequestId": pull_request_id,
                "expectedHeadOid": expected_head_oid,
                "mergeMethod": merge_method,
            }),
        })
    } else {
        Ok(AutoMergeGraphqlRequest {
            mutation: DISABLE_AUTO_MERGE_MUTATION,
            mutation_field: "disablePullRequestAutoMerge",
            input: json!({
                "pullRequestId": pull_request_id,
            }),
        })
    }
}

fn build_merge_queue_graphql_request(
    enabled: bool,
    pull_request_id: &str,
    merge_queue_entry_id: Option<&str>,
    expected_head_oid: &str,
) -> Result<AutoMergeGraphqlRequest, String> {
    if enabled {
        Ok(AutoMergeGraphqlRequest {
            mutation: ENQUEUE_PULL_REQUEST_MUTATION,
            mutation_field: "enqueuePullRequest",
            input: json!({
                "pullRequestId": pull_request_id,
                "expectedHeadOid": expected_head_oid,
            }),
        })
    } else {
        let merge_queue_entry_id = merge_queue_entry_id
            .ok_or_else(|| "GitHub did not return the merge queue entry ID".to_string())?;
        Ok(AutoMergeGraphqlRequest {
            mutation: DEQUEUE_PULL_REQUEST_MUTATION,
            mutation_field: "dequeuePullRequest",
            input: json!({ "id": merge_queue_entry_id }),
        })
    }
}

#[derive(Debug, Serialize)]
pub struct PullRequestMergeResult {
    pub sha: String,
    pub merged: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct PullRequestAutoMergeResult {
    pub enabled: bool,
}

#[command]
pub async fn github_merge_pr(
    repo_full_name: String,
    pr_number: u64,
    method: String,
    expected_head_sha: Option<String>,
) -> Result<PullRequestMergeResult, String> {
    let method = validate_merge_method(&method)?;
    log::info!("[GitHub][Cmd] merge_pr repo={repo_full_name} pr={pr_number} method={method}");
    let client = make_client()?;
    let payload = build_merge_payload(method, expected_head_sha.as_deref())?;
    let data = client
        .put(
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/merge"),
            payload,
        )
        .await?;
    let message = data["message"]
        .as_str()
        .unwrap_or("GitHub did not merge the pull request")
        .to_string();
    let merged = data["merged"].as_bool().unwrap_or(false);
    if !merged {
        return Err(message);
    }
    Ok(PullRequestMergeResult {
        sha: data["sha"].as_str().unwrap_or("").to_string(),
        merged,
        message,
    })
}

#[command]
pub async fn github_set_pr_auto_merge(
    repo_full_name: String,
    pr_number: u64,
    enabled: bool,
    method: Option<String>,
    expected_head_sha: Option<String>,
) -> Result<PullRequestAutoMergeResult, String> {
    log::info!(
        "[GitHub][Cmd] set_pr_auto_merge repo={repo_full_name} pr={pr_number} enabled={enabled}"
    );
    let client = make_client()?;
    let detail = client
        .get(&format!("/repos/{repo_full_name}/pulls/{pr_number}"))
        .await?;
    if detail["state"].as_str() != Some("open") || detail["merged"].as_bool() == Some(true) {
        return Err("Auto-merge is available only for open pull requests".to_string());
    }
    if enabled && detail["draft"].as_bool() == Some(true) {
        return Err(
            "Mark this pull request ready for review before enabling auto-merge".to_string(),
        );
    }
    let pull_request_id = detail["node_id"]
        .as_str()
        .ok_or_else(|| "GitHub did not return the pull request node ID".to_string())?;
    let current_head_sha = detail["head"]["sha"]
        .as_str()
        .ok_or_else(|| "GitHub did not return the pull request head SHA".to_string())?;
    let expected_head_oid = expected_head_sha.as_deref().unwrap_or(current_head_sha);
    if expected_head_oid != current_head_sha {
        return Err(
            "The pull request head changed; refresh before changing auto-merge".to_string(),
        );
    }

    let context = match get_pull_request_merge_automation_context(&client, pull_request_id).await {
        Ok(context) => context,
        Err(error) if error.contains("GitHubReAuthRequired") => return Err(error),
        Err(error) => {
            log::warn!("[GitHub][Cmd] merge automation metadata unavailable: {error}");
            PullRequestMergeAutomationContext::default()
        }
    };
    let request = if context.merge_queue_enabled
        && ((enabled && context.ready_for_merge_queue())
            || (!enabled && context.merge_queue_entry_id.is_some()))
    {
        build_merge_queue_graphql_request(
            enabled,
            pull_request_id,
            context.merge_queue_entry_id.as_deref(),
            expected_head_oid,
        )?
    } else {
        build_auto_merge_graphql_request(
            enabled,
            method.as_deref(),
            pull_request_id,
            expected_head_oid,
        )?
    };
    let response = client
        .graphql(request.mutation, json!({ "input": request.input }))
        .await?;
    if let Some(error) = graphql_error(&response) {
        return Err(error);
    }
    if response["data"][request.mutation_field].is_null() {
        return Err("GitHub did not confirm the auto-merge change".to_string());
    }
    Ok(PullRequestAutoMergeResult { enabled })
}

#[command]
pub async fn github_update_pr_draft_state(
    repo_full_name: String,
    pr_number: u64,
    draft: bool,
) -> Result<(), String> {
    log::info!(
        "[GitHub][Cmd] update_pr_draft_state repo={repo_full_name} pr={pr_number} draft={draft}"
    );
    let client = make_client()?;
    let detail = client
        .get(&format!("/repos/{repo_full_name}/pulls/{pr_number}"))
        .await?;
    if detail["state"].as_str() != Some("open") || detail["merged"].as_bool() == Some(true) {
        return Err("Draft status can be changed only for open pull requests".to_string());
    }
    if detail["draft"].as_bool() == Some(draft) {
        return Ok(());
    }
    let pull_request_id = detail["node_id"]
        .as_str()
        .ok_or_else(|| "GitHub did not return the pull request node ID".to_string())?;
    let request = build_draft_state_graphql_request(draft, pull_request_id);
    let response = client
        .graphql(request.mutation, json!({ "input": request.input }))
        .await?;
    if let Some(error) = graphql_error(&response) {
        return Err(error);
    }
    let updated_draft =
        response["data"][request.mutation_field]["pullRequest"]["isDraft"].as_bool();
    if updated_draft != Some(draft) {
        return Err("GitHub did not confirm the pull request draft status change".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod pr_action_payload_tests {
    use super::*;

    #[test]
    fn merge_payload_uses_an_allowed_method_and_expected_head_sha() {
        assert_eq!(
            build_merge_payload("squash", Some("head-sha")).unwrap(),
            json!({ "merge_method": "squash", "sha": "head-sha" })
        );
        assert!(build_merge_payload("octopus", None).is_err());
    }

    #[test]
    fn auto_merge_payloads_match_each_mutations_input_schema() {
        let enable =
            build_auto_merge_graphql_request(true, Some("rebase"), "pull-request-node", "head-sha")
                .unwrap();
        assert_eq!(enable.mutation_field, "enablePullRequestAutoMerge");
        assert_eq!(
            enable.input,
            json!({
                "pullRequestId": "pull-request-node",
                "expectedHeadOid": "head-sha",
                "mergeMethod": "REBASE",
            })
        );

        let disable =
            build_auto_merge_graphql_request(false, None, "pull-request-node", "head-sha").unwrap();
        assert_eq!(disable.mutation_field, "disablePullRequestAutoMerge");
        assert_eq!(
            disable.input,
            json!({
                "pullRequestId": "pull-request-node",
            })
        );
    }

    #[test]
    fn draft_state_payloads_use_the_matching_graphql_mutation() {
        let convert = build_draft_state_graphql_request(true, "pull-request-node");
        assert_eq!(convert.mutation, CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION);
        assert_eq!(convert.mutation_field, "convertPullRequestToDraft");
        assert_eq!(
            convert.input,
            json!({ "pullRequestId": "pull-request-node" })
        );

        let ready = build_draft_state_graphql_request(false, "pull-request-node");
        assert_eq!(ready.mutation, MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION);
        assert_eq!(ready.mutation_field, "markPullRequestReadyForReview");
        assert_eq!(ready.input, json!({ "pullRequestId": "pull-request-node" }));
    }

    #[test]
    fn merge_queue_payloads_enqueue_by_pr_and_dequeue_by_entry() {
        let enqueue =
            build_merge_queue_graphql_request(true, "pull-request-node", None, "head-sha").unwrap();
        assert_eq!(enqueue.mutation_field, "enqueuePullRequest");
        assert_eq!(
            enqueue.input,
            json!({
                "pullRequestId": "pull-request-node",
                "expectedHeadOid": "head-sha",
            })
        );

        let dequeue = build_merge_queue_graphql_request(
            false,
            "pull-request-node",
            Some("queue-entry"),
            "head-sha",
        )
        .unwrap();
        assert_eq!(dequeue.mutation_field, "dequeuePullRequest");
        assert_eq!(dequeue.input, json!({ "id": "queue-entry" }));
        assert!(
            build_merge_queue_graphql_request(false, "pull-request-node", None, "head-sha")
                .is_err()
        );
    }

    #[test]
    fn merge_queue_requires_clean_merge_state_without_review_blockers() {
        let ready = PullRequestMergeAutomationContext {
            merge_state_status: Some("CLEAN".to_string()),
            ..Default::default()
        };
        let review_blocked = PullRequestMergeAutomationContext {
            merge_state_status: Some("CLEAN".to_string()),
            review_decision: Some("REVIEW_REQUIRED".to_string()),
            ..Default::default()
        };
        let checks_blocked = PullRequestMergeAutomationContext {
            merge_state_status: Some("BLOCKED".to_string()),
            ..Default::default()
        };

        assert!(ready.ready_for_merge_queue());
        assert!(!review_blocked.ready_for_merge_queue());
        assert!(!checks_blocked.ready_for_merge_queue());
    }

    #[test]
    fn pr_detail_enrichment_preserves_graphql_merge_state() {
        let mut detail = json!({ "mergeable_state": "unknown" });

        apply_pull_request_merge_context(
            &mut detail,
            PullRequestMergeAutomationContext {
                merge_queue_enabled: true,
                merge_queue_entry_id: Some("queue-entry".to_string()),
                merge_state_status: Some("DIRTY".to_string()),
                review_decision: Some("CHANGES_REQUESTED".to_string()),
            },
        );

        assert_eq!(detail["merge_queue_required"], json!(true));
        assert_eq!(detail["is_in_merge_queue"], json!(true));
        assert_eq!(detail["merge_state_status"], json!("DIRTY"));
        assert_eq!(detail["review_decision"], json!("CHANGES_REQUESTED"));
    }

    #[test]
    fn reviewer_logins_are_trimmed_and_deduplicated_case_insensitively() {
        assert_eq!(
            normalize_reviewer_logins(vec![
                " Reviewer ".to_string(),
                "reviewer".to_string(),
                "second".to_string(),
                " ".to_string(),
            ])
            .unwrap(),
            vec!["Reviewer".to_string(), "second".to_string()]
        );
        assert!(normalize_reviewer_logins(vec![" ".to_string()]).is_err());
    }

    #[test]
    fn graphql_errors_are_preserved_for_the_frontend() {
        assert_eq!(
            graphql_error(&json!({
                "errors": [
                    { "message": "Auto-merge is disabled" },
                    { "message": "Approval is required" }
                ]
            })),
            Some("Auto-merge is disabled; Approval is required".to_string())
        );
    }
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

#[cfg(test)]
mod open_pr_item_tests {
    use super::*;

    #[test]
    fn serializes_author_and_only_outstanding_requested_reviewers() {
        let item = json!({
            "number": 17,
            "html_url": "https://github.com/acme/repo/pull/17",
            "title": "Ship personal PR inbox",
            "state": "open",
            "merged_at": null,
            "user": {
                "login": "author",
                "avatar_url": "https://avatars.example/author"
            },
            "requested_reviewers": [
                { "login": "viewer" },
                { "login": "second-reviewer" }
            ],
            "head": { "ref": "feature/personal-prs" },
            "base": { "ref": "main" },
            "draft": false,
            "created_at": "2026-07-30T08:00:00Z",
            "updated_at": "2026-07-30T09:00:00Z"
        });

        let serialized = serde_json::to_value(parse_open_pr_item(&item)).unwrap();

        assert_eq!(serialized["author_login"], "author");
        assert_eq!(
            serialized["author_avatar_url"],
            "https://avatars.example/author"
        );
        assert_eq!(
            serialized["requested_reviewer_logins"],
            json!(["viewer", "second-reviewer"])
        );
        assert_eq!(serialized["state"], "open");
        assert_eq!(serialized["ci_status"], "unavailable");
        assert_eq!(serialized["additions"], Value::Null);
        assert_eq!(serialized["deletions"], Value::Null);
    }

    #[test]
    fn keeps_merged_state_and_defaults_missing_identity_fields() {
        let item = json!({
            "number": 18,
            "state": "closed",
            "merged_at": "2026-07-30T10:00:00Z",
            "head": {},
            "base": {}
        });

        let serialized = serde_json::to_value(parse_open_pr_item(&item)).unwrap();

        assert_eq!(serialized["state"], "merged");
        assert_eq!(serialized["author_login"], "");
        assert_eq!(serialized["author_avatar_url"], Value::Null);
        assert_eq!(serialized["requested_reviewer_logins"], json!([]));
    }

    #[test]
    fn maps_batched_pull_request_list_metadata() {
        assert!(PULL_REQUEST_LIST_METADATA_QUERY.contains("nodes(ids: $ids)"));
        assert!(PULL_REQUEST_LIST_METADATA_QUERY.contains("additions"));
        assert!(PULL_REQUEST_LIST_METADATA_QUERY.contains("deletions"));
        assert!(PULL_REQUEST_LIST_METADATA_QUERY.contains("contexts(first: 100)"));

        let mut items = vec![
            parse_open_pr_item(&json!({ "number": 17 })),
            parse_open_pr_item(&json!({ "number": 18 })),
            parse_open_pr_item(&json!({ "number": 19 })),
            parse_open_pr_item(&json!({ "number": 20 })),
            parse_open_pr_item(&json!({ "number": 21 })),
        ];

        apply_pull_request_list_metadata(
            &mut items,
            &json!({
                "data": {
                    "nodes": [
                        {
                            "number": 17,
                            "additions": 45,
                            "deletions": 12,
                            "commits": {
                                "nodes": [{
                                    "commit": {
                                        "statusCheckRollup": { "state": "SUCCESS" }
                                    }
                                }]
                            }
                        },
                        {
                            "number": 18,
                            "commits": {
                                "nodes": [{
                                    "commit": {
                                        "statusCheckRollup": { "state": "PENDING" }
                                    }
                                }]
                            }
                        },
                        {
                            "number": 21,
                            "commits": {
                                "nodes": [{
                                    "commit": {
                                        "statusCheckRollup": {
                                            "state": "PENDING",
                                            "contexts": {
                                                "nodes": [
                                                    {
                                                        "__typename": "CheckRun",
                                                        "conclusion": "FAILURE"
                                                    },
                                                    {
                                                        "__typename": "CheckRun",
                                                        "conclusion": null
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }]
                            }
                        },
                        {
                            "number": 19,
                            "commits": {
                                "nodes": [{
                                    "commit": { "statusCheckRollup": null }
                                }]
                            }
                        },
                        {
                            "number": 20,
                            "commits": {
                                "nodes": [{
                                    "commit": {
                                        "statusCheckRollup": { "state": "FAILURE" }
                                    }
                                }]
                            }
                        }
                    ]
                }
            }),
        );

        assert_eq!(items[0].ci_status, PullRequestCiStatus::Success);
        assert_eq!(items[0].additions, Some(45));
        assert_eq!(items[0].deletions, Some(12));
        assert_eq!(items[1].ci_status, PullRequestCiStatus::Pending);
        assert_eq!(items[1].additions, None);
        assert_eq!(items[1].deletions, None);
        assert_eq!(items[2].ci_status, PullRequestCiStatus::None);
        assert_eq!(items[3].ci_status, PullRequestCiStatus::Failure);
        assert_eq!(items[4].ci_status, PullRequestCiStatus::Failure);
    }

    #[test]
    fn accepts_only_mutable_pull_request_states() {
        assert_eq!(
            validate_pull_request_state("open".to_string()).unwrap(),
            "open"
        );
        assert_eq!(
            validate_pull_request_state("closed".to_string()).unwrap(),
            "closed"
        );
        assert!(validate_pull_request_state("merged".to_string()).is_err());
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

#[command]
pub async fn github_get_pr(repo_full_name: String, pr_number: u64) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] get_pr repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    let mut detail = client
        .get_conditional(&format!("/repos/{repo_full_name}/pulls/{pr_number}"))
        .await?;

    let pull_request_id = detail["node_id"].as_str().map(String::from);
    let base_sha = detail["base"]["sha"].as_str().map(String::from);
    let head_sha = detail["head"]["sha"].as_str().map(String::from);
    let merge_context = async {
        match pull_request_id.as_deref() {
            Some(id) => Some(get_pull_request_merge_automation_context(&client, id).await),
            None => None,
        }
    };
    let compare = async {
        match (base_sha, head_sha) {
            (Some(base_sha), Some(head_sha)) => Some(
                client
                    .get_conditional(&format!(
                        "/repos/{repo_full_name}/compare/{base_sha}...{head_sha}"
                    ))
                    .await,
            ),
            _ => None,
        }
    };
    let (merge_context, compare) = tokio::join!(merge_context, compare);

    if let Some(result) = merge_context {
        match result {
            Ok(context) => apply_pull_request_merge_context(&mut detail, context),
            Err(error) => {
                log::warn!("[GitHub][Cmd] get_pr merge metadata failed: {error}");
            }
        }
    }
    if let Some(result) = compare {
        match result {
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
        get_paginated_array(
            &client,
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/commits"),
        )
        .await?,
    ))
}

#[command]
pub async fn github_list_pr_files(repo_full_name: String, pr_number: u64) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] list_pr_files repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    Ok(Value::Array(
        get_paginated_array(
            &client,
            &format!("/repos/{repo_full_name}/pulls/{pr_number}/files"),
        )
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
