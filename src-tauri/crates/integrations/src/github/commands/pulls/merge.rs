use serde::Serialize;
use serde_json::{json, Value};
use tauri::command;

use super::super::super::client::GitHubClient;
use super::super::shared::make_client;

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

pub(super) fn graphql_error(response: &Value) -> Option<String> {
    let messages = response["errors"]
        .as_array()?
        .iter()
        .filter_map(|error| error["message"].as_str())
        .collect::<Vec<_>>();
    (!messages.is_empty()).then(|| messages.join("; "))
}

#[derive(Default)]
pub(super) struct PullRequestMergeAutomationContext {
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
pub(super) fn apply_pull_request_merge_context(
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

pub(super) async fn get_pull_request_merge_automation_context(
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
#[path = "pr_action_payload_tests.rs"]
mod pr_action_payload_tests;
