use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::commands::crud::key_info_from_entry;
use crate::key_store::{AuthMethod, HealthStatus, ModelType, KEY_SERVICE};
use crate::providers::claude_code::ClaudeCodeQuotaFetcher;
use crate::providers::opencode_go::workspace_id_override_from_key;
use crate::providers::zai_team::{
    ORGANIZATION_METADATA_KEY as ZAI_TEAM_ORGANIZATION_METADATA_KEY,
    PROJECT_METADATA_KEY as ZAI_TEAM_PROJECT_METADATA_KEY,
};
use crate::quota_runtime::{
    QuotaAttemptState, QuotaFreshness, QuotaRefreshCompletion, QuotaRefreshRuntime,
    QuotaRefreshStatus,
};
use crate::types::QuotaInfo;

use super::quota_dispatch::{fetch_quota_for_key, quota_refresh_uses_strict_request_count};

static QUOTA_REFRESH_RUNTIME: LazyLock<QuotaRefreshRuntime<QuotaInfo>> =
    LazyLock::new(QuotaRefreshRuntime::default);

/// Refresh quota for a stored key without exposing its token to the frontend.
#[tauri::command]
pub async fn refresh_key_quota(
    key_id: String,
    force: Option<bool>,
) -> Result<Option<crate::commands::KeyInfo>, String> {
    let lookup_id = key_id.clone();
    let key = tokio::task::spawn_blocking(move || {
        KEY_SERVICE
            .get_key_by_id_checked(&lookup_id)?
            .ok_or_else(|| format!("Key not found: {lookup_id}"))
    })
    .await
    .map_err(|err| format!("Quota key lookup worker failed: {err}"))??;
    let credential_revision = quota_credential_revision(&key);
    let strict_request_count = quota_refresh_uses_strict_request_count(&key);
    let operation_key = key.clone();
    let operation_revision = credential_revision.clone();
    let operation = move || {
        let key = operation_key.clone();
        let revision = operation_revision.clone();
        async move { refresh_and_store_key_quota(key, revision).await }
    };

    if strict_request_count {
        QUOTA_REFRESH_RUNTIME
            .refresh_without_transient_retry(
                key_id.clone(),
                credential_revision,
                force.unwrap_or(false),
                operation,
            )
            .await?;
    } else {
        QUOTA_REFRESH_RUNTIME
            .refresh(
                key_id.clone(),
                credential_revision,
                force.unwrap_or(false),
                operation,
            )
            .await?;
    }

    tokio::task::spawn_blocking(move || {
        KEY_SERVICE
            .get_key_by_id_checked(&key_id)?
            .map(key_info_from_entry)
            .transpose()
    })
    .await
    .map_err(|err| format!("Quota result lookup worker failed: {err}"))?
}

/// Evict the runtime state retained for a deleted or signed-out account.
pub fn invalidate_key_quota_runtime(key_id: &str) {
    QUOTA_REFRESH_RUNTIME.invalidate(key_id);
}

