use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    coordinator::{CursorUsageExporter, CURSOR_USAGE_SYNC_LANES},
    csv::read_cursor_usage_page,
    filesystem::{
        atomic_archive_file_if_present, atomic_copy_file, atomic_write_json, cache_io_error,
        read_small_json, remove_file_if_present, set_sensitive_directory_permissions,
        set_sensitive_file_permissions,
    },
    types::{
        sha256_hex, ArchivedCursorUsageCache, CursorUsageAccount, CursorUsageError,
        CursorUsageFailureKind, CursorUsagePage, CursorUsageSummary, CursorUsageSyncFailure,
    },
    CURSOR_USAGE_ATTEMPT_VERSION, CURSOR_USAGE_CACHE_VERSION, MAX_CURSOR_EXPORT_BYTES,
    MAX_CURSOR_USAGE_PAGE_SIZE,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CursorUsageCacheEnvelope {
    pub(super) version: u32,
    pub(super) endpoint: String,
    pub(super) account_id: String,
    pub(super) credential_fingerprint: String,
    pub(super) fetched_at: DateTime<Utc>,
    pub(super) snapshot_id: String,
    pub(super) raw_file_name: String,
    pub(super) data_start_offset: u64,
    pub(super) summary: CursorUsageSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CursorUsageAttemptOutcome {
    Started,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CursorUsageAttemptMarker {
    pub(super) version: u32,
    pub(super) endpoint: String,
    pub(super) account_id: String,
    pub(super) credential_fingerprint: String,
    pub(super) attempted_at: DateTime<Utc>,
    pub(super) outcome: CursorUsageAttemptOutcome,
    pub(super) failure: Option<CursorUsageSyncFailure>,
}

pub(super) fn snapshot_cursor_tag(snapshot_id: &str) -> String {
    sha256_hex(snapshot_id.as_bytes())[..16].to_string()
}

pub(super) fn alternate_raw_slot(
    stem: &str,
    previous: Option<&CursorUsageCacheEnvelope>,
) -> String {
    let slot_a = format!("{stem}.slot-a.last-good.csv");
    let slot_b = format!("{stem}.slot-b.last-good.csv");
    if previous.is_some_and(|envelope| envelope.raw_file_name == slot_a) {
        slot_b
    } else {
        slot_a
    }
}

pub(super) fn safe_raw_path(
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

impl CursorUsageExporter {
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

    pub(super) fn staged_raw_path_for_account(&self, account_id: &str) -> PathBuf {
        self.cache_root.join(format!(
            ".{}.download.tmp",
            self.account_file_stem(account_id)
        ))
    }

    pub(super) fn published_raw_file_name(
        &self,
        account_id: &str,
        previous: Option<&CursorUsageCacheEnvelope>,
    ) -> String {
        alternate_raw_slot(&self.account_file_stem(account_id), previous)
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

    pub(super) async fn read_matching_cache(
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

    pub(super) async fn read_matching_attempt(
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

    pub(super) fn attempt_marker(
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

    pub(super) async fn write_cache(
        &self,
        envelope: &CursorUsageCacheEnvelope,
        account: &CursorUsageAccount,
    ) -> Result<(), CursorUsageError> {
        atomic_write_json(&self.cache_path_for_account(&account.account_id), envelope).await
    }

    pub(super) async fn write_attempt_marker(
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

    pub(super) async fn ensure_cache_root(&self) -> Result<(), CursorUsageError> {
        tokio::fs::create_dir_all(&self.cache_root)
            .await
            .map_err(cache_io_error)?;
        set_sensitive_directory_permissions(&self.cache_root).await
    }

    pub(super) async fn prepare_staged_export(
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

    pub(super) fn raw_path_from_envelope(
        &self,
        envelope: &CursorUsageCacheEnvelope,
    ) -> Result<PathBuf, CursorUsageError> {
        safe_raw_path(
            &self.cache_root,
            &self.account_file_stem(&envelope.account_id),
            &envelope.raw_file_name,
        )
    }

    pub(super) fn account_file_stem(&self, account_id: &str) -> String {
        let scope = format!("{}\0{}", self.endpoint, account_id);
        format!("account-{}", &sha256_hex(scope.as_bytes())[..32])
    }
}
