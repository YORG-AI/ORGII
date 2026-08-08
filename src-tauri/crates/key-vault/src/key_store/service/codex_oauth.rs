//! Codex OAuth token refresh: JWT-expiry detection plus the locked
//! refresh-token exchange that persists rotated access/refresh/id tokens.

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};

use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};

use super::super::types::{AuthMethod, ModelKey, ModelType, OAuthRefreshOutcome};
use super::{KeyService, OAUTH_REFRESH_EXPIRY_SKEW_SECONDS, OAUTH_REFRESH_REQUEST_TIMEOUT};

const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV: &str = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Debug, Serialize)]
struct CodexRefreshRequest<'a> {
    client_id: &'static str,
    grant_type: &'static str,
    refresh_token: &'a str,
}

#[derive(Debug, Deserialize)]
struct CodexRefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexRefreshErrorResponse {
    error: Option<serde_json::Value>,
    error_description: Option<String>,
    message: Option<String>,
    code: Option<String>,
}

impl KeyService {
    fn jwt_expires_at(token: &str) -> Option<chrono::DateTime<Utc>> {
        let payload = token.split('.').nth(1)?;
        use base64::Engine;
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .ok()?;
        let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
        let exp = json.get("exp")?.as_i64()?;
        chrono::DateTime::<Utc>::from_timestamp(exp, 0)
    }

    fn codex_oauth_key_needs_refresh(key: &ModelKey) -> bool {
        if key.model_type != ModelType::Codex || key.auth_method != AuthMethod::Oauth {
            return false;
        }
        let Some(refresh_token) = key.env_vars.get(CODEX_REFRESH_TOKEN_ENV_KEY) else {
            return false;
        };
        if refresh_token.trim().is_empty() {
            return false;
        }
        let Some(session_token) = key.session_token.as_deref() else {
            return true;
        };
        if session_token.trim().is_empty() {
            return true;
        }

        let expires_at = Self::jwt_expires_at(session_token).or_else(|| {
            key.env_vars
                .get(CODEX_ID_TOKEN_ENV_KEY)
                .and_then(|token| Self::jwt_expires_at(token))
        });

        expires_at
            .map(|exp| {
                Utc::now() + ChronoDuration::seconds(OAUTH_REFRESH_EXPIRY_SKEW_SECONDS) >= exp
            })
            .unwrap_or(false)
    }

    pub async fn ensure_codex_oauth_key_fresh(&self, key_id: &str) -> Result<ModelKey, String> {
        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if !Self::codex_oauth_key_needs_refresh(&key) {
            return Ok(key);
        }

        let rejected_access_token = key.session_token.clone().unwrap_or_default();
        self.refresh_codex_oauth_key(key_id, &rejected_access_token)
            .await?
            .into_key()
            .ok_or_else(|| format!("Key {} is not a native Codex OAuth account", key_id))
    }

    pub async fn refresh_codex_oauth_key(
        &self,
        key_id: &str,
        rejected_access_token: &str,
    ) -> Result<OAuthRefreshOutcome, String> {
        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if !key.is_native_oauth_for(&ModelType::Codex) {
            return Ok(OAuthRefreshOutcome::NotApplicable);
        }

        crate::e2e_guard::ensure_oauth_refresh_allowed()?;

        let refresh_lock = self.oauth_refresh_lock_for_key(key_id)?;
        let _refresh_guard = refresh_lock.lock().await;

        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if !key.is_native_oauth_for(&ModelType::Codex) {
            return Ok(OAuthRefreshOutcome::NotApplicable);
        }

        if key
            .session_token
            .as_deref()
            .is_some_and(|token| !token.is_empty() && token != rejected_access_token)
        {
            return Ok(OAuthRefreshOutcome::AlreadyRotated(Box::new(key)));
        }

        let refresh_token = key
            .env_vars
            .get(CODEX_REFRESH_TOKEN_ENV_KEY)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .ok_or_else(|| format!("Codex OAuth key {} has no refresh token", key_id))?;

        let request = CodexRefreshRequest {
            client_id: CODEX_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: &refresh_token,
        };

        let token_url_override = std::env::var(CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV).ok();
        let token_url = token_url_override
            .clone()
            .unwrap_or_else(|| CODEX_TOKEN_URL.to_string());

        let mut client_builder = reqwest::Client::builder().timeout(OAUTH_REFRESH_REQUEST_TIMEOUT);
        if token_url_override.is_some() {
            client_builder = client_builder.no_proxy();
        }
        let response = match client_builder
            .build()
            .map_err(|err| format!("Codex OAuth refresh client build failed: {}", err))?
            .post(token_url)
            .form(&request)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let message = format!("Codex OAuth refresh request failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        let status = response.status();
        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => {
                let message = format!("Codex OAuth refresh response read failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        if !status.is_success() {
            let detail = parse_codex_refresh_error(&body);
            let message = format!(
                "Codex OAuth refresh failed with HTTP {}: {}",
                status, detail
            );
            self.record_oauth_refresh_failure(key_id, &message)?;
            return Err(message);
        }

        let refreshed: CodexRefreshResponse = match serde_json::from_str(&body) {
            Ok(refreshed) => refreshed,
            Err(err) => {
                let message = format!("Codex OAuth refresh response parse failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        let access_token = refreshed
            .access_token
            .filter(|token| !token.trim().is_empty());
        if access_token.is_none() {
            let message = "Codex OAuth refresh response omitted access_token".to_string();
            self.record_oauth_refresh_failure(key_id, &message)?;
            return Err(message);
        }

        let saved = self.update_store(|store| {
            let entry = store.keys.get_mut(key_id).ok_or_else(|| {
                format!(
                    "Key disappeared while saving refreshed Codex token: {}",
                    key_id
                )
            })?;

            entry.session_token = access_token;
            if let Some(next_refresh_token) = refreshed.refresh_token {
                if !next_refresh_token.trim().is_empty() {
                    entry
                        .env_vars
                        .insert(CODEX_REFRESH_TOKEN_ENV_KEY.to_string(), next_refresh_token);
                }
            }
            if let Some(next_id_token) = refreshed.id_token {
                if !next_id_token.trim().is_empty() {
                    entry
                        .env_vars
                        .insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), next_id_token);
                }
            }
            Self::reset_oauth_refresh_failure_state(entry);
            entry.enabled = true;
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            Ok(entry.clone())
        })?;

        saved.map(|key| OAuthRefreshOutcome::Refreshed(Box::new(key)))
    }
}

fn parse_codex_refresh_error(body: &str) -> String {
    serde_json::from_str::<CodexRefreshErrorResponse>(body)
        .ok()
        .and_then(|parsed| {
            parsed
                .error_description
                .or(parsed.message)
                .or(parsed.code)
                .or_else(|| parsed.error.map(|error| error.to_string()))
        })
        .unwrap_or_else(|| body.to_string())
}
