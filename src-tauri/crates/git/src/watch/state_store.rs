//! Thread-safe repository state store
//!
//! Stores per-repo `WatchState` (last status, consecutive failure count,
//! watch-enabled flag) behind a `parking_lot::RwLock`. Shared between the
//! watcher, health monitor, and Tauri command handlers.
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::types::*;

pub struct RepoStateStore {
    states: Arc<RwLock<HashMap<String, RepoState>>>,
}

impl RepoStateStore {
    pub fn new() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    // ============================================
    // Repository Management
    // ============================================

    /// Add a new repository to watch
    pub fn add_repo(&self, repo_info: RepoInfo) {
        let mut states = self.states.write();
        if !states.contains_key(&repo_info.repo_id) {
            let state = RepoState::new(repo_info);
            states.insert(state.repo_id.clone(), state);
        }
    }

    /// Remove a repository from watch list
    pub fn remove_repo(&self, repo_id: &str) -> Option<RepoState> {
        self.states.write().remove(repo_id)
    }

    /// Get all watched repository IDs
    pub fn get_all_repo_ids(&self) -> Vec<String> {
        self.states.read().keys().cloned().collect()
    }

    pub fn get_repo_path(&self, repo_id: &str) -> Option<PathBuf> {
        self.states
            .read()
            .get(repo_id)
            .map(|state| state.repo_path.clone())
    }

    pub fn get_repo_info(&self, repo_id: &str) -> Option<RepoInfo> {
        self.states.read().get(repo_id).map(|state| RepoInfo {
            repo_id: state.repo_id.clone(),
            repo_path: state.repo_path.clone(),
            repo_name: state.repo_name.clone(),
        })
    }

    pub fn get_poll_health(&self, repo_id: &str) -> Option<(bool, u32)> {
        self.states
            .read()
            .get(repo_id)
            .map(|state| (state.watch_enabled, state.consecutive_failures))
    }

    /// Get all repo states (for health monitoring)
    pub fn get_all_states(&self) -> HashMap<String, RepoState> {
        self.states.read().clone()
    }

    /// Return only the small health fields needed by the background monitor.
    ///
    /// `RepoState` can own a complete cached `GitStatus`; cloning every state
    /// once per minute made health checks allocate in proportion to all
    /// changed files even when every watcher was healthy.
    pub fn get_unhealthy_watcher_ids(&self) -> Vec<(String, u32)> {
        self.states
            .read()
            .iter()
            .filter(|(_, state)| state.consecutive_failures >= 3 && state.watch_enabled)
            .map(|(repo_id, state)| (repo_id.clone(), state.consecutive_failures))
            .collect()
    }

    // ============================================
    // Dirty Flag Management
    // ============================================

    /// Mark repository as dirty (needs git status update)
    pub fn mark_dirty(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.is_dirty = true;
            state.last_fs_event_ts = Instant::now();
        }
    }

    /// Check if repository is dirty
    pub fn is_dirty(&self, repo_id: &str) -> bool {
        self.states
            .read()
            .get(repo_id)
            .map(|s| s.is_dirty)
            .unwrap_or(false)
    }

    /// Clear dirty flag
    pub fn clear_dirty(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.is_dirty = false;
        }
    }

    // ============================================
    // Cache Management
    // ============================================

    /// Update cached git status
    pub fn update_status(&self, repo_id: &str, status: GitStatus) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.cached_status = Some(status);
            state.last_git_status_ts = Some(Instant::now());
            state.cache_valid_until = Instant::now() + Duration::from_secs(CACHE_TTL_SECONDS);
            state.is_dirty = false;
            state.consecutive_failures = 0; // Reset failure count on success
        }
    }

    /// Get cached git status
    pub fn get_cached_status(&self, repo_id: &str) -> Option<GitStatus> {
        self.states
            .read()
            .get(repo_id)
            .and_then(|s| s.cached_status.clone())
    }

    /// Check if cache is valid
    pub fn is_cache_valid(&self, repo_id: &str) -> bool {
        self.states
            .read()
            .get(repo_id)
            .map(|s| s.is_cache_valid())
            .unwrap_or(false)
    }

    /// Get all cached statuses (for bulk UI updates)
    pub fn get_all_cached_statuses(&self) -> HashMap<String, GitStatus> {
        self.states
            .read()
            .iter()
            .filter_map(|(id, state)| {
                state
                    .cached_status
                    .clone()
                    .map(|status| (id.clone(), status))
            })
            .collect()
    }

    // ============================================
    // Health Management
    // ============================================

    /// Increment failure count
    pub fn increment_failures(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.consecutive_failures += 1;
        }
    }

    /// Mark repository as degraded
    pub fn mark_degraded(&self, repo_id: &str, reason: Option<String>) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.in_degraded_mode = true;
            log::warn!(
                "Repository {} marked as degraded: {}",
                repo_id,
                reason.unwrap_or_else(|| "Unknown reason".to_string())
            );
        }
    }

    /// Mark repository as healthy
    pub fn mark_healthy(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.in_degraded_mode = false;
            state.consecutive_failures = 0;
        }
    }

    /// Check if repository should be health tested
    pub fn should_test_health(&self, repo_id: &str) -> bool {
        self.states
            .read()
            .get(repo_id)
            .map(|s| s.should_test_health())
            .unwrap_or(false)
    }

    /// Check if repository is unhealthy
    pub fn is_unhealthy(&self, repo_id: &str) -> bool {
        self.states
            .read()
            .get(repo_id)
            .map(|s| s.is_unhealthy())
            .unwrap_or(false)
    }

    /// Update health check timestamp
    pub fn update_health_check(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.last_watcher_health_check = Instant::now();
        }
    }

    // ============================================
    // Job Management
    // ============================================

    /// Add an in-flight job
    pub fn add_job(&self, repo_id: &str, job_id: String) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            if !state.in_flight_jobs.contains(&job_id) {
                state.in_flight_jobs.push(job_id);
            }
        }
    }

    /// Remove an in-flight job
    pub fn remove_job(&self, repo_id: &str, job_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.in_flight_jobs.retain(|id| id != job_id);
        }
    }

    /// Get in-flight job count
    pub fn get_job_count(&self, repo_id: &str) -> usize {
        self.states
            .read()
            .get(repo_id)
            .map(|s| s.in_flight_jobs.len())
            .unwrap_or(0)
    }

    // ============================================
    // Watch Control
    // ============================================

    /// Enable watching for repository
    pub fn enable_watch(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.watch_enabled = true;
        }
    }

    /// Disable watching for repository
    pub fn disable_watch(&self, repo_id: &str) {
        if let Some(state) = self.states.write().get_mut(repo_id) {
            state.watch_enabled = false;
        }
    }

    /// Check if watching is enabled
    pub fn is_watch_enabled(&self, repo_id: &str) -> bool {
        self.states
            .read()
            .get(repo_id)
            .map(|s| s.watch_enabled)
            .unwrap_or(false)
    }

    // ============================================
    // Statistics
    // ============================================

    /// Get total number of watched repos
    pub fn get_repo_count(&self) -> usize {
        self.states.read().len()
    }

    /// Get health statistics
    pub fn get_health_stats(&self) -> (usize, usize, usize) {
        let states = self.states.read();
        let total = states.len();
        let degraded = states.values().filter(|s| s.in_degraded_mode).count();
        let failed = states.values().filter(|s| s.is_unhealthy()).count();
        let healthy = total - degraded - failed;
        (healthy, degraded, failed)
    }
}

impl Default for RepoStateStore {
    fn default() -> Self {
        Self::new()
    }
}
