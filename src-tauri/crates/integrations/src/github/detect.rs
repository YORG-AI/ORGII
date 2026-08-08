//! GitHub Local Credential Detection
//!
//! Scans the user's system for existing GitHub credentials:
//! - gh CLI token from ~/.config/gh/hosts.yml
//! - SSH public keys from ~/.ssh/
//! - Git credential helper configuration

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::command;

use git::tokio_git_command;

// ============================================
// Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhCliCredential {
    pub username: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshKeyInfo {
    pub filename: String,
    pub key_type: String,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialHelperInfo {
    pub helper: String,
    pub username: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedGitHubCredentials {
    pub gh_cli: Option<GhCliCredential>,
    pub ssh_keys: Vec<SshKeyInfo>,
    pub credential_helper: Option<CredentialHelperInfo>,
    pub git_credentials_has_github: bool,
}

// ============================================
// Detection Command
// ============================================

#[command]
pub async fn detect_github_credentials() -> Result<DetectedGitHubCredentials, String> {
    log::info!("[GitHub][Detect] Starting local credential scan");

    let (gh_cli, ssh_keys, helper_name, git_credentials_has_github) = tokio::join!(
        detect_gh_cli(),
        detect_ssh_keys(),
        detect_credential_helper(),
        detect_git_credentials_file(),
    );

    let credential_helper = match helper_name {
        Some(helper) => {
            let probed = probe_credential_helper().await;
            Some(CredentialHelperInfo {
                helper,
                username: probed.as_ref().map(|(u, _)| u.clone()),
                token: probed.map(|(_, t)| t),
            })
        }
        None => None,
    };

    let result = DetectedGitHubCredentials {
        gh_cli,
        ssh_keys,
        credential_helper,
        git_credentials_has_github,
    };

    log::info!(
        "[GitHub][Detect] Done — gh_cli={}, ssh_keys={}, cred_helper={}, git_creds={}",
        result.gh_cli.is_some(),
        result.ssh_keys.len(),
        result.credential_helper.is_some(),
        result.git_credentials_has_github,
    );

    Ok(result)
}

// ============================================
// Detection Helpers
// ============================================

fn get_home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

async fn detect_gh_cli() -> Option<GhCliCredential> {
    let home = get_home_dir()?;
    let config_path = home.join(".config/gh/hosts.yml");
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let token = resolve_gh_cli_token().await?;
    let username = extract_gh_cli_username(&content).unwrap_or_default();

    Some(GhCliCredential { username, token })
}

/// Resolve the active GitHub CLI credential without persisting or logging it.
///
/// Modern `gh` installs keep OAuth tokens in the OS keychain, so `hosts.yml`
/// often contains only the username. Asking `gh` itself works for keychain and
/// file-backed installs while preserving the CLI's active-host behavior.
pub(crate) async fn resolve_gh_cli_token() -> Option<String> {
    let mut executables = vec![PathBuf::from("gh")];
    #[cfg(target_os = "macos")]
    executables.extend([
        PathBuf::from("/opt/homebrew/bin/gh"),
        PathBuf::from("/usr/local/bin/gh"),
    ]);

    for executable in executables {
        let mut command = tokio::process::Command::new(executable);
        command
            .args(["auth", "token", "--hostname", "github.com"])
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env_remove("GH_ENTERPRISE_TOKEN")
            .env_remove("GITHUB_ENTERPRISE_TOKEN")
            .env("GH_PROMPT_DISABLED", "1");
        let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(5), command.output()).await
        else {
            continue;
        };
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }

    let home = get_home_dir()?;
    let content = fs::read_to_string(home.join(".config/gh/hosts.yml")).ok()?;
    extract_gh_cli_token(&content)
}

pub(crate) fn extract_gh_cli_token(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("oauth_token:") {
            let token = trimmed.strip_prefix("oauth_token:")?.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    None
}

pub(crate) fn extract_gh_cli_username(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("user:") {
            let user = trimmed.strip_prefix("user:")?.trim();
            if !user.is_empty() {
                return Some(user.to_string());
            }
        }
    }
    None
}

async fn detect_ssh_keys() -> Vec<SshKeyInfo> {
    let home = match get_home_dir() {
        Some(h) => h,
        None => return vec![],
    };

    let ssh_dir = home.join(".ssh");
    let entries = match fs::read_dir(&ssh_dir) {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };

    let mut keys = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) if name.ends_with(".pub") => name.to_string(),
            _ => continue,
        };

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let parts: Vec<&str> = content.trim().splitn(3, ' ').collect();
        if parts.len() >= 2 {
            let key_type = parts[0].to_string();
            let comment = if parts.len() >= 3 {
                parts[2].trim().to_string()
            } else {
                String::new()
            };

            keys.push(SshKeyInfo {
                filename,
                key_type,
                comment,
            });
        }
    }

    keys
}

/// Probe the credential helper for a stored GitHub token via `git credential fill`.
async fn probe_credential_helper() -> Option<(String, String)> {
    let mut child = tokio_git_command()
        .ok()?
        .args(["credential", "fill"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin
            .write_all(b"protocol=https\nhost=github.com\n\n")
            .await;
        drop(stdin);
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .ok()?
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut username = None;
    let mut password = None;

    for line in stdout.lines() {
        if let Some(val) = line.strip_prefix("username=") {
            username = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("password=") {
            password = Some(val.to_string());
        }
    }

    match (username, password) {
        (Some(user), Some(token)) if !token.is_empty() => Some((user, token)),
        _ => None,
    }
}

async fn detect_credential_helper() -> Option<String> {
    let output = tokio_git_command()
        .ok()?
        .args(["config", "--get", "credential.helper"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let helper = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if helper.is_empty() {
        return None;
    }

    Some(helper)
}

async fn detect_git_credentials_file() -> bool {
    let home = match get_home_dir() {
        Some(h) => h,
        None => return false,
    };

    let creds_path = home.join(".git-credentials");
    let content = match fs::read_to_string(&creds_path) {
        Ok(c) => c,
        Err(_) => return false,
    };

    content.contains("github.com")
}

#[cfg(test)]
#[path = "tests/detect_tests.rs"]
mod tests;
