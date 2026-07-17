//! Type definitions for the repository watching system
//!
//! Covers: `RepoInfo`, `WatchState`, `GitStatus`, `ChangeType`,
//! `HealthStatus`, `WatchEvent`, and related value objects.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

// ============================================
// Repository Info
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoInfo {
    pub repo_id: String,
    pub repo_path: PathBuf,
    pub repo_name: String,
}

// ============================================
// Repository State
// ============================================

#[derive(Debug, Clone)]
pub struct RepoState {
    pub repo_id: String,
    pub repo_path: PathBuf,
    pub repo_name: String,

    // Timestamps
    pub last_fs_event_ts: Instant,
    pub last_git_status_ts: Option<Instant>,
    pub last_watcher_health_check: Instant,

    // Flags
    pub is_dirty: bool,
    pub watch_enabled: bool,

    // Cached data
    pub cached_status: Option<GitStatus>,
    pub cache_valid_until: Instant,

    // Health
    pub consecutive_failures: u32,
    pub in_degraded_mode: bool,

    // Jobs
    pub in_flight_jobs: Vec<String>,
}

impl RepoState {
    pub fn new(repo_info: RepoInfo) -> Self {
        let now = Instant::now();
        Self {
            repo_id: repo_info.repo_id,
            repo_path: repo_info.repo_path,
            repo_name: repo_info.repo_name,
            last_fs_event_ts: now,
            last_git_status_ts: None,
            last_watcher_health_check: now,
            is_dirty: true, // Start as dirty to trigger initial status
            watch_enabled: true,
            cached_status: None,
            cache_valid_until: now,
            consecutive_failures: 0,
            in_degraded_mode: false,
            in_flight_jobs: Vec::new(),
        }
    }

    pub fn is_cache_valid(&self) -> bool {
        Instant::now() < self.cache_valid_until
    }

    pub fn should_test_health(&self) -> bool {
        // Test health if no events for 5 minutes on watched repo
        self.watch_enabled
            && !self.in_degraded_mode
            && self.last_fs_event_ts.elapsed() > Duration::from_secs(300)
    }

    pub fn should_retry_watcher(&self) -> bool {
        !self.watch_enabled
            && self.in_degraded_mode
            && self.last_watcher_health_check.elapsed()
                >= Duration::from_secs(WATCHER_RESTART_DELAY_SECONDS)
    }

    pub fn is_unhealthy(&self) -> bool {
        self.consecutive_failures >= 3
    }
}

// ============================================
// Git Status
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub current_upstream_branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    /// Count of files with unresolved merge conflicts
    pub conflicted: u32,
    pub last_commit_hash: String,
    pub last_commit_message: String,
    /// File list for status updates - always included for real-time source control updates
    pub files: Vec<GitStatusFile>,

    // ============================================
    // Git Operation States (for context engineering)
    // ============================================
    /// True if .git/MERGE_HEAD exists (merge in progress)
    #[serde(default)]
    pub merge_in_progress: bool,
    /// True if .git/rebase-merge or .git/rebase-apply exists
    #[serde(default)]
    pub rebase_in_progress: bool,
    /// True if .git/CHERRY_PICK_HEAD exists
    #[serde(default)]
    pub cherry_pick_in_progress: bool,
    /// True if .git/REVERT_HEAD exists
    #[serde(default)]
    pub revert_in_progress: bool,
    /// True if .git/BISECT_LOG exists
    #[serde(default)]
    pub bisect_in_progress: bool,
}

/// Lightweight file status for event payloads
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusFile {
    pub path: String,
    pub status: String, // M, A, D, R, C, U, ?, !
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

impl Default for GitStatus {
    fn default() -> Self {
        Self {
            branch: String::from("main"),
            current_upstream_branch: None,
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            last_commit_hash: String::new(),
            last_commit_message: String::new(),
            files: Vec::new(),
            merge_in_progress: false,
            rebase_in_progress: false,
            cherry_pick_in_progress: false,
            revert_in_progress: false,
            bisect_in_progress: false,
        }
    }
}

// ============================================
// Watch Status
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchStatus {
    pub watching: HashMap<String, WatcherHealth>,
    pub total_repos: usize,
    pub healthy_repos: usize,
    pub degraded_repos: usize,
    pub failed_repos: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherHealth {
    pub repo_id: String,
    pub repo_name: String,
    pub status: HealthStatus,
    pub mode: WatchMode,
    pub reason: Option<String>,
    pub last_event: Option<u64>, // timestamp in ms
    pub cache_valid: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HealthStatus {
    Healthy,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WatchMode {
    EventDriven,  // Tier 1: 0ms latency
    SmartPolling, // Tier 2: 10s, only if dirty
    SlowPolling,  // Tier 3: 60s, if watcher failed
    Disabled,     // Tier 4: Manual refresh only
}

// ============================================
// File System Events
// ============================================

#[derive(Debug, Clone, PartialEq)]
pub enum RepoChangeType {
    Files,
    GitMeta, // .git/HEAD, .git/refs/*
    Branch,
    Remote,
}

#[derive(Debug, Clone)]
pub struct RepoChangedEvent {
    pub repo_id: String,
    pub change_type: RepoChangeType,
    pub affected_count: usize,
    pub timestamp: u64,
}

// ============================================
// Python Worker Types
// ============================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum JobPriority {
    Immediate = 0,
    High = 1,
    Low = 2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobType {
    Index,
    Embed,
    Analyze,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub job_id: String,
    pub repo_id: String,
    pub repo_path: PathBuf,
    pub job_type: JobType,
    pub priority: JobPriority,
    pub created_at: u64, // timestamp in ms
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum JobState {
    Started,
    Progress,
    Completed,
    Failed,
}

// ============================================
// Debounce Configuration
// ============================================

#[derive(Debug, Clone, Copy)]
pub struct DebounceConfig {
    pub small_change_ms: u64,  // 1-5 files: 50ms
    pub medium_change_ms: u64, // 6-50 files: 200ms
    pub large_change_ms: u64,  // 50+ files: 500ms
    pub immediate_ms: u64,     // Git meta changes: 0ms
    pub max_wait_ms: u64,      // Safety cap: 2000ms
}

impl Default for DebounceConfig {
    fn default() -> Self {
        Self {
            small_change_ms: 300,  // Increased from 100ms to reduce event frequency
            medium_change_ms: 500, // Increased from 300ms
            large_change_ms: 1000, // Increased from 500ms
            immediate_ms: 50, // Near-instant for critical git state changes (MERGE_HEAD, REBASE_HEAD, etc.)
            max_wait_ms: 3000, // Increased from 2000ms
        }
    }
}

// ============================================
// Resource Limits
// ============================================

pub const MAX_WATCHED_REPOS: usize = 20;
pub const MAX_CACHE_SIZE_MB: usize = 50;
pub const MAX_PYTHON_WORKERS: usize = 3;
pub const MAX_FILE_DESCRIPTORS_PER_REPO: usize = 1000;
pub const CACHE_TTL_SECONDS: u64 = 30;
pub const HEALTH_CHECK_INTERVAL_SECONDS: u64 = 60;
pub const WATCHER_RESTART_DELAY_SECONDS: u64 = 300; // 5 minutes
