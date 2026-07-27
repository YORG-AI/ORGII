//! Watcher health monitor and fallback strategy
//!
//! Polls each repo's consecutive-failure count every 60 s; if ≥ 3 failures
//! are detected it attempts a watcher restart and emits a
//! `HealthStatus::Degraded` event if the restart fails.
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{interval, sleep};

use super::event_emitter::EventEmitter;
use super::state_store::RepoStateStore;
use super::types::*;
use super::watcher::RepoWatcher;

pub struct HealthMonitor {
    state_store: Arc<RepoStateStore>,
    watcher: Arc<RepoWatcher>,
    event_emitter: Arc<EventEmitter>,
}

impl HealthMonitor {
    pub fn new(
        state_store: Arc<RepoStateStore>,
        watcher: Arc<RepoWatcher>,
        event_emitter: Arc<EventEmitter>,
    ) -> Self {
        Self {
            state_store,
            watcher,
            event_emitter,
        }
    }

    /// Start health monitoring loop
    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            self.run_health_checks().await;
        });
    }

    /// Run periodic health checks
    async fn run_health_checks(&self) {
        let mut check_interval = interval(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECONDS));

        loop {
            check_interval.tick().await;

            let repo_ids = self.state_store.get_all_repo_ids();

            for repo_id in repo_ids {
                // Check if health test is needed
                if self.state_store.should_test_health(&repo_id) {
                    log::debug!("Testing watcher health for repo: {}", repo_id);

                    if let Err(e) = self.watcher.test_watcher_health(&repo_id).await {
                        log::warn!("Watcher health test failed for {}: {}", repo_id, e);
                        self.state_store.increment_failures(&repo_id);
                    } else {
                        log::debug!("Watcher health test passed for: {}", repo_id);
                    }
                }

                // Check if watcher needs restart
                if self.state_store.is_unhealthy(&repo_id) {
                    log::warn!(
                        "Watcher unhealthy for repo: {}, attempting restart",
                        repo_id
                    );

                    // Mark as degraded
                    self.state_store
                        .mark_degraded(&repo_id, Some("Too many consecutive failures".to_string()));

                    // Emit health event
                    self.event_emitter.emit_watcher_health(
                        repo_id.clone(),
                        HealthStatus::Degraded,
                        Some("Watcher unhealthy, attempting restart".to_string()),
                    );

                    // Try to restart watcher
                    if let Err(e) = self.watcher.restart_watcher(&repo_id) {
                        log::error!("Failed to restart watcher for {}: {}", repo_id, e);

                        // Emit failed health event
                        self.event_emitter.emit_watcher_health(
                            repo_id.clone(),
                            HealthStatus::Failed,
                            Some(format!("Watcher restart failed: {}", e)),
                        );

                        // Fall back to polling mode
                        self.enable_polling_fallback(&repo_id).await;
                    } else {
                        log::info!("Successfully restarted watcher for: {}", repo_id);

                        // Mark as healthy
                        self.state_store.mark_healthy(&repo_id);

                        // Emit healthy event
                        self.event_emitter.emit_watcher_health(
                            repo_id.clone(),
                            HealthStatus::Healthy,
                            None,
                        );
                    }

                    // Wait before checking next repo
                    sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    /// Enable polling fallback for failed watcher
    async fn enable_polling_fallback(&self, repo_id: &str) {
        log::info!("Enabling polling fallback for repo: {}", repo_id);

        // Disable watcher
        self.state_store.disable_watch(repo_id);

        // Start slow polling loop
        let repo_id_clone = repo_id.to_string();
        let state_store = self.state_store.clone();
        let event_emitter = self.event_emitter.clone();

        tokio::spawn(async move {
            Self::polling_loop(repo_id_clone, state_store, event_emitter).await;
        });
    }

    /// Slow polling loop as fallback
    async fn polling_loop(
        repo_id: String,
        state_store: Arc<RepoStateStore>,
        event_emitter: Arc<EventEmitter>,
    ) {
        let mut poll_interval = interval(Duration::from_secs(60)); // Slow polling: 60s

        loop {
            poll_interval.tick().await;

            // Check if watch has been re-enabled (watcher recovered)
            if state_store.is_watch_enabled(&repo_id) {
                log::info!(
                    "Watch re-enabled for {}, stopping polling fallback",
                    repo_id
                );
                break;
            }

            // Check if repo still exists
            let repo_path = state_store.get_repo_path(&repo_id);

            if let Some(repo_path) = repo_path {
                // Run git status
                match super::git_status::refresh_git_status(&repo_path).await {
                    Ok(status) => {
                        // Update cache
                        state_store.update_status(&repo_id, status.clone());

                        // Emit status update
                        event_emitter.emit_status_updated(repo_id.clone(), status);

                        log::debug!("Polling fallback: refreshed status for {}", repo_id);
                    }
                    Err(e) => {
                        log::error!("Polling fallback failed for {}: {}", repo_id, e);
                    }
                }
            } else {
                // Repo no longer exists, stop polling
                log::info!(
                    "Repo {} no longer exists, stopping polling fallback",
                    repo_id
                );
                break;
            }
        }
    }

    /// Get health status for all repos
    pub fn get_all_health(&self) -> std::collections::HashMap<String, WatcherHealth> {
        let states = self.state_store.get_all_states();

        states
            .into_iter()
            .map(|(repo_id, state)| {
                let status = if state.in_degraded_mode {
                    HealthStatus::Degraded
                } else if state.is_unhealthy() {
                    HealthStatus::Failed
                } else {
                    HealthStatus::Healthy
                };

                let mode = if !state.watch_enabled {
                    WatchMode::SlowPolling
                } else if state.in_degraded_mode {
                    WatchMode::SmartPolling
                } else {
                    WatchMode::EventDriven
                };

                let health = WatcherHealth {
                    repo_id: repo_id.clone(),
                    repo_name: state.repo_name.clone(),
                    status,
                    mode,
                    reason: None,
                    last_event: Some(state.last_fs_event_ts.elapsed().as_millis() as u64),
                    cache_valid: state.is_cache_valid(),
                };

                (repo_id, health)
            })
            .collect()
    }

    /// Get watch status summary
    pub fn get_watch_status(&self) -> WatchStatus {
        let health_map = self.get_all_health();

        let total_repos = health_map.len();
        let healthy_repos = health_map
            .values()
            .filter(|h| h.status == HealthStatus::Healthy)
            .count();
        let degraded_repos = health_map
            .values()
            .filter(|h| h.status == HealthStatus::Degraded)
            .count();
        let failed_repos = health_map
            .values()
            .filter(|h| h.status == HealthStatus::Failed)
            .count();

        WatchStatus {
            watching: health_map,
            total_repos,
            healthy_repos,
            degraded_repos,
            failed_repos,
        }
    }
}
