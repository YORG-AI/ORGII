//! OAuth failure bookkeeping: refresh-failure counters, upstream health
//! marking, temporary-unavailability cooldowns, and the per-key refresh lock.

use chrono::{Duration as ChronoDuration, Utc};
use std::sync::Arc;

use super::super::types::{AuthMethod, HealthStatus, ModelKey, ModelType};
use super::KeyService;

const OAUTH_REFRESH_FAILURE_DISABLE_THRESHOLD: u32 = 3;
const OAUTH_TEMPORARY_UNAVAILABLE_SECONDS: i64 = 30 * 60;
const OAUTH_RATE_LIMIT_FALLBACK_SECONDS: i64 = 5 * 60;
const OAUTH_REFRESH_FAILURE_COOLDOWN_SECONDS: i64 = 5 * 60;

fn is_permanent_oauth_refresh_failure(error_message: &str) -> bool {
    let lower = error_message.to_lowercase();
    lower.contains("refresh token not found or invalid")
        || lower.contains("invalid_grant")
        || lower.contains("invalid refresh token")
        || lower.contains("refresh token expired")
        || lower.contains("refresh_token expired")
}

impl KeyService {
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
                .unwrap_or(match status {
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

    pub(super) fn reset_oauth_refresh_failure_state(entry: &mut ModelKey) {
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

    pub(super) fn oauth_refresh_lock_for_key(
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
}
