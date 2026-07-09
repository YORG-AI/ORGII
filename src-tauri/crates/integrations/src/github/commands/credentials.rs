//! Git credential lookup, repository cloning, and token validation.

use std::ffi::OsString;
use std::path::Path;

use serde::Serialize;
use tauri::command;

use git::git_command;
use project_management::sync::git_credentials::find_https_credential;

use super::repos::github_repo_full_name_from_remote;
use super::shared::{make_client, resolve_token};

#[derive(Debug, Serialize)]
pub struct GitHubGitCredential {
    pub username: String,
    pub token: String,
    pub repo_full_name: String,
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
