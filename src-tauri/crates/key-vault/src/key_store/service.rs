use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};

use super::store::KeyStore;
use super::types::{AuthMethod, HealthStatus, ModelKey, ModelType};

const CLAUDE_CODE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE_ENV: &str = "CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE";
const CLAUDE_CODE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_REFRESH_TOKEN_ENV: &str = "CLAUDE_CODE_REFRESH_TOKEN";
const CLAUDE_CODE_EXPIRES_IN_ENV: &str = "CLAUDE_CODE_EXPIRES_IN";
const CLAUDE_CODE_EXPIRES_AT_ENV: &str = "CLAUDE_CODE_EXPIRES_AT";
const OAUTH_REFRESH_EXPIRY_SKEW_SECONDS: i64 = 60;
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV: &str = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_REFRESH_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const OAUTH_REFRESH_FAILURE_DISABLE_THRESHOLD: u32 = 3;
const OAUTH_TEMPORARY_UNAVAILABLE_SECONDS: i64 = 30 * 60;
const OAUTH_RATE_LIMIT_FALLBACK_SECONDS: i64 = 5 * 60;
const OAUTH_REFRESH_FAILURE_COOLDOWN_SECONDS: i64 = 5 * 60;
const GEMINI_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_REFRESH_TOKEN_URL_OVERRIDE_ENV: &str = "GEMINI_REFRESH_TOKEN_URL_OVERRIDE";
const GEMINI_REFRESH_TOKEN_ENV: &str = "GEMINI_REFRESH_TOKEN";
const GEMINI_EXPIRES_IN_ENV: &str = "GEMINI_EXPIRES_IN";
const GEMINI_EXPIRES_AT_ENV: &str = "GEMINI_EXPIRES_AT";
type OAuthRefreshLockMap = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

#[derive(Debug, Clone, Default)]
pub struct CliOAuthTokenSync {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone)]
pub enum CliOAuthTokenSyncOutcome {
    Updated(Box<ModelKey>),
    SkippedNewerKeyVaultToken,
    NotApplicable,
}

fn is_permanent_oauth_refresh_failure(error_message: &str) -> bool {
    let lower = error_message.to_lowercase();
    lower.contains("refresh token not found or invalid")
        || lower.contains("invalid_grant")
        || lower.contains("invalid refresh token")
        || lower.contains("refresh token expired")
        || lower.contains("refresh_token expired")
}

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

#[derive(Debug, Serialize)]
struct GeminiRefreshRequest<'a> {
    client_id: &'a str,
    client_secret: &'a str,
    grant_type: &'static str,
    refresh_token: &'a str,
}

#[derive(Debug, Deserialize)]
struct GeminiRefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiRefreshErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
    message: Option<String>,
}

/// Thread-safe key storage service (`~/.orgii/credentials.json`)
pub struct KeyService {
    storage_dir: PathBuf,
    storage_file: PathBuf,
    lock: Mutex<()>,
    oauth_refresh_locks: OAuthRefreshLockMap,
}

impl Default for KeyService {
    fn default() -> Self {
        Self::new(None)
    }
}

impl KeyService {
    /// Create a new key service
    pub fn new(storage_dir: Option<PathBuf>) -> Self {
        let storage_dir = storage_dir.unwrap_or_else(app_paths::orgii_root);
        let storage_file = storage_dir.join("credentials.json");

        // Ensure storage directory exists
        if !storage_dir.exists() {
            fs::create_dir_all(&storage_dir).ok();
        }

        // Guard: if credentials.json is accidentally a directory, remove it
        if storage_file.is_dir() {
            eprintln!(
                "[KeyService] WARNING: {:?} is a directory, removing it",
                storage_file
            );
            fs::remove_dir_all(&storage_file).ok();
        }

        Self {
            storage_dir,
            storage_file,
            lock: Mutex::new(()),
            oauth_refresh_locks: Mutex::new(HashMap::new()),
        }
    }

    // ---- Storage ----

