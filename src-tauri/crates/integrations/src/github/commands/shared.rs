//! Shared helpers for the GitHub command modules.
//!
//! Token resolution against the centralized connection token store, and the
//! authenticated REST client constructor used by every command group.

use project_management::sync::git_credentials::find_https_credential;

use crate::github::client::GitHubClient;

/// Resolve the active HTTPS token, or return the canonical re-auth error.
pub(crate) fn resolve_token() -> Result<String, String> {
    match find_https_credential()? {
        Some(credential) => Ok(credential.token),
        None => Err("GitHubReAuthRequired: no git connection on file".to_string()),
    }
}

pub(crate) fn make_client() -> Result<GitHubClient, String> {
    Ok(GitHubClient::new(resolve_token()?))
}
