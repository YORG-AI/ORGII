use std::collections::HashMap;
use std::env;
use std::fs;
#[cfg(target_os = "macos")]
use std::path::Path;
use std::path::PathBuf;

use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;

use super::helpers::{
    create_detected_key, extract_export_value, get_claude_config_paths, get_home_dir,
    validate_anthropic_key, ClaudeConfig,
};
use super::DetectedKey;

const CLAUDE_CODE_REFRESH_TOKEN_ENV: &str = "CLAUDE_CODE_REFRESH_TOKEN";
const CLAUDE_CODE_EXPIRES_AT_ENV: &str = "CLAUDE_CODE_EXPIRES_AT";
const CLAUDE_CODE_EXPIRES_IN_ENV: &str = "CLAUDE_CODE_EXPIRES_IN";
const CLAUDE_CODE_TOKEN_REFRESH_SKEW_SECONDS: i64 = 60;
const CLAUDE_CODE_OAUTH_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_CODE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_CODE_OAUTH_USER_AGENT: &str = "claude-cli/2.1.78 (orgii, cli)";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeAiOauthCredentials>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAiOauthCredentials {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    #[allow(dead_code)]
    scopes: Option<Vec<String>>,
    #[allow(dead_code)]
    subscription_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthProfileResponse {
    account: Option<ClaudeCodeOauthProfileAccount>,
    organization: Option<ClaudeCodeOauthProfileOrganization>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthProfileAccount {
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeOauthProfileOrganization {
    uuid: Option<String>,
    name: Option<String>,
    organization_type: Option<String>,
    rate_limit_tier: Option<String>,
}

#[derive(Debug, Clone)]
struct ClaudeCodeAccountIdentity {
    email: Option<String>,
    organization_uuid: Option<String>,
    organization_name: Option<String>,
    organization_type: Option<String>,
    rate_limit_tier: Option<String>,
}

/// Detect Claude Code API keys and OAuth sessions from local config and environment
pub(super) async fn detect_claude_keys() -> Vec<DetectedKey> {
    let mut keys = vec![];

    if let Some(oauth) = detect_claude_code_oauth().await {
        return vec![oauth];
    }

    // Environment variable names to check (in priority order)
    let env_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

    // 1. Check runtime environment variables
    for env_name in &env_vars {
        if let Ok(api_key) = env::var(env_name) {
            if !api_key.is_empty() {
                let base_url = env::var("ANTHROPIC_BASE_URL").ok();
                let mut cred = create_detected_key(
                    &format!("env_{}", env_name.to_lowercase()),
                    &format!("Environment Variable ({})", env_name),
                    "api_key",
                );
                cred.api_key = Some(api_key.clone());
                cred.base_url = base_url.clone();

                // Validate the key
                let validation = validate_anthropic_key(&api_key, base_url.as_deref()).await;
                cred.validated = Some(validation.0);
                cred.validation_message = validation.1;
                cred.available_models = validation.2;

                keys.push(cred);
                break; // Only use first found
            }
        }
    }

    // 2. Check shell config files (~/.zshrc, ~/.bashrc, ~/.bash_profile)
    // This is useful when GUI apps don't inherit shell environment
    if keys.is_empty() {
        if let Some(cred) = read_anthropic_from_shell_config().await {
            keys.push(cred);
        }
    }

    // 3. Check JSON config files
    let config_paths = get_claude_config_paths();
    for path in config_paths {
        if let Some(cred) = read_claude_config(&path).await {
            // Don't add duplicate keys
            let already_has = keys
                .iter()
                .any(|c| c.api_key.as_ref() == cred.api_key.as_ref());
            if !already_has {
                keys.push(cred);
            }
        }
    }

    keys
}

/// Parse shell config files for Anthropic keys
/// Looks for: export ANTHROPIC_API_KEY=xxx or export ANTHROPIC_AUTH_TOKEN=xxx
async fn read_anthropic_from_shell_config() -> Option<DetectedKey> {
    let home = get_home_dir()?;

    // Shell config files to check (in priority order)
    let shell_configs = [
        home.join(".zshrc"),
        home.join(".bashrc"),
        home.join(".bash_profile"),
        home.join(".profile"),
    ];

    let env_vars = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

    for config_path in &shell_configs {
        if let Ok(content) = fs::read_to_string(config_path) {
            // Try to find API key
            for env_name in &env_vars {
                if let Some(api_key) = extract_export_value(&content, env_name) {
                    if !api_key.is_empty() {
                        // Also try to extract base URL
                        let base_url = extract_export_value(&content, "ANTHROPIC_BASE_URL");

                        let config_name = config_path.file_name()?.to_string_lossy();
                        let mut cred = create_detected_key(
                            &format!("shell_{}", config_name.replace('.', "_")),
                            &format!("Shell Config (~/{}) - {}", config_name, env_name),
                            "api_key",
                        );
                        cred.api_key = Some(api_key.clone());
                        cred.base_url = base_url.clone();

                        // Validate the key
                        let validation =
                            validate_anthropic_key(&api_key, base_url.as_deref()).await;
                        cred.validated = Some(validation.0);
                        cred.validation_message = validation.1;
                        cred.available_models = validation.2;

                        return Some(cred);
                    }
                }
            }
        }
    }

    None
}

async fn read_claude_config(path: &std::path::PathBuf) -> Option<DetectedKey> {
    // A missing config file is a normal "no detection" outcome and stays
    // silent (Rule 6 — missing ⇒ empty). Read errors and JSON-parse
    // errors instead surface via `warn!` so a corrupt or unreadable
    // config file is visible to the user instead of silently producing
    // a "no Claude key found" result that the user can't debug.
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "auto_detect::claude: config read failed; skipping"
            );
            return None;
        }
    };
    let config: ClaudeConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "auto_detect::claude: config JSON parse failed; skipping"
            );
            return None;
        }
    };
    let api_key = config.api_key?;

    if api_key.is_empty() {
        return None;
    }

    let mut cred = create_detected_key(
        &format!("file_{}", path.file_name()?.to_string_lossy()),
        &format!("Config File ({})", path.display()),
        "api_key",
    );
    cred.api_key = Some(api_key.clone());
    cred.base_url = config.base_url.clone();

    // Validate
    let validation = validate_anthropic_key(&api_key, config.base_url.as_deref()).await;
    cred.validated = Some(validation.0);
    cred.validation_message = validation.1;
    cred.available_models = validation.2;

    Some(cred)
}