    /// Load keys from file.
    ///
    /// On read or parse failure, logs an error and returns `None` so callers
    /// can decide whether to proceed (read-only callers return empty data,
    /// write callers abort to avoid overwriting a corrupted file).
    fn load_store_checked(&self) -> Result<KeyStore, String> {
        if !self.storage_file.exists() {
            return Ok(KeyStore::default());
        }

        let contents = fs::read_to_string(&self.storage_file)
            .map_err(|e| format!("Failed to read {:?}: {}", self.storage_file, e))?;

        serde_json::from_str(&contents)
            .map_err(|e| format!("Corrupted credentials file {:?}: {}", self.storage_file, e))
    }

    /// Load keys, returning default on missing file but logging errors.
    fn load_store(&self) -> KeyStore {
        match self.load_store_checked() {
            Ok(store) => store,
            Err(err) => {
                eprintln!("[KeyService] {}", err);
                KeyStore::default()
            }
        }
    }

    /// Save keys to file (atomic write + restrictive permissions).
    /// Secrets (api_key, session_token) are written directly to the JSON file,
    /// protected by 0o600 permissions.
    fn save_store(&self, store: &KeyStore) -> Result<(), String> {
        let contents = serde_json::to_string_pretty(store)
            .map_err(|e| format!("Failed to serialize credentials: {}", e))?;

        // Write to a temp file first, then rename — atomic on same filesystem
        let tmp_path = self.storage_file.with_extension("json.tmp");
        fs::write(&tmp_path, &contents)
            .map_err(|e| format!("Failed to write credentials temp file: {}", e))?;

        // Restrict permissions before rename so the file is never world-readable
        app_paths::set_sensitive_file_permissions(&tmp_path).ok();

        fs::rename(&tmp_path, &self.storage_file)
            .map_err(|e| format!("Failed to rename credentials file: {}", e))
    }

    /// Update store atomically with a closure.
    /// Uses checked load to avoid overwriting a corrupted file.
    fn update_store<F, T>(&self, updater: F) -> Result<T, String>
    where
        F: FnOnce(&mut KeyStore) -> T,
    {
        let _guard = self.lock.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut store = self.load_store_checked()?;
        let result = updater(&mut store);
        self.save_store(&store)?;

        Ok(result)
    }

    /// List all stored keys
    pub fn list_keys(&self) -> Vec<ModelKey> {
        let store = self.load_store();
        store.keys.into_values().collect()
    }

    /// Get key by agent type and optional ID
    pub fn get_key(&self, agent_type: &ModelType, key_id: Option<&str>) -> Option<ModelKey> {
        let store = self.load_store();
        store.get(agent_type, key_id).cloned()
    }

    /// Get key by ID only
    pub fn get_key_by_id(&self, key_id: &str) -> Option<ModelKey> {
        let store = self.load_store();
        store.get_by_id(key_id).cloned()
    }

    /// Get all keys for an agent type
    pub fn get_all_keys_for_agent(&self, agent_type: &ModelType) -> Vec<ModelKey> {
        let store = self.load_store();
        store.get_all(agent_type).into_iter().cloned().collect()
    }

    /// Save or update a key
    pub fn save_key(&self, key: ModelKey) -> Result<ModelKey, String> {
        self.update_store(|store| {
            let entry = key.clone();
            store.set(key);
            entry
        })
    }

