//! Repository File Watcher
//!
//! Watches `.git/` directory for immediate git state changes, combined with
//! adaptive polling for working directory changes.
//!
//! # Architecture
//!
//! The watcher uses a hybrid approach:
//! 1. **`.git/` directory watching** - Instant detection of git operations
//! 2. **Adaptive polling** (VSCode-style) - Catches working directory changes
//!
//! ## Why We Only Watch `.git/`
//!
//! Watching entire repositories causes EMFILE (too many open files) errors on
//! large repos with many files. The `.git/` directory is small (~50-100 files)
//! and contains all git state we need for instant updates.
//!
//! **Instant via `.git/` watching:**
//! - Commits (refs/heads changes)
//! - Branch switches (HEAD changes)
//! - Staging/unstaging (index changes)
//! - Fetches/pushes (refs/remotes changes)
//! - Merges/rebases (MERGE_HEAD, REBASE_HEAD)
//!
//! **Via active-workspace polling:**
//! - File edits in working directory
//! - New untracked files
//!
//! This matches VSCode's behavior which also uses polling for working directory.
//!
//! ```text
//! .git/ File Events                Adaptive Polling (Working Dir)
//!        │                              │
//!        ▼                              ▼
//! ┌──────────────────────────────────────────┐
//! │            DebounceManager               │
//! │  (coalesces rapid changes, 150-500ms)    │
//! └────────────────────┬─────────────────────┘
//!                      │
//!                      ▼
//! ┌──────────────────────────────────────────┐
//! │         Git Status Computation           │
//! │    (runs `git status`, `git log`, etc.)  │
//! └────────────────────┬─────────────────────┘
//!                      │
//!                      ▼
//! ┌──────────────────────────────────────────┐
//! │           EventEmitter                   │
//! │  (sends `repo:status-changed` to UI)     │
//! └──────────────────────────────────────────┘
//! ```
//!
//! # Adaptive Polling Strategy
//!
//! Polling frequency adjusts based on context to balance responsiveness vs resource usage:
//!
//! | Condition | Interval | Rationale |
//! |-----------|----------|-----------|
//! | Focused + healthy watched repos | 5s | User is viewing active workspace state |
//! | Window not focused + healthy watched repos | 30s | Background, save resources |
//! | No watched repos | Parked | No active workspace needs polling |
//! | Unhealthy watched repos | Exponential backoff up to 60s | Avoid hammering broken state |
//!
//! # Critical vs Debounced Git Paths
//!
//! - **Critical paths** (e.g., `.git/HEAD`, `.git/refs/heads`) indicate significant
//!   operations (commits, branch switches) and trigger immediate status updates.
//! - **Debounced paths** (e.g., `.git/index`) change frequently during staging
//!   and are processed with normal debouncing to avoid event storms.

use crossbeam_channel::{bounded, Receiver, Sender};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::debounce::DebounceManager;
use super::event_emitter::EventEmitter;
use super::state_store::RepoStateStore;
use super::types::*;

// ============================================
// Exclusion Patterns (for .git/ directory watching)
// ============================================

/// Subdirectories within .git/ to exclude from event processing.
/// These change frequently but don't affect git status.
const EXCLUDE_PATTERNS: &[&str] = &[
    ".git/objects", // Git object database (changes on every commit, very noisy)
    ".git/logs",    // Git reflogs (not needed for status)
    ".git/hooks",   // Git hooks (rarely changes)
    ".git/info",    // Git info (rarely changes)
    ".git/lfs",     // Git LFS cache (can be large)
];

// ============================================
// Git Path Classification
// ============================================

/// Critical git paths that trigger immediate status updates.
///
/// Changes to these files indicate significant git operations:
/// commits, branch switches, fetches, merges, rebases, etc.
const CRITICAL_GIT_PATHS: &[&str] = &[
    ".git/HEAD",             // Branch switches (most important!)
    ".git/FETCH_HEAD",       // After git fetch
    ".git/ORIG_HEAD",        // After merge/rebase (original HEAD backup)
    ".git/refs/heads",       // Local branch refs (commits update these)
    ".git/refs/remotes",     // Remote tracking branches (fetch/push)
    ".git/refs/tags",        // Tag changes
    ".git/config",           // Git configuration changes
    ".git/COMMIT_EDITMSG",   // Commit message being edited
    ".git/MERGE_HEAD",       // Merge in progress
    ".git/REBASE_HEAD",      // Rebase in progress (non-interactive)
    ".git/rebase-merge",     // Interactive rebase state
    ".git/rebase-apply",     // git am / rebase --apply state
    ".git/CHERRY_PICK_HEAD", // Cherry-pick in progress
    ".git/packed-refs",      // Packed references (after gc)
];

