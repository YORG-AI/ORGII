//! Thread-safe key storage service backed by `~/.orgii/credentials.json`.
//!
//! The implementation is split into focused submodules; this file holds the
//! `KeyService` struct, the global singleton, and the constants shared across
//! the OAuth refresh paths, then re-exports the public surface unchanged.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod claude_oauth;
mod codex_oauth;
mod keys;
mod oauth_health;
mod persistence;
mod token_sync;

/// Refresh a token this many seconds before its recorded expiry.
const OAUTH_REFRESH_EXPIRY_SKEW_SECONDS: i64 = 60;
/// Shared HTTP timeout for the Claude Code / Codex refresh-token exchanges.
const OAUTH_REFRESH_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

type OAuthRefreshLockMap = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

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

    /// Get storage directory path
    pub fn get_storage_dir(&self) -> &PathBuf {
        &self.storage_dir
    }

    /// Get storage file path
    pub fn get_storage_file(&self) -> &PathBuf {
        &self.storage_file
    }
}

pub use token_sync::{CliOAuthTokenSync, CliOAuthTokenSyncOutcome};

// ============================================
// Global Instance
// ============================================

use std::sync::LazyLock;

/// Global key service instance
pub static KEY_SERVICE: LazyLock<KeyService> = LazyLock::new(KeyService::default);