    /// Record behaviorally-observed reasoning capability for `model` on key
    /// `key_id`. Called by agent-core's side-query layer when a model is
    /// seen emitting thinking-only responses (or rejecting
    /// `thinking: disabled` with a 400) so future capability resolution
    /// skips the failed first attempt.
    ///
    /// Idempotent: when the variant already carries the same reasoning
    /// value, nothing is written to disk (avoids write amplification —
    /// side queries run on every turn).
    pub fn record_observed_reasoning(
        &self,
        key_id: &str,
        model: &str,
        reasoning: &str,
    ) -> Result<(), String> {
        // Read-only fast path: skip the store write lock entirely when the
        // value is already recorded.
        if let Some(key) = self.get_key_by_id(key_id) {
            if key
                .model_variants
                .iter()
                .any(|v| v.model == model && v.reasoning.as_deref() == Some(reasoning))
            {
                return Ok(());
            }
        } else {
            return Err(format!("Key '{}' not found", key_id));
        }

        self.update_store(|store| {
            let Some(entry) = store.keys.get_mut(key_id) else {
                return Err(format!("Key '{}' not found", key_id));
            };
            if let Some(variant) = entry.model_variants.iter_mut().find(|v| v.model == model) {
                variant.reasoning = Some(reasoning.to_string());
            } else {
                entry.model_variants.push(crate::key_store::ModelVariant {
                    model: model.to_string(),
                    base_model: model.to_string(),
                    reasoning: Some(reasoning.to_string()),
                    fast: false,
                    context_window: None,
                });
            }
            entry.updated_at = chrono::Utc::now();
            Ok(())
        })?
    }