async fn detect_claude_code_oauth() -> Option<DetectedKey> {
    #[cfg(windows)]
    // Credential Manager can require multiple bounded reads for Claude's
    // chunked format, so keep all local credential I/O off the async executor.
    let credentials_json = match tokio::task::spawn_blocking(read_local_claude_credentials).await {
        Ok(credentials) => credentials?,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "auto_detect::claude: local OAuth credential task failed; skipping"
            );
            return None;
        }
    };
    #[cfg(not(windows))]
    let credentials_json = read_local_claude_credentials()?;
    let credentials = parse_claude_oauth_credentials(&credentials_json)?;
    let access_token = credentials.access_token?.trim().to_string();
    if access_token.is_empty() {
        return None;
    }

    let mut credential = create_detected_key("claude_code_oauth_local", "Anthropic", "oauth");
    credential.session_token = Some(access_token.clone());

    let mut env_vars = HashMap::new();
    if let Some(refresh_token) = credentials
        .refresh_token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
    {
        env_vars.insert(CLAUDE_CODE_REFRESH_TOKEN_ENV.to_string(), refresh_token);
    }
    if let Some(expires_at) = credentials.expires_at {
        let expires_at_millis = expires_at as i64;
        env_vars.insert(
            CLAUDE_CODE_EXPIRES_AT_ENV.to_string(),
            expires_at_millis.to_string(),
        );
        let expires_in = ((expires_at_millis - Utc::now().timestamp_millis()) / 1000).max(0);
        env_vars.insert(
            CLAUDE_CODE_EXPIRES_IN_ENV.to_string(),
            expires_in.to_string(),
        );
    }
    if !env_vars.is_empty() {
        credential.env_vars = Some(env_vars);
    }

    let validation = validate_claude_code_oauth_token(&access_token, credentials.expires_at).await;
    credential.validated = Some(validation.0);
    credential.validation_message = validation.1;
    credential.available_models = validation.2;

    if let Some(identity) = fetch_claude_code_oauth_identity(&access_token).await {
        credential.name = claude_code_account_name(&identity);
        let metadata = claude_code_account_metadata(identity);
        if !metadata.is_empty() {
            credential.account_metadata = Some(metadata);
        }
    }

    Some(credential)
}

