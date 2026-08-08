//! Exact Cursor billing-usage export with an account-scoped last-good cache.
//!
//! This module reads Cursor's dashboard billing export. It intentionally does
//! not read, merge, or write local Cursor session history: billing events and
//! local context history have different identities and combining them would
//! double-count usage. Callers must keep this source labelled
//! [`CursorUsageRecordSource::CursorBillingExport`].
//!
//! HTTP chunks are written directly to a private staged CSV. Validation
//! computes only bounded summary metadata; event rows cross IPC exclusively
//! through a hard-capped cursor page.
//!
//! Cache identity includes the endpoint and the Key Vault account id. The
//! cached envelope additionally records a fingerprint of the session token, so
//! replacing a credential under the same Key Vault id cannot expose the
//! previous identity's last-good data.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as StdMutex, Weak};
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, COOKIE, REFERER, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use uuid::Uuid;

use crate::key_store::{ModelKey, ModelType, KEY_SERVICE};

/// Cursor's exact dashboard billing export.
pub const CURSOR_USAGE_EXPORT_URL: &str =
    "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";

/// Successful data and failed attempts are both throttled for five minutes.
pub const CURSOR_USAGE_CACHE_FRESHNESS: Duration = Duration::from_secs(5 * 60);

const CURSOR_USAGE_HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const CURSOR_USAGE_CACHE_VERSION: u32 = 2;
const CURSOR_USAGE_ATTEMPT_VERSION: u32 = 1;
// This is a disk/network safety limit, not an in-memory body allocation.
const MAX_CURSOR_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_CURSOR_CSV_RECORD_BYTES: usize = 256 * 1024;
const MAX_CURSOR_METADATA_BYTES: usize = 256 * 1024;
pub const DEFAULT_CURSOR_USAGE_PAGE_SIZE: usize = 100;
pub const MAX_CURSOR_USAGE_PAGE_SIZE: usize = 200;
const MAX_CURSOR_USAGE_PAGE_SCAN_ROWS: usize = 1_000;
const MAX_CURSOR_USAGE_PAGE_SCAN_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVE_ACCOUNT_LANES: usize = 64;
const OVERFLOW_ACCOUNT_LANES: usize = 16;

/// Cursor exports are intentionally serialized globally. A single export can
/// stream and validate tens of MiB; parallel parsers would create CPU/I/O
/// spikes without improving one account's freshness.
pub const CURSOR_USAGE_MAX_CONCURRENT_EXPORTS: usize = 1;

static CURSOR_USAGE_NETWORK_PERMITS: Semaphore =
    Semaphore::const_new(CURSOR_USAGE_MAX_CONCURRENT_EXPORTS);

// Equivalent requests for one account share a lane, while unrelated accounts
// can refresh concurrently. Finished lanes are weak and evicted on the next
// lookup. The map is capped; excess simultaneous accounts fall into a fixed
// set of bounded overflow shards rather than growing process memory forever.
static CURSOR_USAGE_SYNC_LANES: LazyLock<CursorUsageSyncLanes> =
    LazyLock::new(CursorUsageSyncLanes::new);

struct CursorUsageSyncLanes {
    active: StdMutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    overflow: [Arc<AsyncMutex<()>>; OVERFLOW_ACCOUNT_LANES],
}

impl CursorUsageSyncLanes {
    fn new() -> Self {
        Self {
            active: StdMutex::new(HashMap::new()),
            overflow: std::array::from_fn(|_| Arc::new(AsyncMutex::new(()))),
        }
    }

    fn lane(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.retain(|_, lane| lane.strong_count() > 0);
        if let Some(lane) = active.get(key).and_then(Weak::upgrade) {
            return lane;
        }
        if active.len() < MAX_ACTIVE_ACCOUNT_LANES {
            let lane = Arc::new(AsyncMutex::new(()));
            active.insert(key.to_string(), Arc::downgrade(&lane));
            return lane;
        }

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hasher);
        Arc::clone(&self.overflow[hasher.finish() as usize % OVERFLOW_ACCOUNT_LANES])
    }
}

/// A Key Vault Cursor account and its browser session credential.
///
/// `Debug` is implemented manually so the raw session token can never appear
/// in diagnostics.
#[derive(Clone)]
pub struct CursorUsageAccount {
    pub account_id: String,
    session_token: String,
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

