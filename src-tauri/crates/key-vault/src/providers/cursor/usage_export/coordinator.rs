use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex as StdMutex, Weak};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use uuid::Uuid;

use crate::key_store::KEY_SERVICE;

use super::{
    cache::{CursorUsageAttemptOutcome, CursorUsageCacheEnvelope},
    csv::summarize_cursor_usage_file,
    filesystem::{read_small_json, remove_file_if_present, replace_with_staged_file},
    http::fetch_usage_csv_to as fetch_usage_csv_to_http,
    types::{
        CursorUsageAccount, CursorUsageError, CursorUsageFailureKind, CursorUsageSnapshot,
        CursorUsageSnapshotSource, CursorUsageSummary, CursorUsageSyncFailure,
    },
    CURSOR_USAGE_CACHE_FRESHNESS, CURSOR_USAGE_CACHE_VERSION, CURSOR_USAGE_EXPORT_URL,
    CURSOR_USAGE_HTTP_TIMEOUT, CURSOR_USAGE_MAX_CONCURRENT_EXPORTS, MAX_ACTIVE_ACCOUNT_LANES,
    OVERFLOW_ACCOUNT_LANES,
};

static CURSOR_USAGE_NETWORK_PERMITS: Semaphore =
    Semaphore::const_new(CURSOR_USAGE_MAX_CONCURRENT_EXPORTS);

// Equivalent requests for one account share a lane, while unrelated accounts
// can refresh concurrently. Finished lanes are weak and evicted on the next
// lookup. The map is capped; excess simultaneous accounts fall into a fixed
// set of bounded overflow shards rather than growing process memory forever.
pub(super) static CURSOR_USAGE_SYNC_LANES: LazyLock<CursorUsageSyncLanes> =
    LazyLock::new(CursorUsageSyncLanes::new);

pub(super) struct CursorUsageSyncLanes {
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

    pub(super) fn lane(&self, key: &str) -> Arc<AsyncMutex<()>> {
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

pub struct CursorUsageExporter {
    pub(super) client: reqwest::Client,
    pub(super) cache_root: PathBuf,
    pub(super) endpoint: String,
    pub(super) freshness: Duration,
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
            fetch_usage_csv_to_http(
                &self.client,
                &self.endpoint,
                &account.session_token,
                staged_path,
            )
        })
        .await
    }

    pub(super) async fn sync_account_with_fetcher<F, Fut>(
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
