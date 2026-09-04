use crate::watch::state_store::*;
use crate::watch::types::{GitStatus, RepoInfo};
use std::path::PathBuf;

fn test_repo_info(id: &str) -> RepoInfo {
    RepoInfo {
        repo_id: id.to_string(),
        repo_path: PathBuf::from(format!("/tmp/repos/{}", id)),
        repo_name: format!("repo-{}", id),
    }
}

// ============================================
// Repository Management
// ============================================

#[test]
fn new_store_is_empty() {
    let store = RepoStateStore::new();
    assert_eq!(store.get_repo_count(), 0);
    assert!(store.get_all_repo_ids().is_empty());
}

#[test]
fn default_store_is_empty() {
    let store = RepoStateStore::default();
    assert_eq!(store.get_repo_count(), 0);
}

#[test]
fn add_repo_increases_count() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert_eq!(store.get_repo_count(), 1);
    assert!(store.get_all_repo_ids().contains(&"r1".to_string()));
}

#[test]
fn add_duplicate_repo_is_noop() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.add_repo(test_repo_info("r1"));
    assert_eq!(store.get_repo_count(), 1);
}

#[test]
fn remove_repo_returns_state() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    let removed = store.remove_repo("r1");
    assert!(removed.is_some());
    assert_eq!(removed.unwrap().repo_id, "r1");
    assert_eq!(store.get_repo_count(), 0);
}

#[test]
fn remove_nonexistent_returns_none() {
    let store = RepoStateStore::new();
    assert!(store.remove_repo("nonexistent").is_none());
}

// ============================================
// Dirty Flag Management
// ============================================

#[test]
fn new_repo_starts_dirty() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert!(store.is_dirty("r1"));
}

#[test]
fn clear_dirty_unsets_flag() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.clear_dirty("r1");
    assert!(!store.is_dirty("r1"));
}

#[test]
fn mark_dirty_sets_flag() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.clear_dirty("r1");
    store.mark_dirty("r1");
    assert!(store.is_dirty("r1"));
}

#[test]
fn is_dirty_returns_false_for_unknown_repo() {
    let store = RepoStateStore::new();
    assert!(!store.is_dirty("unknown"));
}

// ============================================
// Cache Management
// ============================================

#[test]
fn cache_initially_empty() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert!(store.get_cached_status("r1").is_none());
    assert!(!store.is_cache_valid("r1"));
}

#[test]
fn update_status_populates_cache() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));

    let status = GitStatus {
        branch: "main".to_string(),
        ahead: 2,
        behind: 1,
        staged: 3,
        ..Default::default()
    };
    store.update_status("r1", status.clone());

    let cached = store.get_cached_status("r1");
    assert!(cached.is_some());
    let cached_status = cached.unwrap();
    assert_eq!(cached_status.branch, "main");
    assert_eq!(cached_status.ahead, 2);
    assert_eq!(cached_status.behind, 1);
    assert_eq!(cached_status.staged, 3);
}

#[test]
fn update_status_clears_dirty() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert!(store.is_dirty("r1"));

    store.update_status("r1", GitStatus::default());
    assert!(!store.is_dirty("r1"));
}

#[test]
fn update_status_resets_failures() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.increment_failures("r1");
    store.increment_failures("r1");
    store.increment_failures("r1");
    assert!(store.is_unhealthy("r1"));

    store.update_status("r1", GitStatus::default());
    assert!(!store.is_unhealthy("r1"));
}

#[test]
fn lightweight_poll_health_does_not_require_status_snapshot() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.increment_failures("r1");
    store.increment_failures("r1");

    assert_eq!(store.get_poll_health("r1"), Some((true, 2)));
    assert_eq!(store.get_poll_health("missing"), None);
}

#[test]
fn is_cache_valid_returns_false_for_unknown() {
    let store = RepoStateStore::new();
    assert!(!store.is_cache_valid("unknown"));
}

// ============================================
// Health Management
// ============================================

#[test]
fn initially_healthy() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert!(!store.is_unhealthy("r1"));
}

#[test]
fn three_failures_makes_unhealthy() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));

    store.increment_failures("r1");
    assert!(!store.is_unhealthy("r1"));
    store.increment_failures("r1");
    assert!(!store.is_unhealthy("r1"));
    store.increment_failures("r1");
    assert!(store.is_unhealthy("r1"));
}

#[test]
fn mark_healthy_resets_state() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.increment_failures("r1");
    store.increment_failures("r1");
    store.increment_failures("r1");
    store.mark_degraded("r1", Some("test".to_string()));

    store.mark_healthy("r1");
    assert!(!store.is_unhealthy("r1"));
}

#[test]
fn is_unhealthy_returns_false_for_unknown() {
    let store = RepoStateStore::new();
    assert!(!store.is_unhealthy("unknown"));
}

// ============================================
// Health Statistics
// ============================================

#[test]
fn health_stats_all_healthy() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.add_repo(test_repo_info("r2"));

    let (healthy, degraded, failed) = store.get_health_stats();
    assert_eq!(healthy, 2);
    assert_eq!(degraded, 0);
    assert_eq!(failed, 0);
}

#[test]
fn health_stats_mixed() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.add_repo(test_repo_info("r2"));
    store.add_repo(test_repo_info("r3"));

    store.mark_degraded("r2", None);
    store.increment_failures("r3");
    store.increment_failures("r3");
    store.increment_failures("r3");

    let (healthy, degraded, failed) = store.get_health_stats();
    assert_eq!(healthy, 1);
    assert_eq!(degraded, 1);
    assert_eq!(failed, 1);
}

// ============================================
// Job Management
// ============================================

#[test]
fn add_and_remove_jobs() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert_eq!(store.get_job_count("r1"), 0);

    store.add_job("r1", "job-1".to_string());
    assert_eq!(store.get_job_count("r1"), 1);

    store.add_job("r1", "job-2".to_string());
    assert_eq!(store.get_job_count("r1"), 2);

    store.remove_job("r1", "job-1");
    assert_eq!(store.get_job_count("r1"), 1);
}

#[test]
fn add_duplicate_job_is_noop() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    store.add_job("r1", "job-1".to_string());
    store.add_job("r1", "job-1".to_string());
    assert_eq!(store.get_job_count("r1"), 1);
}

#[test]
fn job_count_for_unknown_repo() {
    let store = RepoStateStore::new();
    assert_eq!(store.get_job_count("unknown"), 0);
}

// ============================================
// Watch Control
// ============================================

#[test]
fn watch_enabled_by_default() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));
    assert!(store.is_watch_enabled("r1"));
}

#[test]
fn disable_and_enable_watch() {
    let store = RepoStateStore::new();
    store.add_repo(test_repo_info("r1"));

    store.disable_watch("r1");
    assert!(!store.is_watch_enabled("r1"));

    store.enable_watch("r1");
    assert!(store.is_watch_enabled("r1"));
}

#[test]
fn is_watch_enabled_returns_false_for_unknown() {
    let store = RepoStateStore::new();
    assert!(!store.is_watch_enabled("unknown"));
}