    fn credential_fingerprint(&self) -> String {
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
    fn new(kind: CursorUsageFailureKind, message: impl Into<String>) -> Self {
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
    fn new(kind: CursorUsageFailureKind, message: impl Into<String>) -> Self {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorUsageCacheEnvelope {
    version: u32,
    endpoint: String,
    account_id: String,
    credential_fingerprint: String,
    fetched_at: DateTime<Utc>,
    snapshot_id: String,
    raw_file_name: String,
    data_start_offset: u64,
    summary: CursorUsageSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CursorUsageAttemptOutcome {
    Started,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorUsageAttemptMarker {
    version: u32,
    endpoint: String,
    account_id: String,
    credential_fingerprint: String,
    attempted_at: DateTime<Utc>,
    outcome: CursorUsageAttemptOutcome,
    failure: Option<CursorUsageSyncFailure>,
}

/// Account-scoped Cursor billing exporter.
pub struct CursorUsageExporter {
    client: reqwest::Client,
    cache_root: PathBuf,
    endpoint: String,
    freshness: Duration,
}

impl CursorUsageExporter {
    /// Use the default Key Vault data root (`~/.orgii/cache/cursor-usage`).
    pub fn for_key_vault() -> Result<Self, CursorUsageError> {
        Self::new(
            KEY_SERVICE
                .get_storage_dir()
                .join("cache")
                .join("cursor-usage"),
        )
    }

    pub fn new(cache_root: PathBuf) -> Result<Self, CursorUsageError> {
        Self::with_endpoint_and_freshness(
            cache_root,
            CURSOR_USAGE_EXPORT_URL,
            CURSOR_USAGE_CACHE_FRESHNESS,
        )
    }

    /// Constructor with injectable endpoint/freshness for integration tests.
    pub fn with_endpoint_and_freshness(
        cache_root: PathBuf,
        endpoint: impl Into<String>,
        freshness: Duration,
    ) -> Result<Self, CursorUsageError> {
        let client = reqwest::Client::builder()
            .timeout(CURSOR_USAGE_HTTP_TIMEOUT)
            .build()
            .map_err(|error| {
                CursorUsageError::new(
                    CursorUsageFailureKind::Network,
                    format!("Failed to build Cursor usage HTTP client: {error}"),
                )
            })?;
        Ok(Self {
            client,
            cache_root,
            endpoint: endpoint.into(),
            freshness,
        })
    }

    pub fn cache_path_for_account(&self, account_id: &str) -> PathBuf {
        self.cache_root.join(format!(
            "{}.last-good.json",
            self.account_file_stem(account_id)
        ))
    }

    pub fn attempt_marker_path_for_account(&self, account_id: &str) -> PathBuf {
        self.cache_root.join(format!(
            "{}.last-sync-attempt.json",
            self.account_file_stem(account_id)
        ))
    }

    fn staged_raw_path_for_account(&self, account_id: &str) -> PathBuf {
        self.cache_root.join(format!(
            ".{}.download.tmp",
            self.account_file_stem(account_id)
        ))
    }

    fn published_raw_file_name(
        &self,
        account_id: &str,
        previous: Option<&CursorUsageCacheEnvelope>,
    ) -> String {
        alternate_raw_slot(&self.account_file_stem(account_id), previous)
    }

    /// Load a fresh account cache or fetch the exact Cursor billing export.
    ///
    /// A failed attempt returns the matching stale last-good cache when one
    /// exists. A recent failure marker suppresses another request for the same
    /// account/credential until the five-minute cooldown expires. `force`
    /// bypasses both freshness gates.
    pub async fn sync_account(
        &self,
        account: &CursorUsageAccount,
        force: bool,
    ) -> Result<CursorUsageSnapshot, CursorUsageError> {
        self.sync_account_with_fetcher(account, force, Utc::now(), |staged_path| {
            self.fetch_usage_csv_to(&account.session_token, staged_path)
        })
        .await
    }

    /// Read one bounded page from the current account/credential's raw cache.
    ///
    /// The cursor binds the previous page's snapshot identity to a byte offset.
    /// Stale snapshots and offsets outside a CSV record boundary are rejected.
    pub async fn read_account_page(
        &self,
        account: &CursorUsageAccount,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<CursorUsagePage, CursorUsageError> {
        let lane = CURSOR_USAGE_SYNC_LANES.lane(&self.account_file_stem(&account.account_id));
        let _guard = lane.lock().await;
        let envelope = self.read_matching_cache(account).await.ok_or_else(|| {
            CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                "Cursor billing usage has no matching last-good cache",
            )
        })?;
        let raw_path = self.raw_path_from_envelope(&envelope)?;
        let snapshot_tag = snapshot_cursor_tag(&envelope.snapshot_id);
        let start_cursor = match cursor {
            Some(value) => {
                let (tag, offset) = value.split_once(':').ok_or_else(|| {
                    CursorUsageError::new(
                        CursorUsageFailureKind::InvalidExport,
                        "Cursor usage page cursor is invalid",
                    )
                })?;
                if tag != snapshot_tag.as_str() {
                    return Err(CursorUsageError::new(
                        CursorUsageFailureKind::InvalidExport,
                        "Cursor usage page cursor belongs to a different snapshot",
                    ));
                }
                offset.parse::<u64>().map_err(|_| {
                    CursorUsageError::new(
                        CursorUsageFailureKind::InvalidExport,
                        "Cursor usage page cursor is invalid",
                    )
                })?
            }
            None => envelope.data_start_offset,
        };
        let bounded_limit = limit.clamp(1, MAX_CURSOR_USAGE_PAGE_SIZE);
        let expected_bytes = envelope.summary.raw_bytes;
        let expected_data_start = envelope.data_start_offset;
        let page = tokio::task::spawn_blocking(move || {
            read_cursor_usage_page(
                &raw_path,
                start_cursor,
                bounded_limit,
                expected_bytes,
                expected_data_start,
            )
        })
        .await
        .map_err(|error| {
            CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                format!("Cursor usage page task failed: {error}"),
            )
        })?
        .map_err(|message| CursorUsageError::new(CursorUsageFailureKind::InvalidExport, message))?;

        Ok(CursorUsagePage {
            account_id: envelope.account_id,
            fetched_at: envelope.fetched_at,
            events: page.events,
            next_cursor: page
                .next_cursor
                .map(|value| format!("{snapshot_tag}:{value}")),
            has_more: page.has_more,
        })
    }

    /// Move an account's active cache into one bounded archive slot.
    ///
    /// The archive is not read automatically. This helper is intended for
    /// logout/account removal: it preserves one recoverable last-good copy
    /// without allowing archives to grow without bound.
    pub async fn archive_account_cache(
        &self,
        account_id: &str,
    ) -> Result<ArchivedCursorUsageCache, CursorUsageError> {
        let lane = CURSOR_USAGE_SYNC_LANES.lane(&self.account_file_stem(account_id));
        let _guard = lane.lock().await;
        let archive_root = self.cache_root.join("archive");
        let stem = self.account_file_stem(account_id);
        let cache_path = self.cache_path_for_account(account_id);
        let attempt_path = self.attempt_marker_path_for_account(account_id);
        let archive_cache_path = archive_root.join(format!("{stem}.last-good.json"));
        let archive_attempt_path = archive_root.join(format!("{stem}.last-sync-attempt.json"));
        let active_envelope = read_small_json::<CursorUsageCacheEnvelope>(&cache_path)
            .await
            .filter(|envelope| {
                envelope.version == CURSOR_USAGE_CACHE_VERSION
                    && envelope.endpoint == self.endpoint
                    && envelope.account_id == account_id
            });
        let archived_envelope =
            read_small_json::<CursorUsageCacheEnvelope>(&archive_cache_path).await;

        let archived_last_good = if let Some(mut envelope) = active_envelope {
            let active_raw = self.raw_path_from_envelope(&envelope)?;
            let archive_raw_name = alternate_raw_slot(&stem, archived_envelope.as_ref());
            let archive_raw = archive_root.join(&archive_raw_name);
            atomic_copy_file(&active_raw, &archive_raw, MAX_CURSOR_EXPORT_BYTES as u64).await?;
            envelope.raw_file_name = archive_raw_name;
            if let Err(error) = atomic_write_json(&archive_cache_path, &envelope).await {
                let _ = tokio::fs::remove_file(&archive_raw).await;
                return Err(error);
            }
            if let Some(previous) = archived_envelope {
                if let Ok(previous_raw) =
                    safe_raw_path(&archive_root, &stem, &previous.raw_file_name)
                {
                    if previous_raw != archive_raw {
                        let _ = tokio::fs::remove_file(previous_raw).await;
                    }
                }
            }
            remove_file_if_present(&active_raw).await?;
            remove_file_if_present(&cache_path).await?;
            true
        } else {
            false
        };
        let archived_attempt_marker =
            atomic_archive_file_if_present(&attempt_path, &archive_attempt_path).await?;

        Ok(ArchivedCursorUsageCache {
            archived_last_good,
            archived_attempt_marker,
        })
    }

    async fn sync_account_with_fetcher<F, Fut>(
        &self,
        account: &CursorUsageAccount,
        force: bool,
        now: DateTime<Utc>,
        fetcher: F,
    ) -> Result<CursorUsageSnapshot, CursorUsageError>
    where
        F: FnOnce(PathBuf) -> Fut,
        Fut: Future<Output = Result<u64, CursorUsageSyncFailure>>,
    {
        let lane = CURSOR_USAGE_SYNC_LANES.lane(&self.account_file_stem(&account.account_id));
        let _guard = lane.lock().await;
        let previous_envelope = read_small_json::<CursorUsageCacheEnvelope>(
            &self.cache_path_for_account(&account.account_id),
        )
        .await
        .filter(|envelope| {
            envelope.version == CURSOR_USAGE_CACHE_VERSION
                && envelope.endpoint == self.endpoint
                && envelope.account_id == account.account_id
        });
        let cached = self.read_matching_cache(account).await;
        let attempt = self.read_matching_attempt(account).await;

        if !force {
            if let Some(envelope) = cached
                .as_ref()
                .filter(|cache| timestamp_is_fresh(cache.fetched_at, now, self.freshness))
            {
                return Ok(snapshot_from_cache(
                    envelope,
                    attempt.as_ref().map(|value| value.attempted_at),
                    CursorUsageSnapshotSource::FreshCache,
                    false,
                    None,
                ));
            }

            if let Some(recent_attempt) = attempt
                .as_ref()
                .filter(|marker| timestamp_is_fresh(marker.attempted_at, now, self.freshness))
            {
                let failure = recent_attempt.failure.clone().unwrap_or_else(|| {
                    CursorUsageSyncFailure::new(
                        CursorUsageFailureKind::AttemptCooldown,
                        "Cursor usage sync was already attempted recently",
                    )
                });
                return fallback_or_error(cached.as_ref(), recent_attempt.attempted_at, failure);
            }
        }

        // This permit is intentionally acquired after both cache gates. Fresh
        // reads and cooldown fallbacks never join the upstream queue.
        let network_permit = match CURSOR_USAGE_NETWORK_PERMITS.acquire().await {
            Ok(permit) => permit,
            Err(_) => {
                let failure = CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::Network,
                    "Cursor usage network queue is unavailable",
                );
                return fallback_or_error(cached.as_ref(), now, failure);
            }
        };

        let started_marker =
            self.attempt_marker(account, now, CursorUsageAttemptOutcome::Started, None);
        if let Err(error) = self.write_attempt_marker(&started_marker, account).await {
            let failure = CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to persist Cursor sync-attempt marker: {error}"),
            );
            return fallback_or_error(cached.as_ref(), now, failure);
        }

        if let Err(error) = self.ensure_cache_root().await {
            drop(network_permit);
            let failure = CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to prepare Cursor usage cache: {error}"),
            );
            return fallback_or_error(cached.as_ref(), now, failure);
        }
        let staged_raw_path = self.staged_raw_path_for_account(&account.account_id);
        if let Err(error) = remove_file_if_present(&staged_raw_path).await {
            drop(network_permit);
            let failure = CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to clear Cursor usage staging slot: {error}"),
            );
            return fallback_or_error(cached.as_ref(), now, failure);
        }
        let fetch_result = fetcher(staged_raw_path.clone()).await;
        let fetched = match fetch_result {
            Ok(downloaded_bytes) => self
                .prepare_staged_export(&staged_raw_path, downloaded_bytes)
                .await
                .map_err(|error| {
                    CursorUsageSyncFailure::new(
                        CursorUsageFailureKind::InvalidExport,
                        error.to_string(),
                    )
                }),
            Err(failure) => Err(failure),
        };

        let parsed = match fetched {
            Ok(()) => {
                let parse_path = staged_raw_path.clone();
                tokio::task::spawn_blocking(move || summarize_cursor_usage_file(&parse_path))
                    .await
                    .map_err(|error| {
                        CursorUsageSyncFailure::new(
                            CursorUsageFailureKind::InvalidExport,
                            format!("Cursor usage parser task failed: {error}"),
                        )
                    })
                    .and_then(|result| {
                        result.map_err(|message| {
                            CursorUsageSyncFailure::new(
                                CursorUsageFailureKind::InvalidExport,
                                message,
                            )
                        })
                    })
            }
            Err(failure) => Err(failure),
        };

        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(failure) => {
                drop(network_permit);
                let _ = tokio::fs::remove_file(&staged_raw_path).await;
                let failed_marker = self.attempt_marker(
                    account,
                    now,
                    CursorUsageAttemptOutcome::Failed,
                    Some(failure.clone()),
                );
                let _ = self.write_attempt_marker(&failed_marker, account).await;
                return fallback_or_error(cached.as_ref(), now, failure);
            }
        };

        let raw_file_name =
            self.published_raw_file_name(&account.account_id, previous_envelope.as_ref());
        let published_raw_path = self.cache_root.join(&raw_file_name);
        if let Err(error) = replace_with_staged_file(&staged_raw_path, &published_raw_path).await {
            drop(network_permit);
            let failure = CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to publish Cursor raw usage cache: {error}"),
            );
            let failed_marker = self.attempt_marker(
                account,
                now,
                CursorUsageAttemptOutcome::Failed,
                Some(failure.clone()),
            );
            let _ = self.write_attempt_marker(&failed_marker, account).await;
            return fallback_or_error(cached.as_ref(), now, failure);
        }

