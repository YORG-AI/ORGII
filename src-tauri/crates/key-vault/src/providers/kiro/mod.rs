//! Kiro CLI OAuth Token Validation
//!
//! Validates Kiro OAuth tokens stored in:
//! - macOS: Keychain (service="kirocli:odic:token") or ~/Library/Application Support/kiro-cli/data.sqlite3
//! - Linux: Secret Service/Keyring or ~/.local/share/kiro-cli/data.sqlite3
//! - Windows: Credential Manager or %APPDATA%/kiro-cli/data.sqlite3
//!
//! Token format:
//! {
//!     "access_token": "aoaAAAAA...",
//!     "refresh_token": "aorAAAAA...",
//!     "expires_at": "2026-01-29T22:56:22.94049Z",
//!     "region": "us-east-1",
//!     "start_url": "https://d-xxx.awsapps.com/start",
//!     "oauth_flow": "PKCE",
//!     "scopes": ["codewhisperer:completions", ...]
//! }

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

use crate::types::ValidationResult;

// Kiro token storage keys
pub const KIRO_TOKEN_KEY: &str = "kirocli:odic:token";
const KIRO_DEVICE_REG_KEY: &str = "kirocli:odic:device-registration";

/// Kiro OAuth token structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KiroToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<String>,
    pub region: Option<String>,
    pub start_url: Option<String>,
    pub oauth_flow: Option<String>,
    pub scopes: Option<Vec<String>>,
    // Device registration (needed for server-side refresh)
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

impl KiroToken {
    /// Check if the access token is expired
    pub fn is_expired(&self) -> bool {
        if let Some(ref expires_at) = self.expires_at {
            // Parse ISO 8601 format: "2026-01-29T22:56:22.94049Z"
            if let Ok(exp_time) = DateTime::parse_from_rfc3339(expires_at) {
                return Utc::now() >= exp_time;
            }
            // Try without fractional seconds
            let normalized = expires_at.replace("Z", "+00:00");
            if let Ok(exp_time) = DateTime::parse_from_rfc3339(&normalized) {
                return Utc::now() >= exp_time;
            }
        }
        // If we can't parse, assume expired
        true
    }
}

/// Kiro credential validator
pub struct KiroValidator {
    #[allow(dead_code)]
    timeout: Duration,
}

impl Default for KiroValidator {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
        }
    }
}

impl KiroValidator {
    /// Create a new validator with default settings
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new validator with custom timeout
    pub fn with_timeout(timeout_secs: u64) -> Self {
        Self {
            timeout: Duration::from_secs(timeout_secs),
        }
    }

    /// Validate a Kiro OAuth token
    ///
    /// # Arguments
    /// * `token_json` - Full token JSON string, or just the access_token
    ///
    /// # Returns
    /// ValidationResult with account info
    pub async fn validate(&self, token_json: &str) -> ValidationResult {
        if token_json.is_empty() {
            return ValidationResult::failure("No token provided");
        }

        // Try to parse as JSON first
        let token: KiroToken = if token_json.trim().starts_with('{') {
            match serde_json::from_str(token_json) {
                Ok(t) => t,
                Err(e) => {
                    return ValidationResult::failure(&format!("Invalid token JSON: {}", e));
                }
            }
        } else {
            // Assume it's just the access token
            KiroToken {
                access_token: token_json.to_string(),
                refresh_token: None,
                expires_at: None,
                region: Some("us-east-1".to_string()),
                start_url: None,
                oauth_flow: None,
                scopes: None,
                client_id: None,
                client_secret: None,
            }
        };

        // Check if token is expired
        if token.is_expired() {
            if token.refresh_token.is_some() {
                let mut result = ValidationResult::failure(
                    "Token expired. Use refresh_token to get new access_token.",
                );
                result.provider_response = format!(
                    "{{\"has_refresh_token\":true,\"region\":\"{}\",\"start_url\":\"{}\"}}",
                    token.region.as_deref().unwrap_or("us-east-1"),
                    token.start_url.as_deref().unwrap_or("")
                );
                return result;
            } else {
                return ValidationResult::failure("Token expired and no refresh token available");
            }
        }

        // Validate token by running kiro-cli-chat whoami
        use std::process::Command;

        let mut whoami_command = Command::new("kiro-cli-chat");
        whoami_command.args(["whoami"]);
        // Suppress the console window on Windows.
        app_platform::hide_console(&mut whoami_command);
        match whoami_command.output() {
            Ok(output) if output.status.success() => {
                // Token is valid - whoami succeeded
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let error_msg = if !stderr.is_empty() {
                    stderr.trim().to_string()
                } else if !stdout.is_empty() {
                    stdout.trim().to_string()
                } else {
                    "Token validation failed".to_string()
                };
                return ValidationResult::failure(&format!("Kiro token invalid: {}", error_msg));
            }
            Err(err) => {
                return ValidationResult::failure(&format!(
                    "Could not run kiro-cli-chat: {}. Is Kiro CLI installed?",
                    err
                ));
            }
        }

        // Token is valid — models derived from backend reference prices
        let mut result = ValidationResult::success("Kiro token valid");

        result.provider_response = format!(
            "{{\"region\":\"{}\",\"start_url\":\"{}\",\"oauth_flow\":\"{}\",\"has_refresh_token\":{}}}",
            token.region.as_deref().unwrap_or("us-east-1"),
            token.start_url.as_deref().unwrap_or(""),
            token.oauth_flow.as_deref().unwrap_or("PKCE"),
            token.refresh_token.is_some()
        );
        result
    }

