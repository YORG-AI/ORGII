//! Watcher health monitor and fallback strategy
//!
//! One global monitor performs the 60 s health pass, owns polling-only
//! fallback refreshes, and retries failed watchers every five minutes.
use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;

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

    /// Start the health monitor on its own runtime because the manager is
    /// constructed during Tauri setup, before callers can assume a Tokio context.
    pub fn start(self: Arc<Self>) {
        std::thread::Builder::new()
            .name("git-health-monitor".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Runtime::new() {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        log::error!("Failed to create watcher health runtime: {}", error);
                        return;
                    }
                };
                runtime.block_on(self.run_health_checks());
            })
            .expect("Failed to spawn watcher health monitor thread");
    }

    /// Run the single periodic health and fallback pass.
    async fn run_health_checks(&self) {
        let mut check_interval = interval(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECONDS));
        // Tokio intervals tick immediately; consume that tick so startup does not
        // probe every repository before its watcher has had time to initialize.
        check_interval.tick().await;

        loop {
            check_interval.tick().await;
            self.run_health_check_pass().await;
        }
    }

    async fn run_health_check_pass(&self) {
        let repo_ids = self.state_store.get_all_repo_ids();

        for repo_id in repo_ids {
            if !self.state_store.is_watch_enabled(&repo_id) {
                self.refresh_polling_fallback(&repo_id).await;
                if self.state_store.should_retry_watcher(&repo_id) {
                    self.state_store.update_health_check(&repo_id);
                    self.try_recover_watcher(&repo_id);
                }
                continue;
            }

            if self.state_store.should_test_health(&repo_id) {
                log::debug!("Testing watcher health for repo: {}", repo_id);
                if let Err(error) = self.watcher.test_watcher_health(&repo_id).await {
                    log::warn!("Watcher health test failed for {}: {}", repo_id, error);
                    self.state_store.increment_failures(&repo_id);
                }
            }

            if !self.state_store.is_unhealthy(&repo_id) {
                continue;
            }

            self.state_store
                .mark_degraded(&repo_id, Some("Too many consecutive failures".to_string()));
            self.event_emitter.emit_watcher_health(
                repo_id.clone(),
                HealthStatus::Degraded,
                Some("Watcher unhealthy, attempting restart".to_string()),
            );

            self.try_recover_watcher(&repo_id);
        }
    }

    fn try_recover_watcher(&self, repo_id: &str) {
        match self.watcher.restart_watcher(repo_id) {
            Ok(()) => {
                log::info!("Successfully restarted watcher for: {}", repo_id);
                self.state_store.mark_healthy(repo_id);
                self.event_emitter.emit_watcher_health(
                    repo_id.to_string(),
                    HealthStatus::Healthy,
                    Some("Watcher recovered".to_string()),
                );
            }
            Err(error) => {
                log::error!("Failed to restart watcher for {}: {}", repo_id, error);
                self.state_store.mark_watcher_unavailable(repo_id);
                self.event_emitter.emit_watcher_health(
                    repo_id.to_string(),
                    HealthStatus::Degraded,
                    Some(format!(
                        "Watcher restart failed; using polling fallback: {}",
                        error
                    )),
                );
            }
        }
    }

    /// Refresh a repository whose file watcher is unavailable. The same global
    /// health loop owns this fallback, so a failed watcher cannot spawn duplicate
    /// per-repository polling tasks.
    async fn refresh_polling_fallback(&self, repo_id: &str) {
        let repo_path = self
            .state_store
            .get_all_states()
            .get(repo_id)
            .map(|state| state.repo_path.clone());
        let Some(repo_path) = repo_path else {
            return;
        };

        match super::git_status::refresh_git_status(&repo_path).await {
            Ok(status) => {
                self.state_store.update_status(repo_id, status.clone());
                self.event_emitter
                    .emit_status_updated(repo_id.to_string(), status);
            }
            Err(error) => {
                log::error!("Polling fallback failed for {}: {}", repo_id, error);
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