    pub fn sync_cli_oauth_tokens_if_current(
        &self,
        key_id: &str,
        model_type: ModelType,
        launched_access_token: Option<&str>,
        tokens: CliOAuthTokenSync,
    ) -> Result<CliOAuthTokenSyncOutcome, String> {
        self.update_store(|store| {
            let Some(entry) = store.keys.get_mut(key_id) else {
                return Ok(CliOAuthTokenSyncOutcome::NotApplicable);
            };
            if entry.model_type != model_type || entry.auth_method != AuthMethod::Oauth {
                return Ok(CliOAuthTokenSyncOutcome::NotApplicable);
            }

            let current_access_token = entry
                .session_token
                .as_deref()
                .filter(|token| !token.trim().is_empty());
            let launched_access_token =
                launched_access_token.filter(|token| !token.trim().is_empty());
            if let (Some(current), Some(launched)) = (current_access_token, launched_access_token) {
                if current != launched {
                    return Ok(CliOAuthTokenSyncOutcome::SkippedNewerKeyVaultToken);
                }
            }

            let mut changed = false;
            if let Some(token) = tokens.access_token.filter(|token| !token.trim().is_empty()) {
                if entry.session_token.as_deref() != Some(token.as_str()) {
                    entry.session_token = Some(token);
                    changed = true;
                }
            }
            if let Some(token) = tokens
                .refresh_token
                .filter(|token| !token.trim().is_empty())
            {
                let refresh_key = match model_type {
                    ModelType::Codex => CODEX_REFRESH_TOKEN_ENV_KEY,
                    ModelType::GeminiCli => GEMINI_REFRESH_TOKEN_ENV,
                    _ => return Ok(CliOAuthTokenSyncOutcome::NotApplicable),
                };
                if entry.env_vars.get(refresh_key) != Some(&token) {
                    entry.env_vars.insert(refresh_key.to_string(), token);
                    changed = true;
                }
            }
            if let Some(token) = tokens.id_token.filter(|token| !token.trim().is_empty()) {
                if model_type == ModelType::Codex
                    && entry.env_vars.get(CODEX_ID_TOKEN_ENV_KEY) != Some(&token)
                {
                    entry
                        .env_vars
                        .insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), token);
                    changed = true;
                }
            }
            if let Some(value) = tokens.expires_at.filter(|value| !value.trim().is_empty()) {
                if model_type == ModelType::GeminiCli
                    && entry.env_vars.get(GEMINI_EXPIRES_AT_ENV) != Some(&value)
                {
                    entry
                        .env_vars
                        .insert(GEMINI_EXPIRES_AT_ENV.to_string(), value);
                    changed = true;
                }
            }

            if changed {
                Self::reset_oauth_refresh_failure_state(entry);
                entry.enabled = true;
                entry.updated_at = Utc::now();
                store.updated_at = Utc::now();
            }
            Ok(CliOAuthTokenSyncOutcome::Updated(Box::new(entry.clone())))
        })?
    }

    pub fn reset_oauth_refresh_failures(&self, key_id: &str) -> Result<Option<ModelKey>, String> {
        self.update_store(|store| {
            let entry = store.keys.get_mut(key_id)?;
            Self::reset_oauth_refresh_failure_state(entry);
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            Some(entry.clone())
        })
    }

    pub fn record_oauth_refresh_failure(
        &self,
        key_id: &str,
        error_message: &str,
    ) -> Result<Option<ModelKey>, String> {
        self.update_store(|store| {
            let entry = store.keys.get_mut(key_id)?;
            let count = entry.oauth_refresh_failure_count.saturating_add(1);
            entry.oauth_refresh_failure_count = count;
            entry.last_oauth_refresh_failed_at = Some(Utc::now());
            entry.last_validation_error = Some(error_message.to_string());
            entry.last_validated_at = Some(Utc::now());
            entry.temporary_unavailable_until =
                Some(Utc::now() + ChronoDuration::seconds(OAUTH_REFRESH_FAILURE_COOLDOWN_SECONDS));
            entry.temporary_unavailable_reason = Some("oauth_refresh_failed".to_string());
            entry.last_upstream_error_type = Some("oauth_refresh_failed".to_string());
            if is_permanent_oauth_refresh_failure(error_message)
                || (entry.model_type != ModelType::ClaudeCode
                    && count >= OAUTH_REFRESH_FAILURE_DISABLE_THRESHOLD)
            {
                entry.enabled = false;
                entry.health_status = HealthStatus::Invalid;
            } else {
                entry.health_status = HealthStatus::Degraded;
            }
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            tracing::warn!(
                "[key-vault] OAuth refresh failure recorded key={} type={:?} count={} enabled={} health={:?} permanent={} cooldown_until={:?} error={}",
                key_id,
                entry.model_type,
                count,
                entry.enabled,
                entry.health_status,
                is_permanent_oauth_refresh_failure(error_message),
                entry
                    .temporary_unavailable_until
                    .map(|dt| dt.to_rfc3339()),
                error_message
            );
            Some(entry.clone())
        })
    }

    pub fn mark_claude_oauth_upstream_health(
        &self,
        key_id: &str,
        status: u16,
        error_type: &str,
        message: Option<&str>,
        retry_after_secs: Option<u64>,
    ) -> Result<Option<ModelKey>, String> {
        self.update_store(|store| {
            let entry = store.keys.get_mut(key_id)?;
            if entry.model_type != ModelType::ClaudeCode || entry.auth_method != AuthMethod::Oauth {
                return Some(entry.clone());
            }

            entry.last_upstream_status = Some(status);
            entry.last_upstream_error_type = Some(error_type.to_string());
            entry.last_validation_error = message.map(ToString::to_string);
            entry.last_validated_at = Some(Utc::now());

            let cooldown_secs = retry_after_secs
                .and_then(|secs| i64::try_from(secs).ok())
                .filter(|secs| *secs > 0)
                .unwrap_or_else(|| match status {
                    429 => OAUTH_RATE_LIMIT_FALLBACK_SECONDS,
                    529 => OAUTH_RATE_LIMIT_FALLBACK_SECONDS * 2,
                    401 | 403 => OAUTH_TEMPORARY_UNAVAILABLE_SECONDS,
                    500..=599 => OAUTH_RATE_LIMIT_FALLBACK_SECONDS,
                    _ => OAUTH_RATE_LIMIT_FALLBACK_SECONDS,
                });
            let unavailable_until = Utc::now() + ChronoDuration::seconds(cooldown_secs);
            entry.temporary_unavailable_until = Some(unavailable_until);
            entry.temporary_unavailable_reason = Some(error_type.to_string());
            if status == 429 {
                entry.rate_limit_reset_at = Some(unavailable_until);
            }
            if entry.health_status != HealthStatus::Invalid {
                entry.health_status = HealthStatus::Degraded;
            }
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            tracing::warn!(
                "[key-vault] Claude OAuth key {} marked temporarily unavailable: status={} type={} until={}",
                key_id,
                status,
                error_type,
                unavailable_until.to_rfc3339()
            );
            Some(entry.clone())
        })
    }

    pub fn clear_claude_oauth_upstream_health(
        &self,
        key_id: &str,
    ) -> Result<Option<ModelKey>, String> {
        // Fast path: most requests succeed with nothing to clear. Skip the
        // store rewrite entirely so the per-request happy path stays read-only.
        if let Some(existing) = self.get_key_by_id(key_id) {
            let nothing_to_clear = existing.temporary_unavailable_until.is_none()
                && existing.temporary_unavailable_reason.is_none()
                && existing.last_upstream_status.is_none()
                && existing.last_upstream_error_type.is_none()
                && existing.rate_limit_reset_at.is_none();
            if nothing_to_clear {
                return Ok(Some(existing));
            }
        }
        self.update_store(|store| {
            let entry = store.keys.get_mut(key_id)?;
            if entry.model_type != ModelType::ClaudeCode || entry.auth_method != AuthMethod::Oauth {
                return Some(entry.clone());
            }
            entry.temporary_unavailable_until = None;
            entry.temporary_unavailable_reason = None;
            entry.last_upstream_status = None;
            entry.last_upstream_error_type = None;
            entry.rate_limit_reset_at = None;
            if entry.health_status == HealthStatus::Degraded
                && entry.oauth_refresh_failure_count == 0
            {
                entry.health_status = HealthStatus::Valid;
            }
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            Some(entry.clone())
        })
    }

    pub fn is_key_temporarily_unavailable(&self, key: &ModelKey) -> bool {
        key.temporary_unavailable_until
            .is_some_and(|until| until > Utc::now())
    }

    pub fn temporary_unavailable_message(&self, key: &ModelKey) -> Option<String> {
        let until = key.temporary_unavailable_until?;
        if until <= Utc::now() {
            return None;
        }
        let reason = key
            .temporary_unavailable_reason
            .as_deref()
            .unwrap_or("temporary_unavailable");
        Some(format!(
            "Claude Code OAuth account '{}' is temporarily unavailable ({}) until {}",
            key.name.as_deref().unwrap_or(&key.id),
            reason,
            until.to_rfc3339()
        ))
    }

    fn reset_oauth_refresh_failure_state(entry: &mut ModelKey) {
        entry.oauth_refresh_failure_count = 0;
        entry.last_oauth_refresh_failed_at = None;
        entry.last_validation_error = None;
        entry.temporary_unavailable_until = None;
        entry.temporary_unavailable_reason = None;
        entry.last_upstream_status = None;
        entry.last_upstream_error_type = None;
        entry.rate_limit_reset_at = None;
        if entry.health_status == HealthStatus::Invalid {
            entry.health_status = HealthStatus::Unknown;
        }
    }

    fn oauth_refresh_lock_for_key(
        &self,
        key_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let mut locks = self
            .oauth_refresh_locks
            .lock()
            .map_err(|err| format!("OAuth refresh lock map poisoned: {}", err))?;
        Ok(locks
            .entry(key_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone())
    }

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
            .await
    }

    /// Refresh a Claude Code OAuth key and persist the fresh access token.
    pub async fn refresh_claude_code_oauth_key(
        &self,
        key_id: &str,
        rejected_access_token: &str,
    ) -> Result<ModelKey, String> {
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

        if key.model_type != ModelType::ClaudeCode || key.auth_method != AuthMethod::Oauth {
            tracing::info!(
                "[key-vault] Claude Code OAuth refresh skipped key={} reason=not_claude_oauth type={:?} auth={:?}",
                key_id,
                key.model_type,
                key.auth_method
            );
            return Ok(key);
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
            return Ok(key);
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

        let token_url = std::env::var(CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE_ENV)
            .unwrap_or_else(|_| CLAUDE_CODE_TOKEN_URL.to_string());
        tracing::info!(
            "[key-vault] Claude Code OAuth refresh request start key={} endpoint_override={} refresh_len={} access_len={}",
            key_id,
            std::env::var(CLAUDE_CODE_REFRESH_TOKEN_URL_OVERRIDE_ENV).is_ok(),
            refresh_token.len(),
            rejected_access_token.len()
        );

        let response = match reqwest::Client::builder()
            .timeout(OAUTH_REFRESH_REQUEST_TIMEOUT)
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

        Ok(saved)
    }

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

    fn google_oauth_client_id() -> String {
        std::env::var("GEMINI_OAUTH_CLIENT_ID").unwrap_or_else(|_| {
            let parts: &[&str] = &[
                "681255809395-oo8ft2oprd",
                "rnp9e3aqf6av3hmdib135j",
                ".apps.googleusercontent.com",
            ];
            parts.concat()
        })
    }

    fn google_oauth_client_secret() -> String {
        std::env::var("GEMINI_OAUTH_CLIENT_SECRET").unwrap_or_else(|_| {
            let parts: &[&str] = &["GOCSPX-", "4uHgMPm-1o7", "Sk-geV6Cu5clXFsxl"];
            parts.concat()
        })
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
            .await
    }

    pub async fn refresh_codex_oauth_key(
        &self,
        key_id: &str,
        rejected_access_token: &str,
    ) -> Result<ModelKey, String> {
        crate::e2e_guard::ensure_oauth_refresh_allowed()?;

        let refresh_lock = self.oauth_refresh_lock_for_key(key_id)?;
        let _refresh_guard = refresh_lock.lock().await;

        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if key.model_type != ModelType::Codex || key.auth_method != AuthMethod::Oauth {
            return Ok(key);
        }

        if key
            .session_token
            .as_deref()
            .is_some_and(|token| !token.is_empty() && token != rejected_access_token)
        {
            return Ok(key);
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

        let token_url = std::env::var(CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV)
            .unwrap_or_else(|_| CODEX_TOKEN_URL.to_string());

        let response = match reqwest::Client::builder()
            .timeout(OAUTH_REFRESH_REQUEST_TIMEOUT)
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

        saved
    }

    fn gemini_oauth_key_needs_refresh(key: &ModelKey) -> bool {
        if key.model_type != ModelType::GeminiCli || key.auth_method != AuthMethod::Oauth {
            return false;
        }
        if key
            .session_token
            .as_deref()
            .is_none_or(|token| token.trim().is_empty())
        {
            return true;
        }

        let Some(expires_at_value) = key.env_vars.get(GEMINI_EXPIRES_AT_ENV) else {
            return false;
        };
        let Ok(expires_at) = chrono::DateTime::parse_from_rfc3339(expires_at_value) else {
            return false;
        };
        Utc::now() + ChronoDuration::seconds(OAUTH_REFRESH_EXPIRY_SKEW_SECONDS)
            >= expires_at.with_timezone(&Utc)
    }

    pub async fn ensure_gemini_oauth_key_fresh(&self, key_id: &str) -> Result<ModelKey, String> {
        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if !Self::gemini_oauth_key_needs_refresh(&key) {
            return Ok(key);
        }

        let rejected_access_token = key.session_token.clone().unwrap_or_default();
        self.refresh_gemini_oauth_key_after_rejection(key_id, &rejected_access_token)
            .await
    }

    pub async fn refresh_gemini_oauth_key(&self, key_id: &str) -> Result<ModelKey, String> {
        self.refresh_gemini_oauth_key_inner(key_id, None).await
    }

    pub async fn refresh_gemini_oauth_key_after_rejection(
        &self,
        key_id: &str,
        rejected_access_token: &str,
    ) -> Result<ModelKey, String> {
        self.refresh_gemini_oauth_key_inner(key_id, Some(rejected_access_token))
            .await
    }

    async fn refresh_gemini_oauth_key_inner(
        &self,
        key_id: &str,
        rejected_access_token: Option<&str>,
    ) -> Result<ModelKey, String> {
        crate::e2e_guard::ensure_oauth_refresh_allowed()?;

        let refresh_lock = self.oauth_refresh_lock_for_key(key_id)?;
        let _refresh_guard = refresh_lock.lock().await;

        let key = self
            .get_key_by_id(key_id)
            .ok_or_else(|| format!("Key not found: {}", key_id))?;

        if key.model_type != ModelType::GeminiCli || key.auth_method != AuthMethod::Oauth {
            return Ok(key);
        }

        if let Some(rejected_access_token) = rejected_access_token {
            if key
                .session_token
                .as_deref()
                .is_some_and(|token| !token.is_empty() && token != rejected_access_token)
            {
                return Ok(key);
            }
        }

        let refresh_token = key
            .env_vars
            .get(GEMINI_REFRESH_TOKEN_ENV)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .ok_or_else(|| format!("Gemini OAuth key {} has no refresh token", key_id))?;
        let client_id = Self::google_oauth_client_id();
        let client_secret = Self::google_oauth_client_secret();
        let request = GeminiRefreshRequest {
            client_id: &client_id,
            client_secret: &client_secret,
            grant_type: "refresh_token",
            refresh_token: &refresh_token,
        };

        let token_url = std::env::var(GEMINI_REFRESH_TOKEN_URL_OVERRIDE_ENV)
            .unwrap_or_else(|_| GEMINI_TOKEN_URL.to_string());

        let response = match reqwest::Client::builder()
            .timeout(OAUTH_REFRESH_REQUEST_TIMEOUT)
            .build()
            .map_err(|err| format!("Gemini OAuth refresh client build failed: {}", err))?
            .post(token_url)
            .form(&request)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let message = format!("Gemini OAuth refresh request failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        let status = response.status();
        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => {
                let message = format!("Gemini OAuth refresh response read failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        if !status.is_success() {
            let detail = serde_json::from_str::<GeminiRefreshErrorResponse>(&body)
                .ok()
                .and_then(|parsed| parsed.error_description.or(parsed.message).or(parsed.error))
                .unwrap_or(body);
            let message = format!(
                "Gemini OAuth refresh failed with HTTP {}: {}",
                status, detail
            );
            self.record_oauth_refresh_failure(key_id, &message)?;
            return Err(message);
        }

        let refreshed: GeminiRefreshResponse = match serde_json::from_str(&body) {
            Ok(refreshed) => refreshed,
            Err(err) => {
                let message = format!("Gemini OAuth refresh response parse failed: {}", err);
                self.record_oauth_refresh_failure(key_id, &message)?;
                return Err(message);
            }
        };

        let access_token = refreshed
            .access_token
            .filter(|token| !token.trim().is_empty());
        if access_token.is_none() {
            let message = "Gemini OAuth refresh response omitted access_token".to_string();
            self.record_oauth_refresh_failure(key_id, &message)?;
            return Err(message);
        }

        let saved = self.update_store(|store| {
            let entry = store.keys.get_mut(key_id).ok_or_else(|| {
                format!(
                    "Key disappeared while saving refreshed Gemini token: {}",
                    key_id
                )
            })?;

            entry.session_token = access_token;
            if let Some(next_refresh_token) = refreshed.refresh_token {
                if !next_refresh_token.trim().is_empty() {
                    entry
                        .env_vars
                        .insert(GEMINI_REFRESH_TOKEN_ENV.to_string(), next_refresh_token);
                }
            }
            if let Some(expires_in) = refreshed.expires_in {
                entry
                    .env_vars
                    .insert(GEMINI_EXPIRES_IN_ENV.to_string(), expires_in.to_string());
                let expires_at = Utc::now() + ChronoDuration::seconds(expires_in as i64);
                entry.env_vars.insert(
                    GEMINI_EXPIRES_AT_ENV.to_string(),
                    expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                );
            }
            if let Some(token_type) = refreshed.token_type {
                entry
                    .env_vars
                    .insert("GEMINI_TOKEN_TYPE".to_string(), token_type);
            }
            if let Some(scope) = refreshed.scope {
                entry.env_vars.insert("GEMINI_SCOPE".to_string(), scope);
            }
            Self::reset_oauth_refresh_failure_state(entry);
            entry.enabled = true;
            entry.updated_at = Utc::now();
            store.updated_at = Utc::now();
            Ok(entry.clone())
        })?;

        saved
    }

    /// Merge account metadata fields onto a stored key.
    pub fn merge_key_account_metadata(
        &self,
        key_id: &str,
        metadata: HashMap<String, String>,
    ) -> Result<Option<ModelKey>, String> {
        if metadata.is_empty() {
            return Ok(self.get_key_by_id(key_id));
        }

        self.update_store(|store| {
            if let Some(entry) = store.keys.get_mut(key_id) {
                for (field, value) in metadata {
                    if !value.trim().is_empty() {
                        entry.account_metadata.insert(field, value);
                    }
                }
                entry.updated_at = Utc::now();
                store.updated_at = Utc::now();
                Some(entry.clone())
            } else {
                None
            }
        })
    }

    /// Update key health status
    pub fn update_key_health(
        &self,
        key_id: &str,
        health_status: HealthStatus,
        error_message: Option<String>,
        available_models: Option<Vec<String>>,
        enabled_models: Option<Vec<String>>,
        quota_info: Option<serde_json::Value>,
        model_context_lengths: Option<&HashMap<String, u64>>,
    ) -> Result<Option<ModelKey>, String> {
        self.update_store(|store| {
            if let Some(entry) = store.keys.get_mut(key_id) {
                entry.health_status = health_status;
                entry.last_validation_error = error_message;
                entry.last_validated_at = Some(Utc::now());

                let refreshed_models: Option<HashSet<String>> = available_models
                    .as_ref()
                    .map(|models| models.iter().cloned().collect());
                if let Some(models) = available_models {
                    entry.available_models = models;
                }
                if let Some(contexts) = model_context_lengths {
                    // Treat the validation/refresh result as authoritative for
                    // the refreshed model list only: absent context_length
                    // means "fall back to FAMILY_RULES", not "keep a stale
                    // proxy cap". Health-only updates may pass an empty map
                    // without refreshing models, so they must not clear
                    // existing provider overrides.
                    if let Some(model_scope) = refreshed_models.as_ref() {
                        for variant in &mut entry.model_variants {
                            if model_scope.contains(&variant.model)
                                && !contexts.contains_key(&variant.model)
                            {
                                variant.context_window = None;
                            }
                        }
                    }

                    // find-or-push: provider-reported context windows override
                    // the static FAMILY_RULES default at runtime. Mirrors the
                    // reasoning writeback above.
                    for (model, ctx) in contexts {
                        if *ctx == 0 {
                            continue;
                        }
                        if let Some(variant) =
                            entry.model_variants.iter_mut().find(|v| &v.model == model)
                        {
                            variant.context_window = Some(*ctx);
                        } else {
                            entry.model_variants.push(crate::key_store::ModelVariant {
                                model: model.clone(),
                                base_model: model.clone(),
                                reasoning: None,
                                fast: false,
                                context_window: Some(*ctx),
                            });
                        }
                    }
                }
                if let Some(enabled) = enabled_models {
                    entry.enabled_models = enabled;
                }
                if let Some(quota) = quota_info {
                    entry.quota_info = Some(quota);
                }

                entry.updated_at = Utc::now();
                store.updated_at = Utc::now();

                Some(entry.clone())
            } else {
                None
            }
        })
    }

    /// Delete key by agent type and optional ID.
    pub fn delete_key(&self, agent_type: &ModelType, key_id: Option<&str>) -> Result<bool, String> {
        self.update_store(|store| store.delete(agent_type, key_id))
    }

    /// Delete key by ID only.
    pub fn delete_key_by_id(&self, key_id: &str) -> Result<bool, String> {
        self.update_store(|store| store.delete_by_id(key_id))
    }

    /// Get storage directory path
    pub fn get_storage_dir(&self) -> &PathBuf {
        &self.storage_dir
    }

    /// Get storage file path
    pub fn get_storage_file(&self) -> &PathBuf {
        &self.storage_file
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

// ============================================
// Global Instance
// ============================================

use std::sync::LazyLock;

/// Global key service instance
pub static KEY_SERVICE: LazyLock<KeyService> = LazyLock::new(KeyService::default);