        let envelope = CursorUsageCacheEnvelope {
            version: CURSOR_USAGE_CACHE_VERSION,
            endpoint: self.endpoint.clone(),
            account_id: account.account_id.clone(),
            credential_fingerprint: account.credential_fingerprint(),
            fetched_at: now,
            snapshot_id: Uuid::new_v4().to_string(),
            raw_file_name,
            data_start_offset: parsed.data_start_offset,
            summary: CursorUsageSummary {
                data_quality: parsed.data_quality,
                totals: parsed.totals,
                raw_bytes: parsed.raw_bytes,
            },
        };

        if let Err(error) = self.write_cache(&envelope, account).await {
            drop(network_permit);
            let _ = tokio::fs::remove_file(&published_raw_path).await;
            let failure = CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to persist Cursor last-good cache: {error}"),
            );
            let failed_marker = self.attempt_marker(
                account,
                now,
                CursorUsageAttemptOutcome::Failed,
                Some(failure.clone()),
            );
            let _ = self.write_attempt_marker(&failed_marker, account).await;
            return fallback_or_error(cached.as_ref(), now, failure);
        }
        if let Some(previous) = previous_envelope.as_ref() {
            if let Ok(previous_raw) = self.raw_path_from_envelope(previous) {
                if previous_raw != published_raw_path {
                    let _ = tokio::fs::remove_file(previous_raw).await;
                }
            }
        }
        drop(network_permit);

        let succeeded_marker =
            self.attempt_marker(account, now, CursorUsageAttemptOutcome::Succeeded, None);
        let marker_failure = self
            .write_attempt_marker(&succeeded_marker, account)
            .await
            .err()
            .map(|error| {
                CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::Cache,
                    format!("Cursor usage synced, but the attempt marker update failed: {error}"),
                )
            });

        Ok(CursorUsageSnapshot {
            account_id: envelope.account_id,
            fetched_at: envelope.fetched_at,
            last_sync_attempt_at: Some(now),
            source: CursorUsageSnapshotSource::Network,
            is_stale: false,
            summary: envelope.summary,
            sync_failure: marker_failure,
        })
    }

    async fn fetch_usage_csv_to(
        &self,
        session_token: &str,
        staged_path: PathBuf,
    ) -> Result<u64, CursorUsageSyncFailure> {
        let auth_attempts = cursor_auth_attempts(session_token);
        let auth_attempt_count = auth_attempts.len();
        let mut response = None;
        for (index, auth) in auth_attempts.into_iter().enumerate() {
            let current = self
                .client
                .get(&self.endpoint)
                .headers(cursor_headers(&auth)?)
                .send()
                .await
                .map_err(|error| {
                    CursorUsageSyncFailure::new(
                        CursorUsageFailureKind::Network,
                        format!("Cursor usage request failed: {error}"),
                    )
                })?;
            let may_retry_auth = index + 1 < auth_attempt_count;
            if is_auth_failure(current.status()) && may_retry_auth {
                continue;
            }
            response = Some(current);
            break;
        }
        let mut response = response.ok_or_else(|| {
            CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Unauthorized,
                "Cursor web session is expired or unauthorized",
            )
        })?;

        if is_auth_failure(response.status()) {
            return Err(CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Unauthorized,
                "Cursor web session is expired or unauthorized",
            ));
        }
        if !response.status().is_success() {
            return Err(CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Network,
                format!("Cursor usage API returned HTTP {}", response.status()),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_CURSOR_EXPORT_BYTES as u64)
        {
            return Err(CursorUsageSyncFailure::new(
                CursorUsageFailureKind::InvalidExport,
                "Cursor usage export exceeds the 64 MiB safety limit",
            ));
        }

        let mut file = open_sensitive_new(&staged_path).await.map_err(|error| {
            CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to stage Cursor usage export: {error}"),
            )
        })?;
        let mut downloaded_bytes = 0_u64;
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Network,
                format!("Failed to read Cursor usage response: {error}"),
            )
        })? {
            downloaded_bytes = downloaded_bytes
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| {
                    CursorUsageSyncFailure::new(
                        CursorUsageFailureKind::InvalidExport,
                        "Cursor usage export byte count overflowed",
                    )
                })?;
            if downloaded_bytes > MAX_CURSOR_EXPORT_BYTES as u64 {
                return Err(CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::InvalidExport,
                    "Cursor usage export exceeds the 64 MiB safety limit",
                ));
            }
            file.write_all(&chunk).await.map_err(|error| {
                CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::Cache,
                    format!("Failed to write Cursor usage staging file: {error}"),
                )
            })?;
        }
        file.sync_all().await.map_err(|error| {
            CursorUsageSyncFailure::new(
                CursorUsageFailureKind::Cache,
                format!("Failed to sync Cursor usage staging file: {error}"),
            )
        })?;
        Ok(downloaded_bytes)
    }

    async fn read_matching_cache(
        &self,
        account: &CursorUsageAccount,
    ) -> Option<CursorUsageCacheEnvelope> {
        let envelope = read_small_json::<CursorUsageCacheEnvelope>(
            &self.cache_path_for_account(&account.account_id),
        )
        .await?;
        if !self.cache_matches_account(&envelope, account) {
            return None;
        }
        let raw_path = self.raw_path_from_envelope(&envelope).ok()?;
        let metadata = tokio::fs::symlink_metadata(raw_path).await.ok()?;
        (metadata.file_type().is_file()
            && metadata.len() == envelope.summary.raw_bytes
            && metadata.len() <= MAX_CURSOR_EXPORT_BYTES as u64)
            .then_some(envelope)
    }

    async fn read_matching_attempt(
        &self,
        account: &CursorUsageAccount,
    ) -> Option<CursorUsageAttemptMarker> {
        let marker = read_small_json::<CursorUsageAttemptMarker>(
            &self.attempt_marker_path_for_account(&account.account_id),
        )
        .await?;
        self.attempt_matches_account(&marker, account)
            .then_some(marker)
    }

    fn cache_matches_account(
        &self,
        envelope: &CursorUsageCacheEnvelope,
        account: &CursorUsageAccount,
    ) -> bool {
        envelope.version == CURSOR_USAGE_CACHE_VERSION
            && envelope.endpoint == self.endpoint
            && envelope.account_id == account.account_id
            && envelope.credential_fingerprint == account.credential_fingerprint()
    }

    fn attempt_matches_account(
        &self,
        marker: &CursorUsageAttemptMarker,
        account: &CursorUsageAccount,
    ) -> bool {
        marker.version == CURSOR_USAGE_ATTEMPT_VERSION
            && marker.endpoint == self.endpoint
            && marker.account_id == account.account_id
            && marker.credential_fingerprint == account.credential_fingerprint()
    }

    fn attempt_marker(
        &self,
        account: &CursorUsageAccount,
        attempted_at: DateTime<Utc>,
        outcome: CursorUsageAttemptOutcome,
        failure: Option<CursorUsageSyncFailure>,
    ) -> CursorUsageAttemptMarker {
        CursorUsageAttemptMarker {
            version: CURSOR_USAGE_ATTEMPT_VERSION,
            endpoint: self.endpoint.clone(),
            account_id: account.account_id.clone(),
            credential_fingerprint: account.credential_fingerprint(),
            attempted_at,
            outcome,
            failure,
        }
    }

    async fn write_cache(
        &self,
        envelope: &CursorUsageCacheEnvelope,
        account: &CursorUsageAccount,
    ) -> Result<(), CursorUsageError> {
        atomic_write_json(&self.cache_path_for_account(&account.account_id), envelope).await
    }

    async fn write_attempt_marker(
        &self,
        marker: &CursorUsageAttemptMarker,
        account: &CursorUsageAccount,
    ) -> Result<(), CursorUsageError> {
        atomic_write_json(
            &self.attempt_marker_path_for_account(&account.account_id),
            marker,
        )
        .await
    }

    async fn ensure_cache_root(&self) -> Result<(), CursorUsageError> {
        tokio::fs::create_dir_all(&self.cache_root)
            .await
            .map_err(cache_io_error)?;
        set_sensitive_directory_permissions(&self.cache_root).await
    }

    async fn prepare_staged_export(
        &self,
        path: &Path,
        reported_bytes: u64,
    ) -> Result<(), CursorUsageError> {
        let metadata = tokio::fs::symlink_metadata(path)
            .await
            .map_err(cache_io_error)?;
        if !metadata.file_type().is_file() {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::InvalidExport,
                "Cursor usage staging path is not a regular file",
            ));
        }
        if metadata.len() != reported_bytes {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::InvalidExport,
                "Cursor usage staging size does not match the downloaded byte count",
            ));
        }
        if metadata.len() > MAX_CURSOR_EXPORT_BYTES as u64 {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::InvalidExport,
                "Cursor usage export exceeds the 64 MiB safety limit",
            ));
        }
        set_sensitive_file_permissions(path).await?;
        Ok(())
    }

    fn raw_path_from_envelope(
        &self,
        envelope: &CursorUsageCacheEnvelope,
    ) -> Result<PathBuf, CursorUsageError> {
        safe_raw_path(
            &self.cache_root,
            &self.account_file_stem(&envelope.account_id),
            &envelope.raw_file_name,
        )
    }

    fn account_file_stem(&self, account_id: &str) -> String {
        let scope = format!("{}\0{}", self.endpoint, account_id);
        format!("account-{}", &sha256_hex(scope.as_bytes())[..32])
    }
}

