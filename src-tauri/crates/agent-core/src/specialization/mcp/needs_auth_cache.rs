//! Needs-auth cache.
//!
//! When an MCP server returns HTTP 401 (or `rmcp`'s `AuthError` on a
//! handshake), we cache the server name for 15 minutes so subsequent
//! `connect_all` calls can skip the TCP round-trip and go straight to the
//! `NeedsAuth` state.
//!
//! Storage: `~/.orgii/mcp-needs-auth-cache.json` (override with `ORGII_HOME`
//! for tests). Format:
//!
//! ```json
//! { "server-name": { "timestamp": 1728000000000 } }
//! ```
//!
//! Writes are serialized through a `Mutex<()>` so two concurrent 401s on
//! the same batch don't lose entries to a read-modify-write race.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{debug, warn};

/// 15 minute TTL.
pub(crate) const NEEDS_AUTH_TTL_MS: u64 = 15 * 60 * 1000;

/// On-disk entry shape. Keyed by server name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct NeedsAuthEntry {
    /// Milliseconds since UNIX epoch when the entry was written.
    pub(crate) timestamp: u64,
}

/// Wire format for the whole cache file.
pub(crate) type NeedsAuthCacheData = HashMap<String, NeedsAuthEntry>;

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve the cache file path. Honors `ORGII_HOME` for tests.
pub(crate) fn cache_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("ORGII_HOME") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("mcp-needs-auth-cache.json"));
        }
    }
    // Unit tests must never fall through to the developer's real home: the
    // cache is process-global state keyed off `ORGII_HOME`, so an unsandboxed
    // test both writes to `~/.orgii` and races whichever sandboxed test is
    // holding `test_env::lock_home()` at that moment. Fail loudly instead.
    #[cfg(test)]
    {
        panic!(
            "needs-auth cache resolved without ORGII_HOME — the calling test must hold a \
             `test_helpers::test_env::sandbox()` guard"
        );
    }
    #[cfg(not(test))]
    {
        dirs::home_dir().map(|home| home.join(".orgii").join("mcp-needs-auth-cache.json"))
    }
}

/// Global write lock — serializes the read-modify-write so concurrent
/// auth failures don't drop entries.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Read the cache file, tolerating missing / malformed files by returning
/// an empty map.
pub(crate) async fn read_cache() -> NeedsAuthCacheData {
    let Some(path) = cache_path() else {
        return HashMap::new();
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) => {
            // ENOENT is the legitimate "no cache yet" case and
            // should stay quiet. Any other I/O error means we
            // silently lose the auth-cache state and the next
            // 401 sweep would re-walk every server — warn so
            // the operator can see why the cache stopped helping.
            if err.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "[mcp:needs-auth-cache] read failed at {}: {} — treating as empty",
                    path.display(),
                    err
                );
            }
            return HashMap::new();
        }
    };
    match serde_json::from_slice::<NeedsAuthCacheData>(&bytes) {
        Ok(data) => data,
        Err(err) => {
            warn!(
                "[mcp:needs-auth-cache] malformed cache at {}: {} — treating as empty",
                path.display(),
                err
            );
            HashMap::new()
        }
    }
}

/// Returns `true` if `server` has an entry younger than
/// [`NEEDS_AUTH_TTL_MS`]. Missing / expired entries return `false`.
pub(crate) async fn is_cached(server: &str) -> bool {
    let cache = read_cache().await;
    let Some(entry) = cache.get(server) else {
        return false;
    };
    let now = now_epoch_ms();
    now.saturating_sub(entry.timestamp) < NEEDS_AUTH_TTL_MS
}

/// Record that `server` needs auth right now. Best-effort: errors are
/// logged but not propagated.
pub(crate) async fn set_entry(server: &str) {
    let _guard = write_lock().lock().await;
    let Some(path) = cache_path() else {
        warn!("[mcp:needs-auth-cache] no home dir resolved — skipping write");
        return;
    };

    let mut cache = read_cache().await;
    cache.insert(
        server.to_string(),
        NeedsAuthEntry {
            timestamp: now_epoch_ms(),
        },
    );

    if let Some(parent) = path.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            warn!(
                "[mcp:needs-auth-cache] create_dir_all({}) failed: {}",
                parent.display(),
                err
            );
            return;
        }
    }

    match serde_json::to_vec_pretty(&cache) {
        Ok(bytes) => {
            if let Err(err) = tokio::fs::write(&path, bytes).await {
                warn!(
                    "[mcp:needs-auth-cache] write({}) failed: {}",
                    path.display(),
                    err
                );
            } else {
                debug!(
                    "[mcp:needs-auth-cache] marked '{}' as needs-auth ({})",
                    server,
                    path.display()
                );
            }
        }
        Err(err) => {
            warn!(
                "[mcp:needs-auth-cache] serialize cache for '{}' failed: {}",
                server, err
            );
        }
    }
}

