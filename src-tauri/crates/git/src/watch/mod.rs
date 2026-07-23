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

        // Start health monitoring in background
        Self::start_health_monitor(state_store.clone(), watcher.clone(), event_emitter.clone());

        Self {
            state_store,
            watcher,
            event_emitter,
        }
    }

    /// Start background health monitoring thread
    /// Checks watcher health every 60s and restarts if needed
    fn start_health_monitor(
        state_store: Arc<RepoStateStore>,
        watcher: Arc<RepoWatcher>,
        event_emitter: Arc<EventEmitter>,
    ) {
        use std::time::Duration;

        std::thread::Builder::new()
            .name("git-health-monitor".to_string())
            .spawn(move || {
                // Initial delay to let system stabilize
                std::thread::sleep(Duration::from_secs(30));

                loop {
                    std::thread::sleep(Duration::from_secs(60));

                    for (repo_id, consecutive_failures) in state_store.get_unhealthy_watcher_ids() {
                        log::warn!(
                            "[HealthMonitor] Repo {} has {} failures, attempting restart",
                            repo_id,
                            consecutive_failures
                        );

                        // Try to restart the watcher
                        match watcher.restart_watcher(&repo_id) {
                            Ok(()) => {
                                log::info!(
                                    "[HealthMonitor] Successfully restarted watcher for {}",
                                    repo_id
                                );
                                state_store.mark_healthy(&repo_id);

                                event_emitter.emit_watcher_health(
                                    repo_id,
                                    types::HealthStatus::Healthy,
                                    Some("Watcher recovered".to_string()),
                                );
                            }
                            Err(e) => {
                                log::error!(
                                    "[HealthMonitor] Failed to restart watcher for {}: {}",
                                    repo_id,
                                    e
                                );

                                // Mark as degraded but keep polling active
                                state_store.mark_degraded(
                                    &repo_id,
                                    Some(format!("Watcher restart failed: {}", e)),
                                );

                                event_emitter.emit_watcher_health(
                                    repo_id,
                                    types::HealthStatus::Degraded,
                                    Some("Watcher failed, using polling only".to_string()),
                                );
                            }
                        }
                    }
                }
            })
            .expect("Failed to spawn health monitor thread");
    }

    pub fn initialize(app_handle: tauri::AppHandle) {
        let manager = Self::new(app_handle);
        *REPO_WATCH_MANAGER.write() = Some(manager);
    }
}

#[cfg(test)]
mod tests;
