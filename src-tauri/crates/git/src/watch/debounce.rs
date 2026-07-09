//! Adaptive debounce manager for fs-event coalescing
//!
//! Merges rapid file-system events into a single logical repo-change event
//! with a delay that adapts to the volume of changes (small diff = short wait,
//! large burst = longer wait).
//!
//! Fixed edge cases:
//! - Events arriving during the sleep window are no longer lost
//! - `Remote` change type is now correctly prioritised alongside `Branch`/`GitMeta`
//! - Added retry when a flush is deferred due to an in-progress git operation
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::event_emitter::EventEmitter;
use super::git_status::refresh_git_status_sync;
use super::state_store::RepoStateStore;
use super::types::*;

/// Maximum number of retry attempts for deferred flushes
const MAX_FLUSH_RETRIES: u32 = 5;

/// Minimum interval between status updates for the same repo (prevents event storms)
/// Increased to 5000ms (5s) to reduce file descriptor pressure from multiple git processes
/// and avoid conflicts with user-initiated git operations
const MIN_FLUSH_INTERVAL_MS: u64 = 5000;

/// Maximum concurrent git status operations (prevents file descriptor exhaustion)
/// Each operation spawns 4-6 git processes, so limit to 1 to prevent fd exhaustion
const MAX_CONCURRENT_GIT_OPS: u32 = 1;

/// Global counter for active git operations (simple semaphore)
static ACTIVE_GIT_OPS: AtomicU32 = AtomicU32::new(0);