/// Remove a single server's entry. Used after a successful manual
/// reconnect (e.g. the user completed the OAuth flow for just one
/// server). Best-effort.
pub(crate) async fn remove_entry(server: &str) {
    let _guard = write_lock().lock().await;
    let Some(path) = cache_path() else { return };
    let mut cache = read_cache().await;
    if cache.remove(server).is_none() {
        return;
    }
    if cache.is_empty() {
        if let Err(err) = tokio::fs::remove_file(&path).await {
            // Best-effort: removing a non-existent file is fine, anything
            // else (permission, FS error) is worth surfacing.
            if err.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "[mcp:needs-auth-cache] failed to remove empty cache file '{}': {}",
                    path.display(),
                    err
                );
            }
        }
        return;
    }
    match serde_json::to_vec_pretty(&cache) {
        Ok(bytes) => {
            if let Err(err) = tokio::fs::write(&path, bytes).await {
                warn!(
                    "[mcp:needs-auth-cache] failed to write cache after removing '{}' to '{}': {}",
                    server,
                    path.display(),
                    err
                );
            }
        }
        Err(err) => {
            warn!(
                "[mcp:needs-auth-cache] failed to serialize cache after removing '{}': {}",
                server, err
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_helpers::test_env::{sandbox, SandboxGuard};

    // ORGII_HOME is process-wide; all tests go through the crate-wide
    // `test_env::sandbox()` so cross-module races and Once poisoning
    // are both eliminated (see `src/test_utils/test_env.rs`).
    type OrgiiHomeGuard = SandboxGuard;

    fn new_orgii_home_guard() -> OrgiiHomeGuard {
        sandbox()
    }

    #[tokio::test]
    async fn missing_file_returns_not_cached() {
        let _guard = new_orgii_home_guard();
        assert!(!is_cached("whatever").await);
    }

    #[tokio::test]
    async fn set_then_is_cached() {
        let _guard = new_orgii_home_guard();
        set_entry("server-a").await;
        assert!(is_cached("server-a").await);
        assert!(!is_cached("other-server").await);
    }

    #[tokio::test]
    async fn expired_entry_is_not_cached() {
        let _guard = new_orgii_home_guard();
        // Write an entry by hand with an ancient timestamp.
        let path = cache_path().unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let mut cache = NeedsAuthCacheData::new();
        cache.insert(
            "old".into(),
            NeedsAuthEntry {
                timestamp: now_epoch_ms().saturating_sub(NEEDS_AUTH_TTL_MS + 1_000),
            },
        );
        tokio::fs::write(&path, serde_json::to_vec(&cache).unwrap())
            .await
            .unwrap();
        assert!(!is_cached("old").await);
    }

    #[tokio::test]
    async fn remove_entry_leaves_other_entries() {
        let _guard = new_orgii_home_guard();
        set_entry("s1").await;
        set_entry("s2").await;
        remove_entry("s1").await;
        assert!(!is_cached("s1").await);
        assert!(is_cached("s2").await);
    }

    #[tokio::test]
    async fn concurrent_sets_all_persist() {
        let _guard = new_orgii_home_guard();
        let mut handles = Vec::new();
        for idx in 0..8 {
            let name = format!("server-{}", idx);
            handles.push(tokio::spawn(async move { set_entry(&name).await }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let cache = read_cache().await;
        assert_eq!(cache.len(), 8, "all concurrent writes should persist");
    }

    #[tokio::test]
    async fn malformed_cache_is_treated_as_empty() {
        let _guard = new_orgii_home_guard();
        let path = cache_path().unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"not json").await.unwrap();
        assert!(!is_cached("any").await);
        // And a subsequent set_entry should still succeed, overwriting the junk.
        set_entry("fresh").await;
        assert!(is_cached("fresh").await);
    }
}