/// Sync one stored Cursor Key Vault account without touching local session
/// history. This is the narrow Rust entry point for background coordinators
/// and command wrappers.
pub async fn sync_key_vault_cursor_billing_usage(
    account_id: String,
    force: bool,
) -> Result<CursorUsageSnapshot, CursorUsageError> {
    let account = load_key_vault_cursor_usage_account(account_id).await?;
    CursorUsageExporter::for_key_vault()?
        .sync_account(&account, force)
        .await
}

async fn load_key_vault_cursor_usage_account(
    account_id: String,
) -> Result<CursorUsageAccount, CursorUsageError> {
    let lookup_id = account_id.clone();
    let key = tokio::task::spawn_blocking(move || {
        KEY_SERVICE.get_key_checked(&ModelType::CursorCli, Some(&lookup_id))
    })
    .await
    .map_err(|error| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            format!("Cursor account lookup task failed: {error}"),
        )
    })?
    .map_err(|error| CursorUsageError::new(CursorUsageFailureKind::Cache, error))?
    .ok_or_else(|| {
        CursorUsageError::new(
            CursorUsageFailureKind::InvalidAccount,
            format!("Cursor account {account_id} was not found"),
        )
    })?;
    CursorUsageAccount::from_model_key(&key)
}

/// Tauri-ready command. The app crate only needs to register this symbol in
/// its handler list; no duplicate fetch/cache implementation is required.
#[tauri::command]
pub async fn cursor_sync_billing_usage(
    account_id: String,
    force: bool,
) -> Result<CursorUsageSnapshot, String> {
    sync_key_vault_cursor_billing_usage(account_id, force)
        .await
        .map_err(|error| error.to_string())
}

