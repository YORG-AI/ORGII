//! GitHub Tauri Commands
//!
//! Exposes GitHub operations to the frontend via `invoke()`. Credentials
//! are resolved at command entry from the centralized connection token
//! store (see `project_management::sync::git_credentials`); the frontend
//! no longer passes user IDs or hosted-service tokens.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::Path;
use tauri::command;

use git::git_command;
use project_management::sync::git_credentials::find_https_credential;

use super::client::GitHubClient;

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

#[derive(Debug, Serialize)]
pub struct GitHubGitCredential {
    pub username: String,
    pub token: String,
    pub repo_full_name: String,
}

/// Resolve the active HTTPS token, or return the canonical re-auth error.
fn resolve_token() -> Result<String, String> {
    match find_https_credential()? {
        Some(credential) => Ok(credential.token),
        None => Err("GitHubReAuthRequired: no git connection on file".to_string()),
    }
}

fn make_client() -> Result<GitHubClient, String> {
    Ok(GitHubClient::new(resolve_token()?))
}

fn parse_repo(v: &Value) -> Repo {
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

fn parse_branch(v: &Value) -> Branch {
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
        .get(&format!(
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
    client
        .get(&format!("/repos/{repo_full_name}/pulls/{pr_number}"))
        .await
}

#[command]
pub async fn github_list_pr_commits(
    repo_full_name: String,
    pr_number: u64,
) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] list_pr_commits repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    client
        .get(&format!(
            "/repos/{repo_full_name}/pulls/{pr_number}/commits?per_page=100"
        ))
        .await
}

#[command]
pub async fn github_list_pr_files(repo_full_name: String, pr_number: u64) -> Result<Value, String> {
    log::info!("[GitHub][Cmd] list_pr_files repo={repo_full_name} pr={pr_number}");
    let client = make_client()?;
    client
        .get(&format!(
            "/repos/{repo_full_name}/pulls/{pr_number}/files?per_page=300"
        ))
        .await
}

/// Build the argv that `github_clone_repo` will pass to `git`.
///
/// Pulled out as a pure function so the unit tests below can assert that
/// (a) the OAuth token only ever appears inside the
/// `http.extraHeader=Authorization: Bearer …` config flag and never as a
/// CLI argument, in the URL, or anywhere else; and (b) `--depth 1` plus
/// `--branch <b> --single-branch` (when a branch is requested) are wired
/// correctly. Returns `OsString` so paths with non-UTF-8 components round
/// trip cleanly.
pub(crate) fn build_clone_argv(
    token: &str,
    repo_full_name: &str,
    target_dir: &Path,
    branch: Option<&str>,
) -> Vec<OsString> {
    let clean_url = format!("https://github.com/{repo_full_name}.git");
    let mut argv: Vec<OsString> = Vec::with_capacity(8);
    argv.push("-c".into());
    argv.push(format!("http.extraHeader=Authorization: Bearer {token}").into());
    argv.push("clone".into());
    argv.push("--depth".into());
    argv.push("1".into());
    if let Some(b) = branch {
        argv.push("--branch".into());
        argv.push(b.into());
        argv.push("--single-branch".into());
    }
    argv.push(clean_url.into());
    argv.push(target_dir.as_os_str().to_owned());
    argv
}

/// Format a clone-failure error string, redacting the token if `git`
/// happened to echo it back. Pulled out so the redaction logic is unit-
/// testable without spawning a subprocess.
pub(crate) fn clean_git_clone_error(token: &str, exit_code: Option<i32>, stderr: &[u8]) -> String {
    let stderr_str = String::from_utf8_lossy(stderr).replace(token, "***");
    format!(
        "git clone failed (exit {exit_code:?}): {}",
        stderr_str.trim()
    )
}

#[command]
pub async fn github_git_credential_for_remote(
    remote_url: String,
) -> Result<Option<GitHubGitCredential>, String> {
    let Some(repo_full_name) = github_repo_full_name_from_remote(&remote_url) else {
        return Ok(None);
    };
    let Some(credential) = find_https_credential()? else {
        return Ok(None);
    };
    Ok(Some(GitHubGitCredential {
        username: credential.username,
        token: credential.token,
        repo_full_name,
    }))
}

/// Clone a GitHub repository by shelling out to the system `git` CLI.
///
/// Why subprocess instead of libgit2:
/// - libgit2's HTTPS transport requires the `https` feature, which pulls
///   in `openssl-sys` + `openssl-src` (vendored OpenSSL build, ~1–2 GB of
///   C artifacts and a 30–60 s compile). ORGII already requires `git` on
///   PATH (every coding-agent flow assumes it; `git/bundle.rs` shells out
///   for `git bundle create`), so the in-process clone bought us nothing
///   except dep weight.
/// - The OAuth token is passed via `http.extraHeader` instead of being
///   embedded in the URL (`https://x-access-token:TOKEN@github.com/…`).
///   That keeps the token out of:
///   * the URL itself,
///   * `git`'s own log output and any inadvertent re-prints,
///   * the process command line visible in `ps`.
/// - `git` CLI auto-honors `~/.gitconfig`, `HTTP_PROXY`, system proxy
///   settings — strictly better proxy support than libgit2 had.
#[command]
pub async fn github_clone_repo(
    repo_full_name: String,
    target_dir: String,
    branch: Option<String>,
) -> Result<String, String> {
    log::info!("[GitHub][Cmd] clone_repo repo={repo_full_name} target={target_dir}");
    let token = resolve_token()?;
    let target = target_dir.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let argv = build_clone_argv(
            &token,
            &repo_full_name,
            Path::new(&target),
            branch.as_deref(),
        );
        let output = git_command()?
            .args(&argv)
            .output()
            .map_err(|err| format!("Failed to spawn bundled git clone: {err}"))?;
        if !output.status.success() {
            return Err(clean_git_clone_error(
                &token,
                output.status.code(),
                &output.stderr,
            ));
        }
        Ok(target)
    })
    .await
    .map_err(|err| format!("Clone task panicked: {err}"))?
}