/// Read-only process diagnostics for quota-refresh status and timestamps.
pub fn key_quota_refresh_status(key_id: &str) -> Option<QuotaRefreshStatus<QuotaInfo>> {
    QUOTA_REFRESH_RUNTIME.status(key_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyQuotaRefreshAttemptInfo {
    pub generation: u64,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyQuotaRefreshStatusInfo {
    pub key_id: String,
    pub generation: u64,
    pub freshness: String,
    pub cache_expires_at: Option<String>,
    pub last_good: Option<QuotaInfo>,
    pub last_good_at: Option<String>,
    pub last_attempt: Option<KeyQuotaRefreshAttemptInfo>,
}

/// Return freshness and attempt diagnostics without triggering provider work.
#[tauri::command]
pub fn get_key_quota_refresh_status(key_id: String) -> Option<KeyQuotaRefreshStatusInfo> {
    let status = key_quota_refresh_status(&key_id)?;
    let (last_good, last_good_at) = match status.last_good {
        Some(last_good) => (
            Some(last_good.value),
            Some(format_system_time(last_good.captured_at)),
        ),
        None => (None, None),
    };
    let last_attempt = status
        .last_attempt
        .map(|attempt| KeyQuotaRefreshAttemptInfo {
            generation: attempt.generation,
            status: match attempt.state {
                QuotaAttemptState::Running => "running",
                QuotaAttemptState::Succeeded => "succeeded",
                QuotaAttemptState::Failed => "failed",
                QuotaAttemptState::Superseded => "superseded",
            }
            .to_string(),
            started_at: format_system_time(attempt.started_at),
            finished_at: attempt.finished_at.map(format_system_time),
            error: attempt.error,
        });

    Some(KeyQuotaRefreshStatusInfo {
        key_id,
        generation: status.generation,
        freshness: match status.freshness {
            QuotaFreshness::Empty => "empty",
            QuotaFreshness::FreshSuccess => "fresh_success",
            QuotaFreshness::FreshFailure => "fresh_failure",
            QuotaFreshness::Expired => "expired",
            QuotaFreshness::Refreshing => "refreshing",
        }
        .to_string(),
        cache_expires_at: status.cache_expires_at.map(format_system_time),
        last_good,
        last_good_at,
        last_attempt,
    })
}

fn format_system_time(value: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value).to_rfc3339()
}

async fn refresh_and_store_key_quota(
    key: crate::key_store::ModelKey,
    requested_revision: String,
) -> Result<QuotaRefreshCompletion<QuotaInfo>, String> {
    let key_id = key.id.clone();
    let mut effective_key = key;
    let mut account_metadata = HashMap::new();

    let quota = if effective_key.model_type == ModelType::ClaudeCode
        && effective_key.auth_method == AuthMethod::Oauth
    {
        let token = effective_key
            .session_token
            .as_deref()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| "Claude Code OAuth account has no access token".to_string())?;

        let refresh = match ClaudeCodeQuotaFetcher::new()
            .fetch_quota_refresh(token)
            .await
        {
            Ok(refresh) => refresh,
            Err(first_err) if is_unauthorized_quota_error(&first_err) => {
                effective_key = refresh_oauth_key_for_quota(&effective_key).await?;
                let retry_token = effective_key
                    .session_token
                    .as_deref()
                    .filter(|retry_token| !retry_token.trim().is_empty())
                    .ok_or_else(|| {
                        "Claude Code OAuth account has no access token after refresh".to_string()
                    })?;
                ClaudeCodeQuotaFetcher::new()
                    .fetch_quota_refresh(retry_token)
                    .await?
            }
            Err(first_err) => return Err(first_err),
        };

        account_metadata = refresh.account_metadata;
        refresh.quota
    } else {
        match fetch_quota_for_key(&effective_key).await {
            Ok(quota) => quota,
            Err(first_err)
                if effective_key.auth_method == AuthMethod::Oauth
                    && is_unauthorized_quota_error(&first_err) =>
            {
                effective_key = refresh_oauth_key_for_quota(&effective_key).await?;
                fetch_quota_for_key(&effective_key).await?
            }
            Err(first_err) => return Err(first_err),
        }
    };

    let committed_revision = quota_credential_revision(&effective_key);
    let quota_value = serde_json::to_value(&quota)
        .map_err(|err| format!("Failed to serialize quota info: {err}"))?;
    let commit_key_id = key_id.clone();
    let revision_for_commit = committed_revision.clone();

    tokio::task::spawn_blocking(move || {
        let current = KEY_SERVICE
            .get_key_by_id_checked(&commit_key_id)?
            .ok_or_else(|| format!("Key not found: {commit_key_id}"))?;
        if quota_credential_revision(&current) != revision_for_commit {
            return Err(
                "Quota refresh was superseded before its result could be stored".to_string(),
            );
        }

        if !account_metadata.is_empty() {
            KEY_SERVICE.merge_key_account_metadata(&commit_key_id, account_metadata)?;
        }

        KEY_SERVICE
            .update_key_health(
                &commit_key_id,
                HealthStatus::Valid,
                None,
                None,
                None,
                Some(quota_value),
                None,
            )?
            .ok_or_else(|| format!("Key not found: {commit_key_id}"))?;
        Ok(())
    })
    .await
    .map_err(|err| format!("Quota persistence worker failed: {err}"))??;

    if committed_revision == requested_revision {
        Ok(QuotaRefreshCompletion::unchanged(quota))
    } else {
        Ok(QuotaRefreshCompletion::with_credential_revision(
            quota,
            committed_revision,
        ))
    }
}

pub(in crate::commands) fn quota_credential_revision(key: &crate::key_store::ModelKey) -> String {
    fn hash_field(hasher: &mut Sha256, name: &str, value: Option<&str>) {
        hasher.update(name.len().to_le_bytes());
        hasher.update(name.as_bytes());
        match value {
            Some(value) => {
                hasher.update([1]);
                hasher.update(value.len().to_le_bytes());
                hasher.update(value.as_bytes());
            }
            None => hasher.update([0]),
        }
    }

    let mut hasher = Sha256::new();
    hash_field(&mut hasher, "model_type", Some(key.model_type.as_str()));
    hash_field(
        &mut hasher,
        "auth_method",
        Some(match key.auth_method {
            AuthMethod::ApiKey => "api_key",
            AuthMethod::Oauth => "oauth",
        }),
    );
    hash_field(&mut hasher, "api_key", key.api_key.as_deref());
    hash_field(&mut hasher, "session_token", key.session_token.as_deref());
    hash_field(&mut hasher, "base_url", key.base_url.as_deref());
    hash_field(
        &mut hasher,
        "protocol",
        key.protocol.map(|protocol| protocol.as_str()),
    );

    let mut env_vars = key.env_vars.iter().collect::<Vec<_>>();
    env_vars.sort_unstable_by(|left, right| left.0.cmp(right.0));
    for (name, value) in env_vars {
        hash_field(&mut hasher, name, Some(value));
    }
    hash_field(
        &mut hasher,
        "opencode_workspace",
        workspace_id_override_from_key(key),
    );
    hash_field(
        &mut hasher,
        ZAI_TEAM_ORGANIZATION_METADATA_KEY,
        key.account_metadata
            .get(ZAI_TEAM_ORGANIZATION_METADATA_KEY)
            .map(String::as_str),
    );
    hash_field(
        &mut hasher,
        ZAI_TEAM_PROJECT_METADATA_KEY,
        key.account_metadata
            .get(ZAI_TEAM_PROJECT_METADATA_KEY)
            .map(String::as_str),
    );

    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
#[path = "../tests/quota_credential_revision_tests.rs"]
mod quota_credential_revision_tests;

async fn refresh_oauth_key_for_quota(
    key: &crate::key_store::ModelKey,
) -> Result<crate::key_store::ModelKey, String> {
    let rejected_access_token = key.session_token.clone().unwrap_or_default();
    let outcome = match key.model_type {
        ModelType::ClaudeCode => {
            KEY_SERVICE
                .refresh_claude_code_oauth_key(&key.id, &rejected_access_token)
                .await
        }
        ModelType::Codex => {
            KEY_SERVICE
                .refresh_codex_oauth_key(&key.id, &rejected_access_token)
                .await
        }
        ref other => Err(format!(
            "OAuth quota refresh is not supported for {}",
            other.as_str()
        )),
    }?;
    outcome
        .into_key()
        .ok_or_else(|| format!("Key {} is not a native OAuth account", key.id))
}

fn is_unauthorized_quota_error(error_message: &str) -> bool {
    let lower = error_message.to_lowercase();
    lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("expired")
}
