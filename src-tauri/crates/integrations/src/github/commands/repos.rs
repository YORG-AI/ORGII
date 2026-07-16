//! Repository listing, search, and branch commands.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::command;

use project_management::sync::git_credentials::find_https_credential;

use super::shared::make_client;

#[derive(Debug, Serialize, Deserialize)]
pub struct Repo {
    pub id: u64,
    pub full_name: String,
    pub name: String,
    pub private: bool,
    pub description: Option<String>,
    pub html_url: String,
    pub default_branch: String,
    pub language: Option<String>,
    pub stargazers_count: u64,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Branch {
    pub name: String,
    pub sha: String,
    pub protected: bool,
}

pub(crate) fn parse_repo(v: &Value) -> Repo {
    Repo {
        id: v["id"].as_u64().unwrap_or(0),
        full_name: v["full_name"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        private: v["private"].as_bool().unwrap_or(false),
        description: v["description"].as_str().map(String::from),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
        default_branch: v["default_branch"].as_str().unwrap_or("main").to_string(),
        language: v["language"].as_str().map(String::from),
        stargazers_count: v["stargazers_count"].as_u64().unwrap_or(0),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
    }
}

pub(crate) fn parse_branch(v: &Value) -> Branch {
    Branch {
        name: v["name"].as_str().unwrap_or("").to_string(),
        sha: v["commit"]["sha"].as_str().unwrap_or("").to_string(),
        protected: v["protected"].as_bool().unwrap_or(false),
    }
}

fn clean_repo_path(path: &str) -> Option<String> {
    let clean_path = path.trim_start_matches('/').trim_end_matches(".git");
    let mut parts = clean_path.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

pub(crate) fn github_repo_full_name_from_remote(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim();
    if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        return clean_repo_path(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        return clean_repo_path(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return clean_repo_path(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("ssh://git@github.com/") {
        return clean_repo_path(rest);
    }
    None
}

/// Result of `github_search_repos`. `authenticated` reports whether the
/// caller had a token on file; when `false`, GitHub enforces a strict
/// 10 req/min unauthenticated rate limit and the frontend surfaces that
/// fact to the user.
#[derive(Debug, Serialize)]
pub struct RepoSearchResponse {
    pub items: Vec<SearchRepo>,
    pub total_count: u64,
    pub incomplete_results: bool,
    pub authenticated: bool,
}

/// Search-API repo row. Carries more fields than `Repo` (owner avatar,
/// topics, fork/issue counts) because the Explore page renders them
/// inline and we want one round-trip per search.
#[derive(Debug, Serialize)]
pub struct SearchRepo {
    pub id: u64,
    pub full_name: String,
    pub name: String,
    pub owner_login: String,
    pub owner_avatar_url: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub description: Option<String>,
    pub html_url: String,
    pub clone_url: String,
    pub default_branch: String,
    pub language: Option<String>,
    pub stargazers_count: u64,
    pub forks_count: u64,
    pub open_issues_count: u64,
    pub license: Option<String>,
    pub topics: Vec<String>,
    pub updated_at: String,
}

fn parse_search_repo(v: &Value) -> SearchRepo {
    SearchRepo {
        id: v["id"].as_u64().unwrap_or(0),
        full_name: v["full_name"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        owner_login: v["owner"]["login"].as_str().unwrap_or("").to_string(),
        owner_avatar_url: v["owner"]["avatar_url"].as_str().unwrap_or("").to_string(),
        private: v["private"].as_bool().unwrap_or(false),
        fork: v["fork"].as_bool().unwrap_or(false),
        archived: v["archived"].as_bool().unwrap_or(false),
        description: v["description"].as_str().map(String::from),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
        clone_url: v["clone_url"].as_str().unwrap_or("").to_string(),
        default_branch: v["default_branch"].as_str().unwrap_or("main").to_string(),
        language: v["language"].as_str().map(String::from),
        stargazers_count: v["stargazers_count"].as_u64().unwrap_or(0),
        forks_count: v["forks_count"].as_u64().unwrap_or(0),
        open_issues_count: v["open_issues_count"].as_u64().unwrap_or(0),
        license: v["license"]["spdx_id"].as_str().map(String::from),
        topics: v["topics"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
    }
}

/// Allowed sort axes for `github_search_repos`. Mirrors the GitHub
/// Search REST API. `"best_match"` omits the `sort` query param so
/// GitHub uses its default relevance ranking.
const SEARCH_SORT_VALUES: &[&str] = &["best_match", "stars", "forks", "updated"];

/// Search public repositories on GitHub.
///
/// Reuses the user's connection token if present (5000 req/h limit).
/// Falls back to unauthenticated requests when no token is on file
/// (10 req/min limit). The response's `authenticated` field reports
/// which path ran so the UI can warn the user about rate limits.
#[command]
pub async fn github_search_repos(
    query: String,
    sort: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<RepoSearchResponse, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("query must not be empty".to_string());
    }
    let sort_param = sort.as_deref().unwrap_or("best_match");
    if !SEARCH_SORT_VALUES.contains(&sort_param) {
        return Err(format!(
            "invalid sort: {sort_param} (expected one of {SEARCH_SORT_VALUES:?})"
        ));
    }
    let page = page.unwrap_or(1).max(1);
    let per_page = per_page.unwrap_or(20).clamp(1, 100);
    let token = find_https_credential().ok().flatten().map(|c| c.token);
    let authenticated = token.is_some();

    let escaped_query = urlencoding::encode(trimmed);
    let mut url = format!(
        "https://api.github.com/search/repositories?q={escaped_query}&page={page}&per_page={per_page}"
    );
    if sort_param != "best_match" {
        url.push_str(&format!("&sort={sort_param}&order=desc"));
    }

    let http = reqwest::Client::new();
    let mut req = http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "ORGII-Desktop/1.0");
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    let resp = req
        .send()
        .await
        .map_err(|err| format!("GitHub search request failed: {err}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|err| format!("Failed to read search response body: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "GitHub search failed ({}): {body}",
            status.as_u16()
        ));
    }
    let data: Value =
        serde_json::from_str(&body).map_err(|err| format!("Failed to parse search JSON: {err}"))?;
    let items: Vec<SearchRepo> = data["items"]
        .as_array()
        .map(|arr| arr.iter().map(parse_search_repo).collect())
        .unwrap_or_default();
    Ok(RepoSearchResponse {
        total_count: data["total_count"].as_u64().unwrap_or(0),
        incomplete_results: data["incomplete_results"].as_bool().unwrap_or(false),
        items,
        authenticated,
    })
}

#[command]
pub async fn github_list_repos(
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<Vec<Repo>, String> {
    log::info!("[GitHub][Cmd] list_repos page={page:?}");
    let client = make_client()?;
    let p = page.unwrap_or(1);
    let pp = per_page.unwrap_or(30).min(100);
    let data = client
        .get(&format!(
            "/user/repos?page={p}&per_page={pp}&sort=updated&affiliation=owner,collaborator"
        ))
        .await?;
    let repos: Vec<Repo> = data
        .as_array()
        .map(|arr| arr.iter().map(parse_repo).collect())
        .unwrap_or_default();
    log::info!("[GitHub][Cmd] list_repos returned {} repos", repos.len());
    Ok(repos)
}

#[command]
pub async fn github_list_branches(repo_full_name: String) -> Result<Vec<Branch>, String> {
    log::info!("[GitHub][Cmd] list_branches repo={repo_full_name}");
    let client = make_client()?;
    let data = client
        .get(&format!("/repos/{repo_full_name}/branches?per_page=100"))
        .await?;
    let branches: Vec<Branch> = data
        .as_array()
        .map(|arr| arr.iter().map(parse_branch).collect())
        .unwrap_or_default();
    log::info!(
        "[GitHub][Cmd] list_branches returned {} branches",
        branches.len()
    );
    Ok(branches)
}

#[command]
pub async fn github_create_branch(
    repo_full_name: String,
    branch_name: String,
    from_sha: String,
) -> Result<String, String> {
    log::info!("[GitHub][Cmd] create_branch repo={repo_full_name} branch={branch_name}");
    let client = make_client()?;
    let data = client
        .post(
            &format!("/repos/{repo_full_name}/git/refs"),
            json!({
                "ref": format!("refs/heads/{branch_name}"),
                "sha": from_sha
            }),
        )
        .await?;
    let sha = data["object"]["sha"].as_str().unwrap_or("").to_string();
    log::info!("[GitHub][Cmd] create_branch done sha={sha}");
    Ok(sha)
}

/// A file's raw content at a specific ref, for the PR "Files changed" diff
/// viewer. Read directly from the GitHub Contents API by commit SHA, so the
/// diff auto-loads without a local clone or `git fetch`.
#[derive(Debug, Serialize)]
pub struct GitHubFileContent {
    /// UTF-8 text, or empty when `is_binary` / `truncated`.
    pub content: String,
    pub is_binary: bool,
    pub truncated: bool,
}

/// Files larger than this are reported as `truncated` rather than pulled into
/// memory. Source files in a PR diff are virtually always well under this.
const CONTENT_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Fetch a file's raw content at `git_ref` (a commit SHA) via the Contents
/// API raw media type. Non-UTF-8 payloads are reported as `is_binary`.
#[command]
pub async fn github_get_content(
    repo_full_name: String,
    path: String,
    git_ref: String,
) -> Result<GitHubFileContent, String> {
    log::info!("[GitHub][Cmd] get_content repo={repo_full_name} path={path} ref={git_ref}");
    let client = make_client()?;
    // Encode each path segment but keep the `/` separators intact.
    let encoded_path = path
        .split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let encoded_ref = urlencoding::encode(&git_ref);
    let bytes = client
        .get_raw(
            &format!("/repos/{repo_full_name}/contents/{encoded_path}?ref={encoded_ref}"),
            "application/vnd.github.raw",
        )
        .await?;

    if bytes.len() > CONTENT_MAX_BYTES {
        return Ok(GitHubFileContent {
            content: String::new(),
            is_binary: false,
            truncated: true,
        });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(GitHubFileContent {
            content: text,
            is_binary: false,
            truncated: false,
        }),
        Err(_) => Ok(GitHubFileContent {
            content: String::new(),
            is_binary: true,
            truncated: false,
        }),
    }
}
