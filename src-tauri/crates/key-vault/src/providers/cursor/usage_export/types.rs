use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::key_store::{ModelKey, ModelType};

/// A Key Vault Cursor account and its browser session credential.
///
/// `Debug` is implemented manually so the raw session token can never appear
/// in diagnostics.
#[derive(Clone)]
pub struct CursorUsageAccount {
    pub account_id: String,
    pub(super) session_token: String,
}

impl CursorUsageAccount {
    pub fn new(
        account_id: impl Into<String>,
        session_token: impl Into<String>,
    ) -> Result<Self, CursorUsageError> {
        let account_id = account_id.into();
        let session_token = session_token.into();
        if account_id.trim().is_empty() {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::InvalidAccount,
                "Cursor account id is empty",
            ));
        }
        if session_token.trim().is_empty() {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::InvalidAccount,
                "Cursor session token is empty",
            ));
        }
        Ok(Self {
            account_id,
            session_token,
        })
    }

    /// Build an export account from one stored Cursor Key Vault entry.
    pub fn from_model_key(key: &ModelKey) -> Result<Self, CursorUsageError> {
        if key.model_type != ModelType::CursorCli {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::InvalidAccount,
                format!("Key {} is not a Cursor account", key.id),
            ));
        }
        let token = key
            .session_token
            .as_deref()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| {
                CursorUsageError::new(
                    CursorUsageFailureKind::InvalidAccount,
                    format!("Cursor account {} has no web session token", key.id),
                )
            })?;
        Self::new(key.id.clone(), token.to_string())
    }

    pub(super) fn credential_fingerprint(&self) -> String {
        sha256_hex(self.session_token.as_bytes())
    }
}

impl fmt::Debug for CursorUsageAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CursorUsageAccount")
            .field("account_id", &self.account_id)
            .field("session_token", &"<redacted>")
            .finish()
    }
}

/// Source identity carried by every billing record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorUsageRecordSource {
    CursorBillingExport,
}

/// Whether a metric is exact, derived, or unavailable.
///
/// Unavailable values remain `None`; they are never emitted as a synthetic
/// zero. `Included` and `NoCharge` preserve Cursor's non-numeric cost labels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorUsageMetricQuality {
    Exact,
    Derived,
    Included,
    NoCharge,
    Missing,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageEventQuality {
    pub input_tokens: CursorUsageMetricQuality,
    pub output_tokens: CursorUsageMetricQuality,
    pub cache_read_tokens: CursorUsageMetricQuality,
    pub cache_write_tokens: CursorUsageMetricQuality,
    pub cost_usd: CursorUsageMetricQuality,
}

/// One row from Cursor's billing export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageEvent {
    pub occurred_at: String,
    pub occurred_at_ms: i64,
    pub model: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub source: CursorUsageRecordSource,
    pub quality: CursorUsageEventQuality,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageDataQuality {
    pub total_rows: usize,
    pub emitted_rows: usize,
    pub skipped_rows: usize,
    pub complete_rows: usize,
    pub partial_rows: usize,
    pub missing_metric_values: usize,
    pub invalid_metric_values: usize,
}

/// Account-level totals computed while validating the raw CSV.
///
/// Missing or invalid individual values are excluded rather than converted to
/// zero. [`CursorUsageDataQuality`] reports how much data was incomplete.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: f64,
    pub exact_cost_rows: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageSummary {
    pub data_quality: CursorUsageDataQuality,
    pub totals: CursorUsageTotals,
    pub raw_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorUsageSnapshotSource {
    Network,
    FreshCache,
    LastGoodCache,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorUsageFailureKind {
    InvalidAccount,
    Unauthorized,
    Network,
    InvalidExport,
    Cache,
    AttemptCooldown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageSyncFailure {
    pub kind: CursorUsageFailureKind,
    pub message: String,
}

impl CursorUsageSyncFailure {
    pub(super) fn new(kind: CursorUsageFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorUsageError {
    pub failure: CursorUsageSyncFailure,
}

impl CursorUsageError {
    pub(super) fn new(kind: CursorUsageFailureKind, message: impl Into<String>) -> Self {
        Self {
            failure: CursorUsageSyncFailure::new(kind, message),
        }
    }
}

impl fmt::Display for CursorUsageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.failure.message)
    }
}

impl std::error::Error for CursorUsageError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsageSnapshot {
    pub account_id: String,
    pub fetched_at: DateTime<Utc>,
    pub last_sync_attempt_at: Option<DateTime<Utc>>,
    pub source: CursorUsageSnapshotSource,
    pub is_stale: bool,
    pub summary: CursorUsageSummary,
    pub sync_failure: Option<CursorUsageSyncFailure>,
}

/// One bounded page read from the private raw last-good CSV.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsagePage {
    pub account_id: String,
    pub fetched_at: DateTime<Utc>,
    pub events: Vec<CursorUsageEvent>,
    /// Opaque snapshot-bound cursor. `None` means the raw file is exhausted.
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedCursorUsageCache {
    pub archived_last_good: bool,
    pub archived_attempt_marker: bool,
}

pub(super) fn sha256_hex(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