fn read_local_claude_credentials() -> Option<String> {
    if let Some(credentials_json) = read_claude_keychain_credentials() {
        return Some(credentials_json);
    }

    for path in get_claude_credentials_paths() {
        match fs::read_to_string(&path) {
            Ok(contents) if !contents.trim().is_empty() => return Some(contents),
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "auto_detect::claude: local OAuth credentials read failed; skipping"
                );
            }
        }
    }

    None
}

#[cfg(windows)]
fn get_claude_credentials_paths() -> Vec<PathBuf> {
    let mut paths = vec![];
    if let Ok(config_dir) = env::var(super::claude_windows::CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV) {
        let trimmed = config_dir.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed).join(".credentials.json"));
        }
    }
    if let Ok(config_dir) = env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = config_dir.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed).join(".credentials.json");
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    if let Some(home) = get_home_dir() {
        let path = home.join(".claude/.credentials.json");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

#[cfg(not(windows))]
fn get_claude_credentials_paths() -> Vec<PathBuf> {
    let mut paths = vec![];
    if let Ok(config_dir) = env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = config_dir.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed).join(".credentials.json"));
        }
    }
    if let Some(home) = get_home_dir() {
        paths.push(home.join(".claude/.credentials.json"));
    }
    paths
}

fn parse_claude_oauth_credentials(credentials_json: &str) -> Option<ClaudeAiOauthCredentials> {
    let parsed: ClaudeCredentialsFile = match serde_json::from_str(credentials_json) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "auto_detect::claude: local OAuth credentials JSON parse failed; skipping"
            );
            return None;
        }
    };
    parsed.claude_ai_oauth
}

async fn validate_claude_code_oauth_token(
    _access_token: &str,
    expires_at: Option<u64>,
) -> (bool, Option<String>, Option<Vec<String>>) {
    if token_is_expired(expires_at) {
        return (
            false,
            Some("Claude Code local OAuth token is expired. Sign in again or use a refreshable account.".to_string()),
            None,
        );
    }

    // Local detection only establishes that a non-expired OAuth credential is
    // present. The wizard resolves the account-visible catalog exactly once
    // through `oauth_model_catalog` after the user selects this credential.
    (
        true,
        Some("Valid Claude Code OAuth login".to_string()),
        None,
    )
}

fn token_is_expired(expires_at: Option<u64>) -> bool {
    let Some(expires_at_millis) = expires_at else {
        return false;
    };
    let expires_at = chrono::DateTime::<Utc>::from_timestamp_millis(expires_at_millis as i64);
    let Some(expires_at) = expires_at else {
        return false;
    };
    Utc::now() + ChronoDuration::seconds(CLAUDE_CODE_TOKEN_REFRESH_SKEW_SECONDS) >= expires_at
}

async fn fetch_claude_code_oauth_identity(access_token: &str) -> Option<ClaudeCodeAccountIdentity> {
    match fetch_claude_code_oauth_profile(access_token).await {
        Ok(identity) => Some(identity),
        Err(err) => {
            tracing::warn!(
                error = %err,
                "auto_detect::claude: OAuth profile lookup failed; continuing without identity metadata"
            );
            None
        }
    }
}

async fn fetch_claude_code_oauth_profile(
    access_token: &str,
) -> Result<ClaudeCodeAccountIdentity, String> {
    let response = reqwest::Client::new()
        .get(CLAUDE_CODE_OAUTH_PROFILE_URL)
        .header("Authorization", format!("Bearer {}", access_token.trim()))
        .header("anthropic-beta", CLAUDE_CODE_OAUTH_BETA)
        .header("User-Agent", CLAUDE_CODE_OAUTH_USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|err| format!("Claude Code OAuth profile request failed: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Claude Code OAuth profile body read failed: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "Claude Code OAuth profile failed: HTTP {}: {}",
            status.as_u16(),
            body
        ));
    }

    parse_claude_code_oauth_profile_response(&body)
}