/// Read a hard-bounded page from the current account's private raw cache.
#[tauri::command]
pub async fn cursor_read_billing_usage_page(
    account_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<CursorUsagePage, String> {
    let account = load_key_vault_cursor_usage_account(account_id)
        .await
        .map_err(|error| error.to_string())?;
    CursorUsageExporter::for_key_vault()
        .map_err(|error| error.to_string())?
        .read_account_page(
            &account,
            cursor.as_deref(),
            limit.unwrap_or(DEFAULT_CURSOR_USAGE_PAGE_SIZE),
        )
        .await
        .map_err(|error| error.to_string())
}

/// Tauri-ready logout hook for the bounded, recoverable account archive.
#[tauri::command]
pub async fn cursor_archive_billing_usage_cache(
    account_id: String,
) -> Result<ArchivedCursorUsageCache, String> {
    CursorUsageExporter::for_key_vault()
        .map_err(|error| error.to_string())?
        .archive_account_cache(&account_id)
        .await
        .map_err(|error| error.to_string())
}

enum CursorAuthAttempt {
    Cookie(String),
    Bearer(String),
}

fn cursor_headers(auth: &CursorAuthAttempt) -> Result<HeaderMap, CursorUsageSyncFailure> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("text/csv,*/*;q=0.9"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://www.cursor.com/settings"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
        ),
    );
    match auth {
        CursorAuthAttempt::Cookie(session_token) => {
            let cookie =
                HeaderValue::from_str(&format!("WorkosCursorSessionToken={session_token}"))
                    .map_err(|_| {
                        CursorUsageSyncFailure::new(
                            CursorUsageFailureKind::InvalidAccount,
                            "Cursor session token cannot be encoded as an HTTP cookie",
                        )
                    })?;
            headers.insert(COOKIE, cookie);
        }
        CursorAuthAttempt::Bearer(jwt) => {
            let authorization = HeaderValue::from_str(&format!("Bearer {jwt}")).map_err(|_| {
                CursorUsageSyncFailure::new(
                    CursorUsageFailureKind::InvalidAccount,
                    "Cursor session token cannot be encoded as an authorization header",
                )
            })?;
            headers.insert(AUTHORIZATION, authorization);
        }
    }
    Ok(headers)
}

fn is_auth_failure(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    )
}

fn cursor_auth_attempts(session_token: &str) -> Vec<CursorAuthAttempt> {
    let mut attempts = vec![CursorAuthAttempt::Cookie(session_token.to_string())];
    let raw_jwt = raw_jwt_from_cursor_token(session_token);
    if let Some(alternative) = alternative_cursor_session_token(session_token) {
        push_distinct_auth_attempt(&mut attempts, CursorAuthAttempt::Cookie(alternative));
    }
    if let Some(jwt) = raw_jwt {
        push_distinct_auth_attempt(&mut attempts, CursorAuthAttempt::Bearer(jwt));
    }
    attempts
}

fn push_distinct_auth_attempt(attempts: &mut Vec<CursorAuthAttempt>, candidate: CursorAuthAttempt) {
    let duplicate = attempts
        .iter()
        .any(|existing| match (existing, &candidate) {
            (CursorAuthAttempt::Cookie(left), CursorAuthAttempt::Cookie(right))
            | (CursorAuthAttempt::Bearer(left), CursorAuthAttempt::Bearer(right)) => left == right,
            _ => false,
        });
    if !duplicate {
        attempts.push(candidate);
    }
}

fn raw_jwt_from_cursor_token(token: &str) -> Option<String> {
    if let Some((_, jwt)) = token.split_once("%3A%3A") {
        return (!jwt.is_empty()).then(|| jwt.to_string());
    }
    if let Some((_, jwt)) = token.split_once("::") {
        return (!jwt.is_empty()).then(|| jwt.to_string());
    }
    (token.matches('.').count() >= 2).then(|| token.to_string())
}

fn alternative_cursor_session_token(token: &str) -> Option<String> {
    if let Some(jwt) = raw_jwt_from_cursor_token(token) {
        if token.contains("%3A%3A") || token.contains("::") {
            return Some(jwt);
        }
        return extract_cursor_user_id_from_jwt(&jwt)
            .map(|user_id| format!("{user_id}%3A%3A{jwt}"));
    }
    None
}

