//! Repository watcher — real-time git status via fs events + adaptive polling
//!
//! Two-layer detection:
//! 1. **`.git/` directory watching** — instant detection of git operations
//! 2. **Adaptive polling (5–8 s)** — catches working-directory file changes
//!
//! See: `docs/architecture-guide/git-watcher-architecture-0124.md`
//!
//! The global singleton `REPO_WATCH_MANAGER` owns the [`RepoStateStore`],
//! [`RepoWatcher`], and [`EventEmitter`] and is initialised once at app start.

pub mod commands;
pub mod debounce;
pub mod event_emitter;
pub mod git_status;
pub mod health_monitor;
pub mod state_store;
pub mod types;
pub mod watcher;

pub use event_emitter::EventEmitter;
pub use state_store::RepoStateStore;
pub use watcher::RepoWatcher;

use health_monitor::HealthMonitor;
use parking_lot::RwLock;
use std::sync::{Arc, LazyLock};

// Global singleton for repo watching
pub static REPO_WATCH_MANAGER: LazyLock<Arc<RwLock<Option<RepoWatchManager>>>> =
    LazyLock::new(|| Arc::new(RwLock::new(None)));

pub struct RepoWatchManager {
    pub state_store: Arc<RepoStateStore>,
    pub watcher: Arc<RepoWatcher>,
    pub event_emitter: Arc<EventEmitter>,
}

impl RepoWatchManager {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let state_store = Arc::new(RepoStateStore::new());
        let event_emitter = Arc::new(EventEmitter::new(app_handle.clone()));
        let watcher = Arc::new(RepoWatcher::new(state_store.clone(), event_emitter.clone()));

        // The canonical monitor owns health probes, watcher recovery, and
        // polling-only fallback. Keep exactly one health loop per manager.
        Arc::new(HealthMonitor::new(
            state_store.clone(),
            watcher.clone(),
            event_emitter.clone(),
        ))
        .start();

        Self {
            state_store,
            watcher,
            event_emitter,
        }
    }

    pub fn initialize(app_handle: tauri::AppHandle) {
        let manager = Self::new(app_handle);
        *REPO_WATCH_MANAGER.write() = Some(manager);
    }
}

#[cfg(test)]
mod tests;