/// Check whether a GitHub token is on file and accepted by `GET /user`.
#[command]
pub async fn github_check_token() -> Result<bool, String> {
    log::info!("[GitHub][Cmd] check_token");
    let client = match make_client() {
        Ok(client) => client,
        Err(err) if err.contains("GitHubReAuthRequired") => return Ok(false),
        Err(err) => return Err(err),
    };
    match client.get("/user").await {
        Ok(_) => Ok(true),
        Err(err) if err.contains("GitHubReAuthRequired") => Ok(false),
        Err(err) => Err(err),
    }
}

// ============================================
// Issues
// ============================================

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

#[derive(Debug, Serialize)]
pub struct GitHubIssueListResponse {
    pub issues: Vec<GitHubIssue>,
    pub total_count: u64,
    pub has_more: bool,
    pub next_page: Option<u32>,
}

fn parse_issue_user(v: &Value) -> IssueUser {
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
        milestone: v["milestone"]["title"].as_str().map(|s| s.to_string()),
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
        let raw_items = result.as_array().cloned().unwrap_or_default();
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
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
) -> Result<GitHubIssue, String> {
    log::info!("[GitHub][Cmd] update_issue repo={repo_full_name} issue={issue_number}");
    let client = make_client()?;
    let mut payload = serde_json::json!({});
    if let Some(t) = title {
        payload["title"] = serde_json::json!(t);
    }
    if let Some(b) = body {
        payload["body"] = serde_json::json!(b);
    }
    if let Some(s) = state {
        payload["state"] = serde_json::json!(s);
    }
    if let Some(sr) = state_reason {
        payload["state_reason"] = serde_json::json!(sr);
    }
    if let Some(l) = labels {
        payload["labels"] = serde_json::json!(l);
    }
    if let Some(a) = assignees {
        payload["assignees"] = serde_json::json!(a);
    }
    let result = client
        .patch(
            &format!("/repos/{repo_full_name}/issues/{issue_number}"),
            payload,
        )
        .await
        .map_err(|e| e.to_string())?;
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
pub async fn github_list_repo_collaborators(
    repo_full_name: String,
) -> Result<Vec<IssueUser>, String> {
    log::info!("[GitHub][Cmd] list_repo_collaborators repo={repo_full_name}");
    let client = make_client()?;
    let result = client
        .get(&format!(
            "/repos/{repo_full_name}/collaborators?per_page=100"
        ))
        .await
        .map_err(|e| e.to_string())?;
    Ok(result
        .as_array()
        .map(|arr| arr.iter().map(parse_issue_user).collect())
        .unwrap_or_default())
}

#[cfg(test)]
#[path = "tests/commands_tests.rs"]
mod tests;
