//! Claude Code OAuth token refresh: expiry detection plus the locked
//! refresh-token exchange that persists the rotated access token.

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};

use super::super::types::{AuthMethod, ModelKey, ModelType, OAuthRefreshOutcome};
use super::{KeyService, OAUTH_REFRESH_EXPIRY_SKEW_SECONDS, OAUTH_REFRESH_REQUEST_TIMEOUT};

const CLAUDE_CODE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE_ENV: &str = "CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE";
const CLAUDE_CODE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_REFRESH_TOKEN_ENV: &str = "CLAUDE_CODE_REFRESH_TOKEN";
const CLAUDE_CODE_EXPIRES_IN_ENV: &str = "CLAUDE_CODE_EXPIRES_IN";
const CLAUDE_CODE_EXPIRES_AT_ENV: &str = "CLAUDE_CODE_EXPIRES_AT";

#[derive(Debug, Serialize)]
struct ClaudeCodeRefreshRequest<'a> {
    grant_type: &'static str,
    refresh_token: &'a str,
    client_id: &'static str,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeRefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCodeRefreshErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
    message: Option<String>,
}

impl KeyService {
    pub fn claude_code_oauth_key_needs_refresh(&self, key: &ModelKey) -> bool {
        Self::claude_code_oauth_key_needs_refresh_inner(key)
    }

    fn claude_code_oauth_expires_at(key: &ModelKey) -> Option<chrono::DateTime<Utc>> {
        let expires_at_value = key.env_vars.get(CLAUDE_CODE_EXPIRES_AT_ENV)?;
        let expires_at_millis = expires_at_value.parse::<i64>().ok()?;
        chrono::DateTime::<Utc>::from_timestamp_millis(expires_at_millis)
    }

    fn claude_code_oauth_key_needs_refresh_inner(key: &ModelKey) -> bool {
        if key.model_type != ModelType::ClaudeCode || key.auth_method != AuthMethod::Oauth {
            return false;
        }
        if key
            .session_token
            .as_deref()
            .is_none_or(|token| token.trim().is_empty())
        {
            return true;
        }

        let Some(expires_at) = Self::claude_code_oauth_expires_at(key) else {
            return false;
        };

        Utc::now() + ChronoDuration::seconds(OAUTH_REFRESH_EXPIRY_SKEW_SECONDS) >= expires_at
    }

    pub async fn ensure_claude_code_oauth_key_fresh(
        &self,
        key_id: &str,
    ) -> Result<ModelKey, String> {
        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        let needs_refresh = Self::claude_code_oauth_key_needs_refresh_inner(&key);
        tracing::info!(
            "[key-vault] Claude Code OAuth preflight key={} name={:?} needs_refresh={} has_access={} has_refresh={} expires_at={:?} health={:?} failures={}",
            key_id,
            key.name,
            needs_refresh,
            key.session_token
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty()),
            key.env_vars
                .get(CLAUDE_CODE_REFRESH_TOKEN_ENV)
                .is_some_and(|token| !token.trim().is_empty()),
            Self::claude_code_oauth_expires_at(&key).map(|dt| dt.to_rfc3339()),
            key.health_status,
            key.oauth_refresh_failure_count
        );
        if !needs_refresh {
            return Ok(key);
        }