/// High-frequency git paths that should be debounced.
///
/// `.git/index` changes on every staging operation and would cause
/// event storms if processed immediately. Normal debouncing applies.
const DEBOUNCED_GIT_PATHS: &[&str] = &[
    ".git/index", // Staging area - changes on every git add/rm
];

// ============================================
// RepoWatcher
// ============================================

/// Watches one or more git repositories for file system changes.
///
/// Manages file watchers, processes events through debouncing,
/// and triggers git status updates when changes are detected.
pub struct RepoWatcher {
    /// Shared state store for all watched repositories
    state_store: Arc<RepoStateStore>,
    /// Event emitter for sending updates to the frontend
    event_emitter: Arc<EventEmitter>,
    /// Map of repo_id -> active file watcher
    watchers: Arc<RwLock<HashMap<String, RecommendedWatcher>>>,
    /// Debounce manager for coalescing rapid changes
    debounce_manager: Arc<DebounceManager>,
    /// Channel sender for file system events
    event_tx: Sender<(String, Event)>,
    /// Channel receiver for file system events (processed by background task)
    event_rx: Receiver<(String, Event)>,
    /// Last git change time per repo (for adaptive polling frequency)
    last_git_change: Arc<RwLock<HashMap<String, Instant>>>,
    /// Window focus state (polling is more aggressive when focused)
    window_focused: Arc<RwLock<bool>>,
    /// Repo currently allowed to use periodic working-directory polling.
    active_poll_repo_id: Arc<RwLock<Option<String>>>,
    /// Last poll attempt per repo (prevents stacking of slow polls)
    last_poll_attempt: Arc<RwLock<HashMap<String, Instant>>>,
    /// Wakes the poller when the watch scope transitions from empty to active.
    poll_wake: Arc<(Mutex<u64>, Condvar)>,
}

impl RepoWatcher {
    pub fn new(state_store: Arc<RepoStateStore>, event_emitter: Arc<EventEmitter>) -> Self {
        let (event_tx, event_rx) = bounded(1000);
        let debounce_manager = Arc::new(DebounceManager::new(
            state_store.clone(),
            event_emitter.clone(),
        ));

        let watcher = Self {
            state_store,
            event_emitter,
            watchers: Arc::new(RwLock::new(HashMap::new())),
            debounce_manager,
            event_tx,
            event_rx,
            last_git_change: Arc::new(RwLock::new(HashMap::new())),
            window_focused: Arc::new(RwLock::new(true)),
            active_poll_repo_id: Arc::new(RwLock::new(None)),
            last_poll_attempt: Arc::new(RwLock::new(HashMap::new())),
            poll_wake: Arc::new((Mutex::new(0), Condvar::new())),
        };

        // Start event processing loop
        watcher.start_event_processor();

        // Start periodic git status polling (like VSCode does)
        // This catches all git changes: staging, commits, branch switches, etc.
        watcher.start_git_status_polling();

        watcher
    }