fn parse_claude_code_oauth_profile_response(
    body: &str,
) -> Result<ClaudeCodeAccountIdentity, String> {
    let parsed: ClaudeCodeOauthProfileResponse = serde_json::from_str(body)
        .map_err(|err| format!("Claude Code OAuth profile parse failed: {err}"))?;
    let account = parsed.account;
    let organization = parsed.organization;
    Ok(ClaudeCodeAccountIdentity {
        email: account.and_then(|account| normalize_metadata_field(account.email)),
        organization_uuid: organization
            .as_ref()
            .and_then(|organization| normalize_metadata_field(organization.uuid.clone())),
        organization_name: organization
            .as_ref()
            .and_then(|organization| normalize_metadata_field(organization.name.clone())),
        organization_type: organization.as_ref().and_then(|organization| {
            normalize_metadata_field(organization.organization_type.clone())
        }),
        rate_limit_tier: organization
            .and_then(|organization| normalize_metadata_field(organization.rate_limit_tier)),
    })
}

fn normalize_metadata_field(value: Option<String>) -> Option<String> {
    value
        .map(|field| field.trim().to_string())
        .filter(|field| !field.is_empty())
}

fn claude_code_account_name(_identity: &ClaudeCodeAccountIdentity) -> String {
    "Anthropic".to_string()
}

fn claude_code_account_metadata(identity: ClaudeCodeAccountIdentity) -> HashMap<String, String> {
    let mut metadata = HashMap::new();
    if let Some(email) = identity.email {
        metadata.insert("email".to_string(), email);
    }
    if let Some(organization_uuid) = identity.organization_uuid {
        metadata.insert("organization_uuid".to_string(), organization_uuid);
    }
    if let Some(organization_name) = identity.organization_name {
        metadata.insert("organization_name".to_string(), organization_name);
    }
    if let Some(organization_type) = identity.organization_type {
        metadata.insert("organization_type".to_string(), organization_type);
    }
    if let Some(rate_limit_tier) = identity.rate_limit_tier {
        metadata.insert("rate_limit_tier".to_string(), rate_limit_tier);
    }
    metadata
}

#[cfg(target_os = "macos")]
fn read_claude_keychain_credentials() -> Option<String> {
    let config_dirs = get_claude_keychain_config_dirs();
    let mut services = Vec::new();
    for config_dir in config_dirs {
        services.push(scoped_claude_keychain_service(&config_dir));
    }
    services.push("Claude Code-credentials".to_string());

    let account = env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_string());
    for service in services {
        if let Some(credentials) = read_macos_keychain_password(&service, &account) {
            return Some(credentials);
        }
    }
    None
}

#[cfg(windows)]
fn read_claude_keychain_credentials() -> Option<String> {
    super::claude_windows::read_credentials()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_claude_keychain_credentials() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn get_claude_keychain_config_dirs() -> Vec<PathBuf> {
    let mut config_dirs = Vec::new();
    if let Ok(config_dir) = env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = config_dir.trim();
        if !trimmed.is_empty() {
            config_dirs.push(PathBuf::from(trimmed));
        }
    }
    if let Some(home) = get_home_dir() {
        config_dirs.push(home.join(".claude"));
    }
    config_dirs
}

#[cfg(target_os = "macos")]
fn scoped_claude_keychain_service(config_dir: &Path) -> String {
    use sha2::{Digest, Sha256};

    let suffix = Sha256::digest(config_dir.to_string_lossy().as_bytes());
    format!("Claude Code-credentials-{:x}", suffix)
        .chars()
        .take("Claude Code-credentials-".len() + 8)
        .collect()
}

#[cfg(target_os = "macos")]
fn read_macos_keychain_password(service: &str, account: &str) -> Option<String> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", service, "-a", account, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let password = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if password.is_empty() {
        None
    } else {
        Some(password)
    }
}