pub(crate) fn truncate_preview(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

struct PendingEvent {
    change_type: RepoChangeType,
    first_event_at: Instant,
    last_event_at: Instant,
    total_affected: usize,
    flush_scheduled: bool,
    retry_count: u32,
}

pub struct DebounceManager {
    state_store: Arc<RepoStateStore>,
    event_emitter: Arc<EventEmitter>,
    pending_events: Arc<RwLock<HashMap<String, PendingEvent>>>,
    /// Track last flush time per repo to enforce minimum interval
    last_flush_times: Arc<RwLock<HashMap<String, Instant>>>,
    config: DebounceConfig,
}

impl DebounceManager {
    pub fn new(state_store: Arc<RepoStateStore>, event_emitter: Arc<EventEmitter>) -> Self {
        Self {
            state_store,
            event_emitter,
            pending_events: Arc::new(RwLock::new(HashMap::new())),
            last_flush_times: Arc::new(RwLock::new(HashMap::new())),
            config: DebounceConfig::default(),
        }
    }

    // ============================================
    // Operation Detection
    // ============================================

    /// Detect what git operation occurred by comparing old and new status
    /// Emits meaningful operation events for Output panel and Context signals
    fn detect_and_emit_operations(
        repo_id: &str,
        old_status: Option<&GitStatus>,
        new_status: &GitStatus,
        change_type: &RepoChangeType,
        event_emitter: &Arc<EventEmitter>,
    ) {
        // No old status = first load, don't emit operations
        let old = match old_status {
            Some(s) => s,
            None => return,
        };

        // 1. COMMIT: New commit hash on same branch
        if old.last_commit_hash != new_status.last_commit_hash
            && old.branch == new_status.branch
            && !new_status.last_commit_hash.is_empty()
        {
            let short_hash =
                &new_status.last_commit_hash[..7.min(new_status.last_commit_hash.len())];
            let message = truncate_preview(&new_status.last_commit_message, 50);

            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "commit",
                true,
                format!("Commit created: {}", short_hash),
                format!("\"{}\"", message),
            );
        }

        // 2. BRANCH SWITCH: Different branch
        if old.branch != new_status.branch && !new_status.branch.is_empty() {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "checkout",
                true,
                format!("Switched to branch '{}'", new_status.branch),
                format!("From '{}' to '{}'", old.branch, new_status.branch),
            );
        }

        // 3. PUSH: Was ahead, now less ahead (or at 0)
        if old.ahead > 0 && new_status.ahead < old.ahead {
            let pushed_count = old.ahead - new_status.ahead;
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "push",
                true,
                format!(
                    "Pushed {} commit{}",
                    pushed_count,
                    if pushed_count > 1 { "s" } else { "" }
                ),
                format!(
                    "Branch '{}' is now up to date with remote",
                    new_status.branch
                ),
            );
        }

        // 4. PULL/FETCH: Was behind, now less behind
        if old.behind > 0 && new_status.behind < old.behind {
            let pulled_count = old.behind - new_status.behind;
            // Check if this is from remote change type (fetch) vs commit hash change (pull)
            let is_fetch = matches!(change_type, RepoChangeType::Remote);
            let op = if is_fetch { "fetch" } else { "pull" };

            event_emitter.emit_git_operation(
                repo_id.to_string(),
                op,
                true,
                format!(
                    "{} {} commit{}",
                    if is_fetch { "Fetched" } else { "Pulled" },
                    pulled_count,
                    if pulled_count > 1 { "s" } else { "" }
                ),
                format!("Branch '{}' updated from remote", new_status.branch),
            );
        }

        // 5. MERGE STARTED: merge_in_progress became true
        if !old.merge_in_progress && new_status.merge_in_progress {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "merge",
                true, // In progress, not failed
                "Merge in progress".to_string(),
                "Resolve conflicts and commit to complete the merge".to_string(),
            );
        }

        // 6. MERGE COMPLETED: merge_in_progress became false + new commit
        if old.merge_in_progress
            && !new_status.merge_in_progress
            && old.last_commit_hash != new_status.last_commit_hash
        {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "merge",
                true,
                "Merge completed".to_string(),
                format!("Merged into '{}'", new_status.branch),
            );
        }

        // 7. REBASE STARTED
        if !old.rebase_in_progress && new_status.rebase_in_progress {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "rebase",
                true,
                "Rebase in progress".to_string(),
                "Continue with 'git rebase --continue' or abort with 'git rebase --abort'"
                    .to_string(),
            );
        }

        // 8. REBASE COMPLETED
        if old.rebase_in_progress && !new_status.rebase_in_progress {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "rebase",
                true,
                "Rebase completed".to_string(),
                format!("Branch '{}' rebased successfully", new_status.branch),
            );
        }

        // 9. CONFLICTS DETECTED
        if old.conflicted == 0 && new_status.conflicted > 0 {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "conflict",
                false, // This is a problem state
                format!(
                    "Merge conflict in {} file{}",
                    new_status.conflicted,
                    if new_status.conflicted > 1 { "s" } else { "" }
                ),
                "Resolve conflicts manually and stage the resolved files".to_string(),
            );
        }

        // 10. CONFLICTS RESOLVED
        if old.conflicted > 0 && new_status.conflicted == 0 && !new_status.merge_in_progress {
            event_emitter.emit_git_operation(
                repo_id.to_string(),
                "conflict",
                true,
                "All conflicts resolved".to_string(),
                "Ready to commit the merge".to_string(),
            );
        }
    }

    // ============================================
    // Event Handling
    // ============================================

    /// Trigger a new event (or update existing pending event)
    pub fn trigger_event(
        &self,
        repo_id: String,
        change_type: RepoChangeType,
        affected_count: usize,
    ) {
        self.trigger_event_internal(repo_id, change_type, affected_count, 0);
    }

    /// Internal trigger with retry count tracking
    fn trigger_event_internal(
        &self,
        repo_id: String,
        change_type: RepoChangeType,
        affected_count: usize,
        retry_count: u32,
    ) {
        let now = Instant::now();
        let mut pending = self.pending_events.write();

        // Check if a flush is already scheduled for this repo
        let already_scheduled = pending
            .get(&repo_id)
            .map(|e| e.flush_scheduled)
            .unwrap_or(false);

        // Get or create pending event
        let pending_event = pending.entry(repo_id.clone()).or_insert(PendingEvent {
            change_type: change_type.clone(),
            first_event_at: now,
            last_event_at: now,
            total_affected: 0,
            flush_scheduled: false,
            retry_count: 0,
        });

        // Update pending event
        pending_event.last_event_at = now;
        pending_event.total_affected += affected_count;
        pending_event.retry_count = retry_count;

        // Update change type if more important (Branch, GitMeta, Remote are all critical)
        match change_type {
            RepoChangeType::Branch | RepoChangeType::GitMeta | RepoChangeType::Remote => {
                pending_event.change_type = change_type;
            }
            _ => {}
        }

        // If a flush is already scheduled, just update the event and return
        // The scheduled flush will pick up the latest state
        if already_scheduled {
            return;
        }

        // Mark as scheduled
        pending_event.flush_scheduled = true;

        // Determine debounce delay
        let delay_ms = self.calculate_delay(
            &pending_event.change_type,
            pending_event.total_affected,
            pending_event.first_event_at.elapsed(),
        );

        // Schedule flush
        drop(pending); // Release lock before spawning

        Self::schedule_flush(
            repo_id,
            delay_ms,
            self.pending_events.clone(),
            self.last_flush_times.clone(),
            self.state_store.clone(),
            self.event_emitter.clone(),
            self.config,
        );
    }

    /// Schedule a flush attempt with retry logic.
    ///
    /// Uses `tauri::async_runtime::spawn` + `tokio::time::sleep` so the debounce
    /// delay does not occupy an OS thread. Must go through the tauri runtime
    /// handle (not `tokio::spawn`) because callers include the watcher's
    /// `std::thread` event processor, which has no tokio runtime context.
    /// The actual git status refresh runs in `tokio::task::spawn_blocking`
    /// because it calls blocking libgit2 APIs.
    fn schedule_flush(
        repo_id: String,
        delay_ms: u64,
        pending_events: Arc<RwLock<HashMap<String, PendingEvent>>>,
        last_flush_times: Arc<RwLock<HashMap<String, Instant>>>,
        state_store: Arc<RepoStateStore>,
        event_emitter: Arc<EventEmitter>,
        config: DebounceConfig,
    ) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;

            // Check if event still exists and should be flushed
            let (should_flush, should_retry, _retry_count) = {
                let pending = pending_events.read();
                if let Some(event) = pending.get(&repo_id) {
                    let elapsed = event.last_event_at.elapsed();
                    let stable_enough = elapsed >= Duration::from_millis(delay_ms);
                    let exceeded_max_wait =
                        event.first_event_at.elapsed() >= Duration::from_millis(config.max_wait_ms);
                    let can_retry = event.retry_count < MAX_FLUSH_RETRIES;

                    if stable_enough || exceeded_max_wait {
                        // Ready to flush (stable or hit max wait)
                        (true, false, event.retry_count)
                    } else if can_retry {
                        // Not stable yet, but can retry
                        (false, true, event.retry_count)
                    } else {
                        // Hit max retries, force flush
                        (true, false, event.retry_count)
                    }
                } else {
                    // Event was removed (cancelled)
                    (false, false, 0)
                }
            };

            if should_flush {
                // Run the blocking git status refresh on the blocking thread pool
                // so the tokio async worker threads are not stalled.
                tokio::task::spawn_blocking(move || {
                    Self::flush_event(
                        &repo_id,
                        pending_events,
                        last_flush_times,
                        state_store,
                        event_emitter,
                    );
                });
            } else if should_retry {
                // CRITICAL FIX: Reschedule instead of just clearing the flag
                // This prevents events from being lost during rapid changes
                let new_delay = {
                    let mut pending = pending_events.write();
                    if let Some(event) = pending.get_mut(&repo_id) {
                        event.retry_count += 1;
                        // Use a shorter delay for retries (50ms minimum)
                        let remaining = delay_ms
                            .saturating_sub(event.last_event_at.elapsed().as_millis() as u64);
                        remaining.max(50) // At least 50ms
                    } else {
                        return;
                    }
                };

                // Reschedule with remaining delay
                Self::schedule_flush(
                    repo_id,
                    new_delay,
                    pending_events,
                    last_flush_times,
                    state_store,
                    event_emitter,
                    config,
                );
            } else {
                // Clear scheduled flag (event was cancelled or completed)
                if let Some(event) = pending_events.write().get_mut(&repo_id) {
                    event.flush_scheduled = false;
                }
            }
        });
    }

    /// Cancel pending debounce for a repository
    pub fn cancel_debounce(&self, repo_id: &str) {
        self.pending_events.write().remove(repo_id);
    }

    // ============================================
    // Delay Calculation
    // ============================================

    /// Calculate adaptive delay based on change type and size
    fn calculate_delay(
        &self,
        change_type: &RepoChangeType,
        total_affected: usize,
        elapsed: Duration,
    ) -> u64 {
        // Immediate flush for critical git changes (commits, pushes, fetches, branch switches)
        match change_type {
            RepoChangeType::Branch | RepoChangeType::GitMeta | RepoChangeType::Remote => {
                return self.config.immediate_ms;
            }
            _ => {}
        }

        // Safety cap: if we've been waiting too long, flush now
        if elapsed.as_millis() >= self.config.max_wait_ms as u128 {
            return 0;
        }

        // Adaptive delay based on file count
        if total_affected <= 5 {
            self.config.small_change_ms
        } else if total_affected <= 50 {
            self.config.medium_change_ms
        } else {
            self.config.large_change_ms
        }
    }

    // ============================================
    // Event Flushing
    // ============================================

    /// Flush pending event (run git status and emit updates).
    /// Blocking — called via `tokio::task::spawn_blocking`.
    /// Uses global concurrency limit to prevent file descriptor exhaustion.
    fn flush_event(
        repo_id: &str,
        pending_events: Arc<RwLock<HashMap<String, PendingEvent>>>,
        last_flush_times: Arc<RwLock<HashMap<String, Instant>>>,
        state_store: Arc<RepoStateStore>,
        event_emitter: Arc<EventEmitter>,
    ) {
        // Check if this is a critical event that should bypass minimum interval
        let is_critical = {
            let pending = pending_events.read();
            pending
                .get(repo_id)
                .map(|e| {
                    matches!(
                        e.change_type,
                        RepoChangeType::GitMeta | RepoChangeType::Branch | RepoChangeType::Remote
                    )
                })
                .unwrap_or(false)
        };

        // Check minimum interval since last flush for this repo
        // CRITICAL events (merge/rebase/branch operations) bypass this check
        if !is_critical {
            let flush_times = last_flush_times.read();
            if let Some(last_flush) = flush_times.get(repo_id) {
                let elapsed = last_flush.elapsed();
                if elapsed < Duration::from_millis(MIN_FLUSH_INTERVAL_MS) {
                    // Too soon since last flush - skip this one
                    // CRITICAL: Clear flush_scheduled flag so next poll can schedule a new flush
                    let mut pending = pending_events.write();
                    if let Some(event) = pending.get_mut(repo_id) {
                        event.flush_scheduled = false;
                    }
                    return;
                }
            }
        }

        // CONCURRENCY LIMIT: Wait for slot if too many git ops are running
        // This prevents file descriptor exhaustion during rapid repo switching
        let mut wait_attempts = 0;
        const MAX_WAIT_ATTEMPTS: u32 = 20; // 2 seconds max wait (20 * 100ms)

        loop {
            let current = ACTIVE_GIT_OPS.load(Ordering::SeqCst);
            if current < MAX_CONCURRENT_GIT_OPS {
                // Try to acquire slot
                if ACTIVE_GIT_OPS
                    .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    break; // Got the slot
                }
                // CAS failed, another thread got it, retry
            } else {
                // Too many ops running, wait
                wait_attempts += 1;
                if wait_attempts > MAX_WAIT_ATTEMPTS {
                    log::debug!("[Debounce] Timeout waiting for git op slot for {}", repo_id);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        // Ensure we release the slot when done
        struct SlotGuard;
        impl Drop for SlotGuard {
            fn drop(&mut self) {
                ACTIVE_GIT_OPS.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _guard = SlotGuard;

        // Update last flush time
        {
            let mut flush_times = last_flush_times.write();
            flush_times.insert(repo_id.to_string(), Instant::now());
        }

        // Remove from pending
        let event_info = {
            let mut pending = pending_events.write();
            pending
                .remove(repo_id)
                .map(|e| (e.change_type, e.total_affected))
        };

        if let Some((change_type, affected_count)) = event_info {
            // Emit repo changed event
            event_emitter.emit_repo_changed(
                repo_id.to_string(),
                change_type.clone(),
                affected_count,
            );

            // Get repo path
            let repo_path = {
                let states = state_store.get_all_states();
                states.get(repo_id).map(|s| s.repo_path.clone())
            };

            if let Some(repo_path) = repo_path {
                // Get OLD status before refreshing (for operation detection)
                let old_status = state_store.get_cached_status(repo_id);

                // Run git status (lightweight synchronous operation)
                match refresh_git_status_sync(&repo_path) {
                    Ok(status) => {
                        // Emit coding activity heartbeats for each changed file
                        if matches!(change_type, RepoChangeType::Files) {
                            for file in &status.files {
                                crate::hooks::record_file_change(
                                    Some(repo_id.to_string()),
                                    file.path.clone(),
                                    0,
                                    0,
                                );
                            }
                        }

                        // Check if we were previously unhealthy
                        let was_unhealthy = state_store.is_unhealthy(repo_id);

                        // Detect and emit git operations by comparing old vs new status
                        Self::detect_and_emit_operations(
                            repo_id,
                            old_status.as_ref(),
                            &status,
                            &change_type,
                            &event_emitter,
                        );

                        // Update cache (this resets consecutive_failures to 0)
                        state_store.update_status(repo_id, status.clone());

                        // If we recovered from unhealthy state, emit recovery event
                        if was_unhealthy {
                            log::info!(
                                "[RepoWatch] Repo {} recovered from degraded state",
                                repo_id
                            );
                            event_emitter.emit_watcher_health(
                                repo_id.to_string(),
                                HealthStatus::Healthy,
                                Some("Recovered - git operations successful".to_string()),
                            );
                        }

                        // Emit status updated event
                        event_emitter.emit_status_updated(repo_id.to_string(), status);

                        // Mark git change for adaptive polling
                        if let Some(manager_lock) = super::REPO_WATCH_MANAGER.try_read() {
                            if let Some(manager) = manager_lock.as_ref() {
                                manager.watcher.mark_git_change(repo_id);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[RepoWatch] Failed to refresh git status for {}: {}",
                            repo_id,
                            e
                        );
                        state_store.increment_failures(repo_id);

                        // Check if we should mark as degraded
                        if state_store.is_unhealthy(repo_id) {
                            state_store.mark_degraded(repo_id, Some(e.to_string()));
                            event_emitter.emit_watcher_health(
                                repo_id.to_string(),
                                HealthStatus::Degraded,
                                Some(e.to_string()),
                            );
                        }
                    }
                }
            }
        }
    }
}