    /// Start adaptive periodic git status polling (VSCode-style approach)
    /// Adjusts polling frequency based on window focus, git activity, and health:
    /// - Window focused + healthy: 5s
    /// - Window not focused + healthy: 30s
    /// - No watched repos: parked until a repo is watched
    /// - Unhealthy (degraded): Exponential backoff up to 60s
    ///
    /// Note: Each git status operation spawns 4-6 git processes, so conservative intervals
    /// are needed to prevent file descriptor exhaustion
    ///
    /// Uses std::thread with an ad-hoc tokio runtime instead of tokio::spawn because
    /// this runs during app setup before the global Tokio runtime is available.
    fn start_git_status_polling(&self) {
        let state_store = self.state_store.clone();
        let debounce_manager = self.debounce_manager.clone();
        let window_focused = self.window_focused.clone();
        let active_poll_repo_id = self.active_poll_repo_id.clone();
        let last_poll_attempt = self.last_poll_attempt.clone();
        let poll_wake = self.poll_wake.clone();

        std::thread::Builder::new()
            .name("repo-watcher-git-status-poller".to_string())
            .spawn(move || {
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(err) => {
                        log::error!(
                            "[RepoWatch] Git status poller runtime init failed: {}",
                            err
                        );
                        return;
                    }
                };
                rt.block_on(async move {
            // Small initial delay to let watchers initialize
            tokio::time::sleep(Duration::from_secs(2)).await;
            let mut seen_wake_generation = 0;

            loop {
                // Calculate adaptive polling interval with health awareness
                let is_focused = *window_focused.read();
                let states = state_store.get_all_states();
                let active_repo_id = active_poll_repo_id.read().clone();

                if active_repo_id.is_none() {
                    // Park until an active repo is set. Use spawn_blocking so the
                    // condvar wait does not block the tokio executor thread pool.
                    let poll_wake_clone = poll_wake.clone();
                    let wake_generation_at_park = seen_wake_generation;
                    let new_generation = tokio::task::spawn_blocking(move || {
                        let (lock, condvar) = &*poll_wake_clone;
                        let mut wake_generation =
                            lock.lock().expect("RepoWatch poll wake mutex poisoned");
                        while *wake_generation == wake_generation_at_park {
                            wake_generation = condvar
                                .wait(wake_generation)
                                .expect("RepoWatch poll wake mutex poisoned");
                        }
                        *wake_generation
                    })
                    .await
                    .unwrap_or(seen_wake_generation);
                    seen_wake_generation = new_generation;
                    continue;
                }

                let active_repo_id = active_repo_id.expect("checked active repo id above");
                let active_state = states.get(&active_repo_id);
                let active_watch_enabled = active_state
                    .map(|state| state.watch_enabled)
                    .unwrap_or(false);
                if !active_watch_enabled {
                    let poll_wake_clone = poll_wake.clone();
                    let wake_generation_at_park = seen_wake_generation;
                    let new_generation = tokio::task::spawn_blocking(move || {
                        let (lock, condvar) = &*poll_wake_clone;
                        let mut wake_generation =
                            lock.lock().expect("RepoWatch poll wake mutex poisoned");
                        while *wake_generation == wake_generation_at_park {
                            wake_generation = condvar
                                .wait(wake_generation)
                                .expect("RepoWatch poll wake mutex poisoned");
                        }
                        *wake_generation
                    })
                    .await
                    .unwrap_or(seen_wake_generation);
                    seen_wake_generation = new_generation;
                    continue;
                }

                let active_consecutive_failures = active_state
                    .map(|state| state.consecutive_failures)
                    .unwrap_or(0);
                let any_unhealthy = active_consecutive_failures > 0;

                let poll_interval_ms = Self::calculate_poll_interval_with_health(
                    is_focused,
                    any_unhealthy,
                    active_consecutive_failures,
                );

                tokio::time::sleep(Duration::from_millis(poll_interval_ms)).await;

                let Some(active_repo_id) = active_poll_repo_id.read().clone() else {
                    continue;
                };
                let states = state_store.get_all_states();
                let Some(state) = states.get(&active_repo_id) else {
                    continue;
                };

                if !state.watch_enabled {
                    continue;
                }

                if state.consecutive_failures >= 3 {
                    log::debug!(
                        "[RepoWatch] Skipping poll for degraded repo {} ({} failures)",
                        active_repo_id,
                        state.consecutive_failures
                    );
                    continue;
                }

                {
                    let last_attempts = last_poll_attempt.read();
                    if let Some(last_attempt) = last_attempts.get(&active_repo_id) {
                        if last_attempt.elapsed() < Duration::from_millis(5000) {
                            log::debug!(
                                "[RepoWatch] Skipping poll - last attempt {}ms ago (too recent)",
                                last_attempt.elapsed().as_millis()
                            );
                            continue;
                        }
                    }
                }

                last_poll_attempt
                    .write()
                    .insert(active_repo_id.clone(), Instant::now());

                debounce_manager.trigger_event(active_repo_id, RepoChangeType::GitMeta, 1);
            }
                });
            })
            .expect("Failed to spawn repo watcher git status poller thread");
    }

    /// Calculate adaptive polling interval based on window focus and health.
    fn calculate_poll_interval_with_health(
        is_focused: bool,
        any_unhealthy: bool,
        max_failures: u32,
    ) -> u64 {
        if any_unhealthy {
            let backoff_seconds = std::cmp::min(5 * (1 << max_failures), 60);
            log::debug!(
                "[RepoWatch] Health-aware polling: {} failures, {}s interval",
                max_failures,
                backoff_seconds
            );
            return (backoff_seconds * 1000) as u64;
        }

        if is_focused {
            5000
        } else {
            30000
        }
    }

    /// Update window focus state (called from frontend via Tauri command)
    pub fn set_window_focused(&self, focused: bool) {
        *self.window_focused.write() = focused;
    }

    pub fn set_active_polling_repo(&self, repo_id: Option<String>) {
        *self.active_poll_repo_id.write() = repo_id;
        let (lock, condvar) = &*self.poll_wake;
        let mut wake_generation = lock.lock().expect("RepoWatch poll wake mutex poisoned");
        *wake_generation = wake_generation.wrapping_add(1);
        condvar.notify_one();
    }

    /// Mark that a git change was detected for a repo (for adaptive polling)
    pub fn mark_git_change(&self, repo_id: &str) {
        let mut changes = self.last_git_change.write();
        changes.insert(repo_id.to_string(), Instant::now());
    }

    // ============================================
    // Watch Management
    // ============================================

    /// Start watching a repository
    ///
    /// ARCHITECTURE: We only watch the `.git/` directory, not the entire repo.
    ///
    /// Why:
    /// - Watching entire repos causes EMFILE (too many open files) on large repos
    /// - The `.git/` directory is small (~50-100 files) and contains all git state
    /// - Working directory changes are detected via active-workspace polling
    ///
    /// What we catch instantly via `.git/` watching:
    /// - Commits (refs/heads changes)
    /// - Branch switches (HEAD changes)
    /// - Staging/unstaging (.git/index changes)
    /// - Fetches/pushes (refs/remotes changes)
    /// - Merges/rebases (MERGE_HEAD, REBASE_HEAD, etc.)
    ///
    /// What we catch via adaptive polling:
    /// - File edits in working directory
    /// - New untracked files
    ///
    /// This matches VSCode's behavior which also uses polling for working directory.
    pub fn watch_repo(&self, repo_info: RepoInfo) -> Result<(), String> {
        let repo_path = &repo_info.repo_path;

        // Check if path exists
        if !repo_path.exists() {
            return Err(format!("Repository path does not exist: {:?}", repo_path));
        }

        // Check if it's a git repository
        let git_dir = repo_path.join(".git");
        if !git_dir.exists() {
            return Err(format!("Not a git repository: {:?}", repo_path));
        }

        // Add to state store and wake the poller if it was parked with no active repos.
        self.state_store.add_repo(repo_info.clone());
        {
            let (lock, condvar) = &*self.poll_wake;
            let mut wake_generation = lock.lock().expect("RepoWatch poll wake mutex poisoned");
            *wake_generation = wake_generation.wrapping_add(1);
            condvar.notify_one();
        }

        // Create watcher
        let repo_id = repo_info.repo_id.clone();
        let tx = self.event_tx.clone();
        let repo_path_clone = repo_path.clone();

        let _config = Config::default()
            .with_poll_interval(Duration::from_secs(2))
            .with_compare_contents(false);

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, _>| {
            match res {
                Ok(event) => {
                    // Filter out events from excluded paths and send to processor
                    if Self::should_process_event(&event, &repo_path_clone) {
                        if let Err(e) = tx.send((repo_id.clone(), event)) {
                            log::warn!("[RepoWatch] Failed to send event: {}", e);
                        }
                    }
                }
                Err(e) => {
                    // Only log non-transient errors
                    let error_str = format!("{:?}", e);
                    let is_transient = error_str.contains("Bad file descriptor")
                        || error_str.contains("No such file or directory")
                        || error_str.contains("Permission denied")
                        || error_str.contains("Resource temporarily unavailable");

                    if !is_transient {
                        log::warn!("[RepoWatch] Watcher error: {:?}", e);
                    }
                }
            }
        })
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // IMPORTANT: Only watch .git/ directory, NOT the entire repo
        // This prevents EMFILE (too many open files) errors on large repositories.
        // Working directory changes are detected via active-workspace polling.
        match watcher.watch(&git_dir, RecursiveMode::Recursive) {
            Ok(()) => {
                // Store watcher
                self.watchers
                    .write()
                    .insert(repo_info.repo_id.clone(), watcher);

                log::info!(
                    "Started watching repository: {} (watching .git/ only, polling for working directory)",
                    repo_info.repo_name
                );
            }
            Err(e) => {
                // GRACEFUL DEGRADATION: If watching fails (e.g., EMFILE),
                // the repo is still in state_store and will be polled for updates.
                // This is acceptable because active-workspace polling still covers git status.
                log::warn!(
                    "Failed to watch .git/ for {}, using polling-only mode: {}",
                    repo_info.repo_name,
                    e
                );

                // Mark as degraded but don't return an error
                self.state_store.mark_degraded(
                    &repo_info.repo_id,
                    Some(format!("File watching unavailable: {}", e)),
                );
            }
        }

        Ok(())
    }

    /// Stop watching a repository
    pub fn unwatch_repo(&self, repo_id: &str) -> Result<(), String> {
        // Remove watcher
        if let Some(watcher) = self.watchers.write().remove(repo_id) {
            // Watcher is automatically stopped when dropped
            drop(watcher);
        }

        // Remove from state store
        self.state_store.remove_repo(repo_id);

        // Cancel any pending debounce
        self.debounce_manager.cancel_debounce(repo_id);

        log::info!("Stopped watching repository: {}", repo_id);

        Ok(())
    }

    /// Stop all watchers
    pub fn unwatch_all(&self) {
        let repo_ids: Vec<String> = self.watchers.read().keys().cloned().collect();
        for repo_id in repo_ids {
            let _ = self.unwatch_repo(&repo_id);
        }
    }

    // ============================================
    // Event Processing
    // ============================================

    /// Start background event processing loop
    /// Uses std::thread instead of tokio::spawn because this runs during app setup
    /// before the Tokio runtime is fully initialized
    fn start_event_processor(&self) {
        let event_rx = self.event_rx.clone();
        let debounce_manager = self.debounce_manager.clone();
        let state_store = self.state_store.clone();
        let _event_emitter = self.event_emitter.clone();

        // Use std::thread instead of tokio::spawn - the channel is sync (crossbeam)
        std::thread::Builder::new()
            .name("repo-watcher-event-processor".to_string())
            .spawn(move || {
                loop {
                    match event_rx.recv() {
                        Ok((repo_id, event)) => {
                            // Determine change type (based on which .git/ file changed)
                            let change_type = Self::determine_change_type(&event);

                            // Count affected files
                            let affected_count = event.paths.len();

                            // Mark repo as dirty
                            state_store.mark_dirty(&repo_id);

                            // Trigger debounced git status update
                            debounce_manager.trigger_event(repo_id, change_type, affected_count);
                        }
                        Err(_) => {
                            // Channel closed, exit loop
                            log::info!("[RepoWatch] Event processor channel closed, exiting");
                            break;
                        }
                    }
                }
            })
            .expect("Failed to spawn repo watcher event processor thread");
    }

    // NOTE: emit_file_events was removed because we only watch .git/ directory now.
    // Working directory file changes are detected via polling (git status).
    // The Filesync feature uses its own file watching if needed.

    /// Determine if event should be processed
    /// Priority: Critical git paths > Debounced git paths > Exclude patterns > Default allow
    /// Returns (should_process, is_critical)
    fn should_process_event(event: &Event, repo_path: &Path) -> bool {
        Self::classify_event(event, repo_path).0
    }

    /// Classify a .git/ event - returns (should_process, is_critical)
    ///
    /// Since we only watch .git/ directory, classification is simpler:
    /// 1. Critical paths (HEAD, refs, etc.) → process immediately
    /// 2. Debounced paths (index) → process with debouncing
    /// 3. Excluded paths (objects, logs) → skip
    /// 4. Other .git/ paths → process with debouncing
    pub(crate) fn classify_event(event: &Event, _repo_path: &Path) -> (bool, bool) {
        if event.paths.is_empty() {
            return (false, false);
        }

        let mut has_critical_path = false;
        let mut has_debounced_path = false;
        let mut has_processable_path = false;

        for path in &event.paths {
            // Normalize separators so `.git/HEAD` patterns match on Windows too
            let path_normalized = path.to_string_lossy().replace('\\', "/");

            // Extract the .git/... portion for pattern matching
            let rel_path_str = if let Some(idx) = path_normalized.find(".git") {
                &path_normalized[idx..]
            } else {
                continue; // Not a .git path, skip
            };

            // Check critical git paths (commits, branch switches, etc.)
            for critical_path in CRITICAL_GIT_PATHS {
                if rel_path_str.starts_with(critical_path) {
                    has_critical_path = true;
                    break;
                }
            }

            if has_critical_path {
                continue;
            }

            // Check debounced git paths (index - changes frequently during staging)
            for debounced_path in DEBOUNCED_GIT_PATHS {
                if rel_path_str.starts_with(debounced_path) {
                    has_debounced_path = true;
                    break;
                }
            }

            if has_debounced_path {
                continue;
            }

            // Check excluded paths (objects, logs - too noisy)
            let mut is_excluded = false;
            for pattern in EXCLUDE_PATTERNS {
                if rel_path_str.starts_with(pattern) {
                    is_excluded = true;
                    break;
                }
            }

            if is_excluded {
                continue;
            }

            // Other .git/ paths are processable
            has_processable_path = true;
        }

        let should_process = has_critical_path || has_debounced_path || has_processable_path;
        let is_critical = has_critical_path;

        (should_process, is_critical)
    }

    /// Determine the type of change
    pub(crate) fn determine_change_type(event: &Event) -> RepoChangeType {
        for path in &event.paths {
            // Normalize separators so `.git/HEAD` patterns match on Windows too
            let path_str = path.to_string_lossy().replace('\\', "/");

            // Check specific git path types (order matters - more specific first)

            // Branch switch
            if path_str.contains(".git/HEAD") {
                return RepoChangeType::Branch;
            }

            // Remote tracking (fetch/push)
            if path_str.contains(".git/refs/remotes") || path_str.contains(".git/FETCH_HEAD") {
                return RepoChangeType::Remote;
            }

            // Local branch (commit)
            if path_str.contains(".git/refs/heads") {
                return RepoChangeType::GitMeta;
            }

            // .git/index is high-frequency - treat as Files to apply normal debouncing
            if path_str.contains(".git/index") {
                return RepoChangeType::Files;
            }

            // CRITICAL: Merge/rebase/cherry-pick state files - immediate processing
            if path_str.contains(".git/MERGE_HEAD") ||
               path_str.contains(".git/REBASE_HEAD") ||
               path_str.contains(".git/rebase-merge") ||   // Interactive rebase
               path_str.contains(".git/rebase-apply") ||   // git am / rebase --apply
               path_str.contains(".git/CHERRY_PICK_HEAD") ||
               path_str.contains(".git/ORIG_HEAD") ||
               path_str.contains(".git/COMMIT_EDITMSG")
            {
                return RepoChangeType::GitMeta;
            }

            // Other git metadata (config, packed-refs, etc.)
            if path_str.contains(".git/refs")
                || path_str.contains(".git/packed-refs")
                || path_str.contains(".git/config")
            {
                return RepoChangeType::GitMeta;
            }
        }

        // Default to file changes
        RepoChangeType::Files
    }

    // ============================================
    // Health Checks
    // ============================================

    /// Test watcher responsiveness by creating a temp file
    pub async fn test_watcher_health(&self, repo_id: &str) -> Result<(), String> {
        // Get repo path
        let repo_path = {
            let states = self.state_store.get_all_states();
            states
                .get(repo_id)
                .map(|s| s.repo_path.clone())
                .ok_or_else(|| "Repository not found".to_string())?
        };

        // Create a temp file in .git directory
        let test_file = repo_path.join(".git").join(".orgii_health_test");

        // Write and delete test file
        if let Err(e) = tokio::fs::write(&test_file, b"health_check").await {
            return Err(format!("Failed to write test file: {}", e));
        }

        // Wait a bit
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Delete test file
        let _ = tokio::fs::remove_file(&test_file).await;

        // Update health check timestamp
        self.state_store.update_health_check(repo_id);

        Ok(())
    }

    /// Restart watcher for a repository
    pub fn restart_watcher(&self, repo_id: &str) -> Result<(), String> {
        // Get repo info
        let repo_info = {
            let states = self.state_store.get_all_states();
            let state = states
                .get(repo_id)
                .ok_or_else(|| "Repository not found".to_string())?;

            RepoInfo {
                repo_id: state.repo_id.clone(),
                repo_path: state.repo_path.clone(),
                repo_name: state.repo_name.clone(),
            }
        };

        // Unwatch and rewatch
        let _ = self.unwatch_repo(repo_id);
        self.watch_repo(repo_info)?;

        log::info!("Restarted watcher for repository: {}", repo_id);

        Ok(())
    }

    // ============================================
}