fn extract_cursor_user_id_from_jwt(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("sub")
        .or_else(|| value.get("user_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn snapshot_from_cache(
    envelope: &CursorUsageCacheEnvelope,
    last_sync_attempt_at: Option<DateTime<Utc>>,
    source: CursorUsageSnapshotSource,
    is_stale: bool,
    sync_failure: Option<CursorUsageSyncFailure>,
) -> CursorUsageSnapshot {
    CursorUsageSnapshot {
        account_id: envelope.account_id.clone(),
        fetched_at: envelope.fetched_at,
        last_sync_attempt_at,
        source,
        is_stale,
        summary: envelope.summary.clone(),
        sync_failure,
    }
}

fn fallback_or_error(
    cached: Option<&CursorUsageCacheEnvelope>,
    attempted_at: DateTime<Utc>,
    failure: CursorUsageSyncFailure,
) -> Result<CursorUsageSnapshot, CursorUsageError> {
    if let Some(envelope) = cached {
        return Ok(snapshot_from_cache(
            envelope,
            Some(attempted_at),
            CursorUsageSnapshotSource::LastGoodCache,
            true,
            Some(failure),
        ));
    }
    Err(CursorUsageError { failure })
}

fn timestamp_is_fresh(timestamp: DateTime<Utc>, now: DateTime<Utc>, freshness: Duration) -> bool {
    match now.signed_duration_since(timestamp).to_std() {
        Ok(age) => age < freshness,
        // A future timestamp caused by clock skew should not create an API
        // retry loop while the wall clock recovers.
        Err(_) => true,
    }
}

fn sha256_hex(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn snapshot_cursor_tag(snapshot_id: &str) -> String {
    sha256_hex(snapshot_id.as_bytes())[..16].to_string()
}

async fn read_small_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CURSOR_METADATA_BYTES as u64 {
        return None;
    }
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .await
        .ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CURSOR_METADATA_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    if bytes.len() > MAX_CURSOR_METADATA_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

async fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), CursorUsageError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            format!("Failed to serialize Cursor usage cache: {error}"),
        )
    })?;
    atomic_write_bytes(path, &bytes).await
}

async fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), CursorUsageError> {
    let parent = path.parent().ok_or_else(|| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            "Cursor usage cache path has no parent",
        )
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(cache_io_error)?;
    set_sensitive_directory_permissions(parent).await?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cursor-usage");
    let temporary_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let write_result = async {
        let mut file = open_sensitive_new(&temporary_path).await?;
        file.write_all(bytes).await.map_err(cache_io_error)?;
        file.sync_all().await.map_err(cache_io_error)?;
        drop(file);
        replace_with_staged_file(&temporary_path, path).await
    }
    .await;

    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
    }
    write_result
}

async fn open_sensitive_new(path: &Path) -> Result<tokio::fs::File, CursorUsageError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    options.open(path).await.map_err(cache_io_error)
}

async fn atomic_copy_file(
    source: &Path,
    target: &Path,
    max_bytes: u64,
) -> Result<(), CursorUsageError> {
    let parent = target.parent().ok_or_else(|| {
        CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            "Cursor usage archive path has no parent",
        )
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(cache_io_error)?;
    set_sensitive_directory_permissions(parent).await?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cursor-usage");
    let staged = parent.join(format!(".{file_name}.copy.tmp"));
    remove_file_if_present(&staged).await?;
    let copy_result = async {
        let source_file = tokio::fs::OpenOptions::new()
            .read(true)
            .open(source)
            .await
            .map_err(cache_io_error)?;
        let source_metadata = source_file.metadata().await.map_err(cache_io_error)?;
        if !source_metadata.is_file() || source_metadata.len() > max_bytes {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                format!("Cursor usage archive source exceeds the {max_bytes}-byte safety limit"),
            ));
        }
        let mut target_file = open_sensitive_new(&staged).await?;
        let copied = tokio::io::copy(
            &mut source_file.take(max_bytes.saturating_add(1)),
            &mut target_file,
        )
        .await
        .map_err(cache_io_error)?;
        if copied > max_bytes {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                format!("Cursor usage archive source exceeds the {max_bytes}-byte safety limit"),
            ));
        }
        target_file.sync_all().await.map_err(cache_io_error)?;
        drop(target_file);
        replace_with_staged_file(&staged, target).await
    }
    .await;
    if copy_result.is_err() {
        let _ = tokio::fs::remove_file(&staged).await;
    }
    copy_result
}

#[cfg(not(windows))]
async fn replace_with_staged_file(staged: &Path, target: &Path) -> Result<(), CursorUsageError> {
    tokio::fs::rename(staged, target)
        .await
        .map_err(cache_io_error)
}

#[cfg(windows)]
async fn replace_with_staged_file(staged: &Path, target: &Path) -> Result<(), CursorUsageError> {
    // Windows rename does not replace an existing target. Preserve the
    // previous last-good beside it until the staged file is installed, then
    // restore it if installation fails.
    let backup = target.with_extension(format!("backup-{}", Uuid::new_v4()));
    let had_target = tokio::fs::metadata(target).await.is_ok();
    if had_target {
        tokio::fs::rename(target, &backup)
            .await
            .map_err(cache_io_error)?;
    }
    match tokio::fs::rename(staged, target).await {
        Ok(()) => {
            if had_target {
                let _ = tokio::fs::remove_file(backup).await;
            }
            Ok(())
        }
        Err(error) => {
            if had_target {
                let _ = tokio::fs::rename(&backup, target).await;
            }
            Err(cache_io_error(error))
        }
    }
}

async fn set_sensitive_directory_permissions(path: &Path) -> Result<(), CursorUsageError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(cache_io_error)?;
    }
    Ok(())
}

async fn set_sensitive_file_permissions(path: &Path) -> Result<(), CursorUsageError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(cache_io_error)?;
    }
    Ok(())
}

fn cache_io_error(error: std::io::Error) -> CursorUsageError {
    CursorUsageError::new(
        CursorUsageFailureKind::Cache,
        format!("Cursor usage cache I/O failed: {error}"),
    )
}

async fn atomic_archive_file_if_present(
    active_path: &Path,
    archive_path: &Path,
) -> Result<bool, CursorUsageError> {
    match tokio::fs::symlink_metadata(active_path).await {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Err(CursorUsageError::new(
                CursorUsageFailureKind::Cache,
                "Cursor usage archive source is not a regular file",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(cache_io_error(error)),
    }
    atomic_copy_file(active_path, archive_path, MAX_CURSOR_METADATA_BYTES as u64).await?;
    tokio::fs::remove_file(active_path)
        .await
        .map_err(cache_io_error)?;
    Ok(true)
}

async fn remove_file_if_present(path: &Path) -> Result<(), CursorUsageError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(cache_io_error(error)),
    }
}

fn alternate_raw_slot(stem: &str, previous: Option<&CursorUsageCacheEnvelope>) -> String {
    let slot_a = format!("{stem}.slot-a.last-good.csv");
    let slot_b = format!("{stem}.slot-b.last-good.csv");
    if previous.is_some_and(|envelope| envelope.raw_file_name == slot_a) {
        slot_b
    } else {
        slot_a
    }
}

fn safe_raw_path(
    root: &Path,
    expected_stem: &str,
    raw_file_name: &str,
) -> Result<PathBuf, CursorUsageError> {
    let file_name = Path::new(raw_file_name);
    let is_single_component = file_name.components().count() == 1
        && file_name
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == raw_file_name);
    if !is_single_component
        || !raw_file_name.starts_with(expected_stem)
        || !raw_file_name.ends_with(".last-good.csv")
    {
        return Err(CursorUsageError::new(
            CursorUsageFailureKind::Cache,
            "Cursor usage metadata contains an invalid raw-cache path",
        ));
    }
    Ok(root.join(raw_file_name))
}