    /// Validate token format (fast check, no API calls)
    pub fn validate_format(&self, token: &str) -> (bool, String) {
        if token.is_empty() {
            return (false, "Token is empty".to_string());
        }

        // Check if it's a JSON token
        if token.trim().starts_with('{') {
            match serde_json::from_str::<KiroToken>(token) {
                Ok(t) => {
                    if t.access_token.is_empty() {
                        return (false, "Token JSON missing access_token".to_string());
                    }
                    // Check Kiro token prefix
                    if t.access_token.starts_with("aoa") || t.access_token.starts_with("aor") {
                        return (true, "Valid Kiro OAuth token format".to_string());
                    }
                    return (true, "Valid token JSON (unknown format)".to_string());
                }
                Err(e) => {
                    return (false, format!("Invalid JSON: {}", e));
                }
            }
        }

        // Check raw token format
        if token.starts_with("aoa") {
            return (true, "Valid Kiro access token format".to_string());
        }
        if token.starts_with("aor") {
            return (true, "Valid Kiro refresh token format".to_string());
        }

        (
            false,
            "Unknown token format. Expected Kiro OAuth token (starts with 'aoa' or 'aor') or JSON"
                .to_string(),
        )
    }
}

/// Get available Kiro models
/// Returns empty — models are derived from backend reference prices (tunables.py kiro section)
pub fn get_kiro_models() -> Vec<String> {
    Vec::new()
}

/// Get the Kiro SQLite database path for the current platform
pub fn get_kiro_sqlite_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        let path = home.join("Library/Application Support/kiro-cli/data.sqlite3");
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try XDG_DATA_HOME first
        if let Ok(xdg_data) = std::env::var("XDG_DATA_HOME") {
            let path = PathBuf::from(xdg_data).join("kiro-cli/data.sqlite3");
            if path.exists() {
                return Some(path);
            }
        }
        // Fall back to ~/.local/share
        if let Some(home) = dirs::home_dir() {
            let path = home.join(".local/share/kiro-cli/data.sqlite3");
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let path = PathBuf::from(appdata).join("kiro-cli/data.sqlite3");
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
}

/// Read Kiro token from macOS Keychain
#[cfg(target_os = "macos")]
pub fn read_token_from_macos_keychain() -> Option<KiroToken> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", KIRO_TOKEN_KEY, "-w"])
        .output()
        .ok()?;

    if output.status.success() {
        let token_json = String::from_utf8(output.stdout).ok()?;
        let token_json = token_json.trim();
        if !token_json.is_empty() {
            return match serde_json::from_str(token_json) {
                Ok(t) => Some(t),
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        len = token_json.len(),
                        "kiro::read_token_from_macos_keychain: token JSON parse failed (schema drift or corruption); skipping"
                    );
                    None
                }
            };
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
pub fn read_token_from_macos_keychain() -> Option<KiroToken> {
    None
}

