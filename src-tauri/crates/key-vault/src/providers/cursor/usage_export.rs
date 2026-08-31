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
//!
//! Private modules keep the public contract stable while separating resource
//! coordination, HTTP authentication, cache transactions, CSV parsing, and
//! command wrappers.

use std::time::Duration;

mod cache;
mod commands;
mod coordinator;
mod csv;
mod filesystem;
mod http;
mod types;

pub use commands::{
    __cmd__cursor_archive_billing_usage_cache, __cmd__cursor_read_billing_usage_page,
    __cmd__cursor_sync_billing_usage, cursor_archive_billing_usage_cache,
    cursor_read_billing_usage_page, cursor_sync_billing_usage, sync_key_vault_cursor_billing_usage,
};
pub use coordinator::CursorUsageExporter;
pub use types::{
    ArchivedCursorUsageCache, CursorUsageAccount, CursorUsageDataQuality, CursorUsageError,
    CursorUsageEvent, CursorUsageEventQuality, CursorUsageFailureKind, CursorUsageMetricQuality,
    CursorUsagePage, CursorUsageRecordSource, CursorUsageSnapshot, CursorUsageSnapshotSource,
    CursorUsageSummary, CursorUsageSyncFailure, CursorUsageTotals,
};

/// Cursor's exact dashboard billing export.
pub const CURSOR_USAGE_EXPORT_URL: &str =
    "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";

/// Successful data and failed attempts are both throttled for five minutes.
pub const CURSOR_USAGE_CACHE_FRESHNESS: Duration = Duration::from_secs(5 * 60);

pub const DEFAULT_CURSOR_USAGE_PAGE_SIZE: usize = 100;
pub const MAX_CURSOR_USAGE_PAGE_SIZE: usize = 200;

/// Cursor exports are intentionally serialized globally. A single export can
/// stream and validate tens of MiB; parallel parsers would create CPU/I/O
/// spikes without improving one account's freshness.
pub const CURSOR_USAGE_MAX_CONCURRENT_EXPORTS: usize = 1;

const CURSOR_USAGE_HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const CURSOR_USAGE_CACHE_VERSION: u32 = 2;
const CURSOR_USAGE_ATTEMPT_VERSION: u32 = 1;
const MAX_CURSOR_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_CURSOR_CSV_RECORD_BYTES: usize = 256 * 1024;
const MAX_CURSOR_METADATA_BYTES: usize = 256 * 1024;
const MAX_CURSOR_USAGE_PAGE_SCAN_ROWS: usize = 1_000;
const MAX_CURSOR_USAGE_PAGE_SCAN_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVE_ACCOUNT_LANES: usize = 64;
const OVERFLOW_ACCOUNT_LANES: usize = 16;

#[cfg(test)]
use std::path::PathBuf;

#[cfg(test)]
use chrono::DateTime;

#[cfg(test)]
use cache::CursorUsageCacheEnvelope;
#[cfg(test)]
use coordinator::CURSOR_USAGE_SYNC_LANES;
#[cfg(test)]
use csv::{read_cursor_usage_page, summarize_cursor_usage_file, ParsedCursorUsageFile};
#[cfg(test)]
use filesystem::{atomic_copy_file, read_small_json};
#[cfg(test)]
use http::{cursor_auth_attempts, CursorAuthAttempt};

#[cfg(test)]
#[path = "usage_export_tests.rs"]
mod tests;