#[derive(Debug)]
struct ParsedCursorUsageFile {
    data_start_offset: u64,
    raw_bytes: u64,
    data_quality: CursorUsageDataQuality,
    totals: CursorUsageTotals,
}

struct ParsedCursorUsagePage {
    events: Vec<CursorUsageEvent>,
    next_cursor: Option<u64>,
    has_more: bool,
}

/// Validate and aggregate the raw export without retaining event rows.
fn summarize_cursor_usage_file(path: &Path) -> Result<ParsedCursorUsageFile, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Cursor usage CSV: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CURSOR_EXPORT_BYTES as u64 {
        return Err("Cursor usage CSV is not a bounded regular file".to_string());
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open Cursor usage CSV: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::with_capacity(4096);
    if !read_bounded_csv_line(&mut reader, &mut line)? {
        return Err("Cursor usage CSV is empty".to_string());
    }
    let headers = parse_single_csv_record(&line, "header")?;
    let columns = CursorUsageColumns::from_headers(&headers)?;
    let data_start_offset = reader
        .stream_position()
        .map_err(|error| format!("Failed to locate Cursor usage CSV data: {error}"))?;
    let mut data_quality = CursorUsageDataQuality::default();
    let mut totals = CursorUsageTotals::default();

    while read_bounded_csv_line(&mut reader, &mut line)? {
        data_quality.total_rows += 1;
        let record = parse_single_csv_record(&line, "row")?;
        let Some(event) = parse_cursor_usage_record(&record, &columns) else {
            data_quality.skipped_rows += 1;
            continue;
        };
        update_data_quality(&mut data_quality, &event.quality);
        accumulate_totals(&mut totals, &event)?;
        data_quality.emitted_rows += 1;
    }

    if data_quality.total_rows > 0 && data_quality.emitted_rows == 0 {
        return Err("Cursor usage CSV contained rows but no valid billing events".to_string());
    }
    Ok(ParsedCursorUsageFile {
        data_start_offset,
        raw_bytes: metadata.len(),
        data_quality,
        totals,
    })
}

fn read_cursor_usage_page(
    path: &Path,
    cursor: u64,
    limit: usize,
    expected_bytes: u64,
    expected_data_start: u64,
) -> Result<ParsedCursorUsagePage, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Cursor usage cache: {error}"))?;
    if !metadata.file_type().is_file()
        || metadata.len() != expected_bytes
        || metadata.len() > MAX_CURSOR_EXPORT_BYTES as u64
    {
        return Err("Cursor usage raw cache changed or is invalid".to_string());
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open Cursor usage cache: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::with_capacity(4096);
    if !read_bounded_csv_line(&mut reader, &mut line)? {
        return Err("Cursor usage CSV is empty".to_string());
    }
    let headers = parse_single_csv_record(&line, "header")?;
    let columns = CursorUsageColumns::from_headers(&headers)?;
    let actual_data_start = reader
        .stream_position()
        .map_err(|error| format!("Failed to locate Cursor usage CSV data: {error}"))?;
    if actual_data_start != expected_data_start
        || cursor < expected_data_start
        || cursor > expected_bytes
    {
        return Err("Cursor usage page cursor is outside the current raw cache".to_string());
    }
    if cursor > expected_data_start {
        reader
            .seek(SeekFrom::Start(cursor - 1))
            .map_err(|error| format!("Failed to validate Cursor usage page cursor: {error}"))?;
        let mut previous = [0_u8; 1];
        reader
            .read_exact(&mut previous)
            .map_err(|error| format!("Failed to validate Cursor usage page cursor: {error}"))?;
        if previous[0] != b'\n' {
            return Err("Cursor usage page cursor is not at a record boundary".to_string());
        }
    }
    reader
        .seek(SeekFrom::Start(cursor))
        .map_err(|error| format!("Failed to seek Cursor usage page: {error}"))?;

    let bounded_limit = limit.clamp(1, MAX_CURSOR_USAGE_PAGE_SIZE);
    let mut events = Vec::with_capacity(bounded_limit);
    let mut scanned_rows = 0_usize;
    let mut scanned_bytes = 0_usize;
    while events.len() < bounded_limit
        && scanned_rows < MAX_CURSOR_USAGE_PAGE_SCAN_ROWS
        && scanned_bytes < MAX_CURSOR_USAGE_PAGE_SCAN_BYTES
        && read_bounded_csv_line(&mut reader, &mut line)?
    {
        scanned_rows += 1;
        scanned_bytes = scanned_bytes.saturating_add(line.len());
        let record = parse_single_csv_record(&line, "page row")?;
        if let Some(event) = parse_cursor_usage_record(&record, &columns) {
            events.push(event);
        }
    }
    let next_offset = reader
        .stream_position()
        .map_err(|error| format!("Failed to locate next Cursor usage page: {error}"))?;
    let has_more = next_offset < expected_bytes;
    Ok(ParsedCursorUsagePage {
        events,
        next_cursor: has_more.then_some(next_offset),
        has_more,
    })
}

fn read_bounded_csv_line(
    reader: &mut BufReader<std::fs::File>,
    line: &mut Vec<u8>,
) -> Result<bool, String> {
    line.clear();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("Failed to read Cursor usage CSV: {error}"))?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let (take, complete) = match available.iter().position(|byte| *byte == b'\n') {
            Some(position) => (position + 1, true),
            None => (available.len(), false),
        };
        if line.len().saturating_add(take) > MAX_CURSOR_CSV_RECORD_BYTES {
            return Err(format!(
                "Cursor usage CSV record exceeds the {} KiB safety limit",
                MAX_CURSOR_CSV_RECORD_BYTES / 1024
            ));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            return Ok(true);
        }
    }
}

fn parse_single_csv_record(bytes: &[u8], label: &str) -> Result<csv::StringRecord, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(bytes);
    let mut records = reader.records();
    let record = records
        .next()
        .ok_or_else(|| format!("Cursor usage CSV {label} is empty"))?
        .map_err(|error| format!("Invalid Cursor usage CSV {label}: {error}"))?;
    if records
        .next()
        .transpose()
        .map_err(|error| format!("Invalid Cursor usage CSV {label}: {error}"))?
        .is_some()
    {
        return Err(format!(
            "Cursor usage CSV {label} contains multiple records"
        ));
    }
    Ok(record)
}

