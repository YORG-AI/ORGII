//! GitHub Profile Data Fetching
//!
//! Moves profile data collection from the server (github_source.py) to local.
//! This was the biggest source of server pressure — a single user's profile
//! fetch generates dozens to hundreds of GitHub API requests.
//!
//! Improvements over the Python implementation:
//! - Concurrent requests via `buffer_unordered(10)` instead of serial
//! - Parallel year queries for commit history
//! - Runs entirely on the user's machine

use std::collections::HashMap;

use chrono::Datelike;
use futures::future::join_all;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::command;

use project_management::sync::git_credentials::find_https_credential;

use super::client::GitHubClient;

// ============================================
// Types
// ============================================

#[derive(Debug, Serialize)]
pub struct ProfileData {
    pub user: Value,
    pub repos: Vec<Value>,
    pub languages: Vec<LangStat>,
    pub commit_history: Vec<CommitYearStat>,
    pub top_repos: Vec<Value>,
}

#[derive(Debug, Serialize)]
pub struct LangStat {
    pub language: String,
    pub bytes: u64,
    pub percentage: f64,
}

#[derive(Debug, Serialize)]
pub struct CommitYearStat {
    pub year: i32,
    pub total_commits: u64,
}

// ============================================
// GraphQL Query
// ============================================

const CONTRIBUTION_QUERY: &str = r#"
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
    }
  }
}
"#;

// ============================================
// Main Command
// ============================================

/// Fetch full GitHub profile data locally.
/// Replaces server-side GitHubProfileSource which was the heaviest endpoint.
#[command]
pub async fn github_fetch_profile() -> Result<ProfileData, String> {
    fetch_profile_internal().await
}

async fn fetch_profile_internal() -> Result<ProfileData, String> {
    log::info!("[GitHub][Profile] Starting profile fetch");
    let token = find_https_credential()?
        .ok_or_else(|| "GitHubReAuthRequired: no git connection on file".to_string())?
        .token;
    let client = GitHubClient::new(token);

    // Stage 1: user info + all repos in parallel
    log::info!("[GitHub][Profile] Stage 1: fetching user info + repos");
    let (user, all_repos) = tokio::try_join!(client.get("/user"), fetch_all_repos(&client),)?;

    let username = user["login"]
        .as_str()
        .ok_or("Missing login in /user response")?
        .to_string();

    log::info!(
        "[GitHub][Profile] Stage 1 done: user={}, {} repos",
        username,
        all_repos.len()
    );

    // Stage 2: language stats + commit history + top repos in parallel
    log::info!("[GitHub][Profile] Stage 2: fetching languages + commits + top repos");
    let (languages, commit_history, top_repos) = tokio::try_join!(
        aggregate_language_stats(&client, &all_repos),
        fetch_commit_history(&client, &username),
        fetch_top_repos(&client, &username),
    )?;

    log::info!(
        "[GitHub][Profile] Stage 2 done: {} languages, {} year stats, {} top repos",
        languages.len(),
        commit_history.len(),
        top_repos.len()
    );

    Ok(ProfileData {
        user,
        repos: all_repos,
        languages,
        commit_history,
        top_repos,
    })
}

// ============================================
// Helpers
// ============================================

/// Paginated fetch of all user repos.
async fn fetch_all_repos(client: &GitHubClient) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    let mut page = 1u32;

    loop {
        let data = client
            .get(&format!(
                "/user/repos?page={}&per_page=100&sort=updated",
                page
            ))
            .await?;

        let repos = data.as_array().ok_or("Expected array from /user/repos")?;
        if repos.is_empty() {
            break;
        }
        all.extend(repos.clone());
        if repos.len() < 100 {
            break;
        }
        page += 1;
    }

    Ok(all)
}

/// Aggregate language byte counts across all repos.
/// Processes in chunks of 10 for concurrency.
async fn aggregate_language_stats(
    client: &GitHubClient,
    repos: &[Value],
) -> Result<Vec<LangStat>, String> {
    let mut totals: HashMap<String, u64> = HashMap::new();

    // Collect repo names upfront to keep lifetimes simple
    let names: Vec<String> = repos
        .iter()
        .filter_map(|r| r["full_name"].as_str().map(String::from))
        .collect();

    // Process in chunks of 10 for concurrency
    for chunk in names.chunks(10) {
        let paths: Vec<String> = chunk
            .iter()
            .map(|name| format!("/repos/{}/languages", name))
            .collect();
        let futs: Vec<_> = paths.iter().map(|p| client.get(p)).collect();

        for data in join_all(futs).await.into_iter().filter_map(Result::ok) {
            if let Some(obj) = data.as_object() {
                for (lang, bytes) in obj {
                    if let Some(b) = bytes.as_u64() {
                        *totals.entry(lang.clone()).or_default() += b;
                    }
                }
            }
        }
    }

    let total: u64 = totals.values().sum();
    if total == 0 {
        return Ok(Vec::new());
    }

    let mut stats: Vec<LangStat> = totals
        .into_iter()
        .map(|(language, bytes)| LangStat {
            language,
            bytes,
            percentage: bytes as f64 / total as f64 * 100.0,
        })
        .collect();

    stats.sort_by_key(|stat| std::cmp::Reverse(stat.bytes));
    Ok(stats)
}

/// Fetch 5 years of commit history via GraphQL (all years in parallel).
async fn fetch_commit_history(
    client: &GitHubClient,
    username: &str,
) -> Result<Vec<CommitYearStat>, String> {
    let current_year = chrono::Utc::now().year();

    let futs: Vec<_> = (0..5)
        .map(|offset| {
            let year = current_year - offset;
            let vars = json!({
                "login": username,
                "from": format!("{}-01-01T00:00:00Z", year),
                "to": format!("{}-12-31T23:59:59Z", year),
            });
            client.graphql(CONTRIBUTION_QUERY, vars)
        })
        .collect();

    let results = futures::future::join_all(futs).await;
    let mut yearly = Vec::new();

    for (i, result) in results.into_iter().enumerate() {
        if let Ok(data) = result {
            let collection = &data["data"]["user"]["contributionsCollection"];
            let commits = collection["totalCommitContributions"].as_u64().unwrap_or(0);
            let restricted = collection["restrictedContributionsCount"]
                .as_u64()
                .unwrap_or(0);
            let total = commits + restricted;
            if total > 0 {
                yearly.push(CommitYearStat {
                    year: current_year - i as i32,
                    total_commits: total,
                });
            }
        }
    }

    yearly.sort_by_key(|s| s.year);
    Ok(yearly)
}

/// Fetch top repositories by stars via GraphQL.
async fn fetch_top_repos(client: &GitHubClient, username: &str) -> Result<Vec<Value>, String> {
    let query = r#"
        query($login: String!, $first: Int!) {
          user(login: $login) {
            repositories(
              first: $first,
              orderBy: { field: STARGAZERS, direction: DESC },
              ownerAffiliations: [OWNER]
            ) {
              nodes {
                name
                nameWithOwner
                description
                stargazerCount
                forkCount
                primaryLanguage { name color }
                updatedAt
                url
                isPrivate
              }
            }
          }
        }
    "#;

    let vars = json!({
        "login": username,
        "first": 10,
    });

    let data = client.graphql(query, vars).await?;

    let nodes = data["data"]["user"]["repositories"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    Ok(nodes)
}