        let rejected_access_token = key.session_token.clone().unwrap_or_default();
        self.refresh_claude_code_oauth_key(key_id, &rejected_access_token)
            .await?
            .into_key()
            .ok_or_else(|| format!("Key {} is not a native Claude OAuth account", key_id))
    }

    /// Refresh a Claude Code OAuth key and persist the fresh access token.
    pub async fn refresh_claude_code_oauth_key(
        &self,
        key_id: &str,
        rejected_access_token: &str,
    ) -> Result<OAuthRefreshOutcome, String> {
        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if !key.is_native_oauth_for(&ModelType::ClaudeCode) {
            tracing::info!(
                "[key-vault] Claude Code OAuth refresh skipped key={} reason=not_claude_oauth type={:?} auth={:?}",
                key_id,
                key.model_type,
                key.auth_method
            );
            return Ok(OAuthRefreshOutcome::NotApplicable);
        }

        crate::e2e_guard::ensure_oauth_refresh_allowed()?;

        let refresh_lock = self.oauth_refresh_lock_for_key(key_id)?;
        let _refresh_guard = refresh_lock.lock().await;

        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        tracing::info!(
            "[key-vault] Claude Code OAuth refresh acquired lock key={} name={:?} has_access={} rejected_matches={} has_refresh={} expires_at={:?} health={:?} failures={}",
            key_id,
            key.name,
            key.session_token
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty()),
            key.session_token
                .as_deref()
                .is_some_and(|token| !token.is_empty() && token == rejected_access_token),
            key.env_vars
                .get(CLAUDE_CODE_REFRESH_TOKEN_ENV)
                .is_some_and(|token| !token.trim().is_empty()),
            Self::claude_code_oauth_expires_at(&key).map(|dt| dt.to_rfc3339()),
            key.health_status,
            key.oauth_refresh_failure_count
        );

        if !key.is_native_oauth_for(&ModelType::ClaudeCode) {
            tracing::info!(
                "[key-vault] Claude Code OAuth refresh skipped key={} reason=not_claude_oauth type={:?} auth={:?}",
                key_id,
                key.model_type,
                key.auth_method
            );
            return Ok(OAuthRefreshOutcome::NotApplicable);
        }

        if key
            .session_token
            .as_deref()
            .is_some_and(|token| !token.is_empty() && token != rejected_access_token)
        {
            tracing::info!(
                "[key-vault] Claude Code OAuth refresh skipped key={} reason=access_token_already_rotated",
                key_id
            );
            return Ok(OAuthRefreshOutcome::AlreadyRotated(Box::new(key)));
        }

        let refresh_token = key
            .env_vars
            .get(CLAUDE_CODE_REFRESH_TOKEN_ENV)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .ok_or_else(|| format!("Claude Code OAuth key {} has no refresh token", key_id))?;

        let request = ClaudeCodeRefreshRequest {
            grant_type: "refresh_token",
            refresh_token: &refresh_token,
            client_id: CLAUDE_CODE_CLIENT_ID,
        };

        let token_url_override = std::env::var(CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE_ENV).ok();
        let token_url = token_url_override
            .clone()
            .unwrap_or_else(|| CLAUDE_CODE_TOKEN_URL.to_string());
        tracing::info!(
            "[key-vault] Claude Code OAuth refresh request start key={} endpoint_override={} refresh_len={} access_len={}",
            key_id,
            std::env::var(CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE_ENV).is_ok(),
            refresh_token.len(),
            rejected_access_token.len()
        );

        let mut client_builder = reqwest::Client::builder().timeout(OAUTH_REFRESH_REQUEST_TIMEOUT);
        if token_url_override.is_some() {
            // Test/diagnostic override endpoints are commonly loopback. Do not
            // let inherited HTTP(S)_PROXY route 127.0.0.1 away from the local
            // one-shot server.
            client_builder = client_builder.no_proxy();
        }
        let response = match client_builder
            .build()
            .map_err(|err| format!("Claude Code OAuth refresh client build failed: {}", err))?
            .post(token_url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
            .header(
                reqwest::header::USER_AGENT,
                "claude-cli/1.0.56 (external, cli)",
            )
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .header(reqwest::header::REFERER, "https://claude.ai/")
            .header(reqwest::header::ORIGIN, "https://claude.ai")
            .json(&request)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                tracing::warn!(
                    "[key-vault] Claude Code OAuth refresh request transport error key={}: {}",
                    key_id,
                    err
                );
                let message = format!("Claude Code OAuth refresh request failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        let status = response.status();
        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => {
                tracing::warn!(
                    "[key-vault] Claude Code OAuth refresh response read error key={}: {}",
                    key_id,
                    err
                );
                let message = format!("Claude Code OAuth refresh response read failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };
        tracing::info!(
            "[key-vault] Claude Code OAuth refresh response key={} status={} body_len={}",
            key_id,
            status,
            body.len()
        );

        if !status.is_success() {
            let detail = serde_json::from_str::<ClaudeCodeRefreshErrorResponse>(&body)
                .ok()
                .and_then(|parsed| parsed.error_description.or(parsed.message).or(parsed.error))
                .unwrap_or(body);
            let message = format!(
                "Claude Code OAuth refresh failed with HTTP {}: {}",
                status, detail
            );
            tracing::warn!(
                "[key-vault] Claude Code OAuth refresh HTTP failure key={} status={} message={}",
                key_id,
                status,
                message
            );
            self.record_oauth_refresh_failure(key_id, &message)?;
            return Err(message);
        }

        let refreshed: ClaudeCodeRefreshResponse = match serde_json::from_str(&body) {
            Ok(refreshed) => refreshed,
            Err(err) => {
                tracing::warn!(
                    "[key-vault] Claude Code OAuth refresh response parse error key={}: {}",
                    key_id,
                    err
                );
                let message = format!("Claude Code OAuth refresh response parse failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };
        tracing::info!(
            "[key-vault] Claude Code OAuth refresh parsed key={} access_len={} has_next_refresh={} expires_in={:?}",
            key_id,
            refreshed.access_token.len(),
            refreshed
                .refresh_token
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty()),
            refreshed.expires_in
        );

        let saved = self.update_store(|store| {
            let entry = store.keys.get_mut(key_id).ok_or_else(|| {
                format!("Key disappeared while saving refreshed token: {}", key_id)
            })?;

            entry.session_token = Some(refreshed.access_token);
            if let Some(next_refresh_token) = refreshed.refresh_token {
                entry.env_vars.insert(
                    CLAUDE_CODE_REFRESH_TOKEN_ENV.to_string(),
                    next_refresh_token,
                );
            }
            if let Some(expires_in) = refreshed.expires_in {
                entry.env_vars.insert(
                    CLAUDE_CODE_EXPIRES_IN_ENV.to_string(),
                    expires_in.to_string(),
                );
                let expires_at = Utc::now() + ChronoDuration::seconds(expires_in as i64);
                entry.env_vars.insert(
                    CLAUDE_CODE_EXPIRES_AT_ENV.to_string(),
                    expires_at.timestamp_millis().to_string(),
                );
            }
            Self::reset_oauth_refresh_failure_state(entry);
            entry.enabled = true;
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            Ok::<ModelKey, String>(entry.clone())
        })??;
        tracing::info!(
            "[key-vault] Claude Code OAuth refresh saved key={} enabled={} health={:?} failures={} expires_at={:?} has_refresh={}",
            key_id,
            saved.enabled,
            saved.health_status,
            saved.oauth_refresh_failure_count,
            Self::claude_code_oauth_expires_at(&saved).map(|dt| dt.to_rfc3339()),
            saved.env_vars
                .get(CLAUDE_CODE_REFRESH_TOKEN_ENV)
                .is_some_and(|token| !token.trim().is_empty())
        );

        Ok(OAuthRefreshOutcome::Refreshed(Box::new(saved)))
    }
}