fn parse_cursor_usage_record(
    record: &csv::StringRecord,
    column: &CursorUsageColumns,
) -> Option<CursorUsageEvent> {
    let occurred_at = field(record, column.date).trim();
    let model = field(record, column.model).trim();
    let occurred_at_ms = parse_cursor_timestamp(occurred_at)?;
    if model.is_empty() {
        return None;
    }

    let (input_tokens, input_quality) =
        parse_nonnegative_integer(field(record, column.input_without_cache_write));
    let (input_with_cache_write, input_with_cache_write_quality) =
        parse_nonnegative_integer(field(record, column.input_with_cache_write));
    let (cache_read_tokens, cache_read_quality) =
        parse_nonnegative_integer(field(record, column.cache_read));
    let (output_tokens, output_quality) = parse_nonnegative_integer(field(record, column.output));
    let (cache_write_tokens, cache_write_quality) = match (input_with_cache_write, input_tokens) {
        (Some(with_cache_write), Some(without_cache_write)) => (
            Some(with_cache_write.saturating_sub(without_cache_write)),
            CursorUsageMetricQuality::Derived,
        ),
        _ => (
            None,
            combine_unavailable_quality(input_with_cache_write_quality, input_quality),
        ),
    };
    let kind = column.kind.map(|index| field(record, index));
    let (cost_usd, cost_quality) = parse_cursor_cost(field(record, column.cost), kind);
    Some(CursorUsageEvent {
        occurred_at: occurred_at.to_string(),
        occurred_at_ms,
        model: model.to_string(),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_usd,
        source: CursorUsageRecordSource::CursorBillingExport,
        quality: CursorUsageEventQuality {
            input_tokens: input_quality,
            output_tokens: output_quality,
            cache_read_tokens: cache_read_quality,
            cache_write_tokens: cache_write_quality,
            cost_usd: cost_quality,
        },
    })
}

fn accumulate_totals(
    totals: &mut CursorUsageTotals,
    event: &CursorUsageEvent,
) -> Result<(), String> {
    add_token_total(&mut totals.input_tokens, event.input_tokens)?;
    add_token_total(&mut totals.output_tokens, event.output_tokens)?;
    add_token_total(&mut totals.cache_read_tokens, event.cache_read_tokens)?;
    add_token_total(&mut totals.cache_write_tokens, event.cache_write_tokens)?;
    if let Some(cost_usd) = event.cost_usd {
        let sum = totals.cost_usd + cost_usd;
        if !sum.is_finite() {
            return Err("Cursor usage cost total overflowed".to_string());
        }
        totals.cost_usd = sum;
        totals.exact_cost_rows += 1;
    }
    Ok(())
}

fn add_token_total(total: &mut u64, value: Option<u64>) -> Result<(), String> {
    if let Some(value) = value {
        *total = total
            .checked_add(value)
            .ok_or_else(|| "Cursor usage token total overflowed".to_string())?;
    }
    Ok(())
}

struct CursorUsageColumns {
    date: usize,
    kind: Option<usize>,
    model: usize,
    input_with_cache_write: usize,
    input_without_cache_write: usize,
    cache_read: usize,
    output: usize,
    cost: usize,
}

impl CursorUsageColumns {
    fn from_headers(headers: &csv::StringRecord) -> Result<Self, String> {
        Ok(Self {
            date: required_column(headers, &["Date"])?,
            kind: optional_column(headers, &["Kind"]),
            model: required_column(headers, &["Model"])?,
            input_with_cache_write: required_column(headers, &["Input (w/ Cache Write)"])?,
            input_without_cache_write: required_column(headers, &["Input (w/o Cache Write)"])?,
            cache_read: required_column(headers, &["Cache Read"])?,
            output: required_column(headers, &["Output Tokens"])?,
            cost: required_column(headers, &["Cost", "Cost to you"])?,
        })
    }
}

fn required_column(headers: &csv::StringRecord, names: &[&str]) -> Result<usize, String> {
    optional_column(headers, names).ok_or_else(|| {
        format!(
            "Cursor usage CSV is missing required column {}",
            names.join(" or ")
        )
    })
}

fn optional_column(headers: &csv::StringRecord, names: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let normalized = header.trim().trim_start_matches('\u{feff}');
        names.contains(&normalized)
    })
}

fn field(record: &csv::StringRecord, index: usize) -> &str {
    record.get(index).unwrap_or_default()
}

fn parse_nonnegative_integer(value: &str) -> (Option<u64>, CursorUsageMetricQuality) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, CursorUsageMetricQuality::Missing);
    }
    let normalized = remove_numeric_commas(trimmed);
    match normalized.parse::<u64>() {
        Ok(value) => (Some(value), CursorUsageMetricQuality::Exact),
        Err(_) => (None, CursorUsageMetricQuality::Invalid),
    }
}

fn parse_cursor_cost(value: &str, kind: Option<&str>) -> (Option<f64>, CursorUsageMetricQuality) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (None, CursorUsageMetricQuality::Missing);
    }
    if trimmed.eq_ignore_ascii_case("included") {
        return (None, CursorUsageMetricQuality::Included);
    }
    if trimmed == "-" || kind.is_some_and(|kind| kind.to_ascii_lowercase().contains("no charge")) {
        return (None, CursorUsageMetricQuality::NoCharge);
    }
    let without_currency = trimmed.strip_prefix('$').unwrap_or(trimmed);
    let normalized = remove_numeric_commas(without_currency);
    match normalized.parse::<f64>() {
        Ok(cost) if cost.is_finite() && cost >= 0.0 => {
            (Some(cost), CursorUsageMetricQuality::Exact)
        }
        _ => (None, CursorUsageMetricQuality::Invalid),
    }
}

fn remove_numeric_commas(value: &str) -> Cow<'_, str> {
    if value.contains(',') {
        Cow::Owned(value.replace(',', ""))
    } else {
        Cow::Borrowed(value)
    }
}

fn combine_unavailable_quality(
    left: CursorUsageMetricQuality,
    right: CursorUsageMetricQuality,
) -> CursorUsageMetricQuality {
    if matches!(left, CursorUsageMetricQuality::Invalid)
        || matches!(right, CursorUsageMetricQuality::Invalid)
    {
        CursorUsageMetricQuality::Invalid
    } else {
        CursorUsageMetricQuality::Missing
    }
}

fn update_data_quality(summary: &mut CursorUsageDataQuality, quality: &CursorUsageEventQuality) {
    let values = [
        quality.input_tokens,
        quality.output_tokens,
        quality.cache_read_tokens,
        quality.cache_write_tokens,
        quality.cost_usd,
    ];
    let missing = values
        .iter()
        .filter(|value| matches!(value, CursorUsageMetricQuality::Missing))
        .count();
    let invalid = values
        .iter()
        .filter(|value| matches!(value, CursorUsageMetricQuality::Invalid))
        .count();
    summary.missing_metric_values += missing;
    summary.invalid_metric_values += invalid;
    if missing == 0 && invalid == 0 && quality.cost_usd == CursorUsageMetricQuality::Exact {
        summary.complete_rows += 1;
    } else {
        summary.partial_rows += 1;
    }
}

fn parse_cursor_timestamp(value: &str) -> Option<i64> {
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(value) {
        return Some(timestamp.timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(timestamp) = NaiveDateTime::parse_from_str(value, format) {
            return Some(Utc.from_utc_datetime(&timestamp).timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(12, 0, 0))
        .map(|timestamp| Utc.from_utc_datetime(&timestamp).timestamp_millis())
}

#[cfg(test)]
#[path = "usage_export_tests.rs"]
mod tests;
