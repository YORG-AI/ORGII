use serde_json::{json, Value};
use tauri::command;

use super::super::shared::make_client;
use super::merge::{apply_pull_request_merge_context, get_pull_request_merge_automation_context};
use super::pagination::get_paginated_array;

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