/// Read Kiro token from SQLite database
pub fn read_token_from_sqlite(db_path: &std::path::Path) -> Option<KiroToken> {
    let conn = rusqlite::Connection::open(db_path).ok()?;
    let mut stmt = conn
        .prepare("SELECT value FROM auth_kv WHERE key = ?")
        .ok()?;
    let token_json: String = stmt.query_row([KIRO_TOKEN_KEY], |row| row.get(0)).ok()?;
    match serde_json::from_str(&token_json) {
        Ok(t) => Some(t),
        Err(err) => {
            tracing::warn!(
                error = %err,
                len = token_json.len(),
                "kiro::read_token_from_sqlite: token JSON parse failed (schema drift or corruption); skipping"
            );
            None
        }
    }
}

/// Device registration structure (for OAuth client credentials)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRegistration {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

/// Read device registration from SQLite
fn read_device_reg_from_sqlite(db_path: &std::path::Path) -> Option<DeviceRegistration> {
    let conn = rusqlite::Connection::open(db_path).ok()?;
    let mut stmt = conn
        .prepare("SELECT value FROM auth_kv WHERE key = ?")
        .ok()?;
    let json: String = stmt
        .query_row([KIRO_DEVICE_REG_KEY], |row| row.get(0))
        .ok()?;
    match serde_json::from_str(&json) {
        Ok(reg) => Some(reg),
        Err(err) => {
            tracing::warn!(
                error = %err,
                len = json.len(),
                "kiro::read_device_reg_from_sqlite: device-registration JSON parse failed (schema drift or corruption); skipping"
            );
            None
        }
    }
}

/// Read device registration from macOS Keychain
#[cfg(target_os = "macos")]
fn read_device_reg_from_macos_keychain() -> Option<DeviceRegistration> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", KIRO_DEVICE_REG_KEY, "-w"])
        .output()
        .ok()?;

    if output.status.success() {
        let json = String::from_utf8(output.stdout).ok()?;
        let json = json.trim();
        if !json.is_empty() {
            return match serde_json::from_str(json) {
                Ok(reg) => Some(reg),
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        len = json.len(),
                        "kiro::read_device_reg_from_macos_keychain: device-registration JSON parse failed (schema drift or corruption); skipping"
                    );
                    None
                }
            };
        }
    }
    None
}

/// Get device registration from local storage
fn get_device_registration() -> Option<DeviceRegistration> {
    // Try SQLite first
    if let Some(db_path) = get_kiro_sqlite_path() {
        if let Some(reg) = read_device_reg_from_sqlite(&db_path) {
            return Some(reg);
        }
    }

    // Fall back to macOS Keychain
    #[cfg(target_os = "macos")]
    {
        if let Some(reg) = read_device_reg_from_macos_keychain() {
            return Some(reg);
        }
    }

    None
}

/// Get Kiro token from local storage (Keychain/Keyring/SQLite)
/// Includes device registration (client_id/client_secret) for server-side refresh
pub fn get_local_kiro_token() -> Option<KiroToken> {
    let mut token = None;

    // Try SQLite first - kiro-cli updates this on token refresh
    if let Some(db_path) = get_kiro_sqlite_path() {
        token = read_token_from_sqlite(&db_path);
    }

    // Fall back to platform-specific secure storage
    #[cfg(target_os = "macos")]
    if token.is_none() {
        token = read_token_from_macos_keychain();
    }

    // Add device registration for server-side refresh capability
    if let Some(mut tok) = token {
        if let Some(reg) = get_device_registration() {
            tok.client_id = reg.client_id;
            tok.client_secret = reg.client_secret;
        }
        return Some(tok);
    }

    None
}

/// Detect Kiro tokens from local storage
pub fn detect_kiro_tokens() -> Vec<KiroToken> {
    let mut tokens = Vec::new();

    if let Some(token) = get_local_kiro_token() {
        tokens.push(token);
    }

    tokens
}

#[cfg(test)]
#[path = "../tests/kiro_tests.rs"]
mod tests;
