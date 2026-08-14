use notify::{event::ModifyKind, Event, EventKind};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::watch::types::{RepoChangeType, WatchActivity};
use crate::watch::watcher::{select_watch_eviction_victims, RepoWatcher};

fn make_event(paths: Vec<PathBuf>) -> Event {
    Event {
        kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
        paths,
        attrs: Default::default(),
    }
}

fn watch_activity(repo_id: &str, age: Duration, has_in_flight_jobs: bool) -> WatchActivity {
    WatchActivity {
        repo_id: repo_id.to_string(),
        last_activity: Instant::now() - age,
        has_in_flight_jobs,
    }
}

// ============================================
// watch capacity eviction
// ============================================

#[test]
fn watch_capacity_evicts_oldest_idle_repositories() {
    let activity = vec![
        watch_activity("recent", Duration::from_secs(10), false),
        watch_activity("oldest", Duration::from_secs(30), false),
        watch_activity("older", Duration::from_secs(20), false),
    ];

    assert_eq!(
        select_watch_eviction_victims(&activity, &[], 2),
        vec!["oldest".to_string(), "older".to_string()]
    );
}

#[test]
fn watch_capacity_preserves_protected_and_busy_repositories() {
    let activity = vec![
        watch_activity("active-poll", Duration::from_secs(40), false),
        watch_activity("busy", Duration::from_secs(30), true),
        watch_activity("eligible", Duration::from_secs(20), false),
    ];

    assert_eq!(
        select_watch_eviction_victims(&activity, &["active-poll", "incoming"], 3),
        vec!["eligible".to_string()]
    );
}

#[test]
fn watch_capacity_does_nothing_without_overflow() {
    let activity = vec![watch_activity("repo", Duration::from_secs(10), false)];

    assert!(select_watch_eviction_victims(&activity, &[], 0).is_empty());
}

// ============================================
// classify_event: Windows backslash paths
// ============================================

#[test]
fn classify_event_unix_head_is_critical() {
    let event = make_event(vec![PathBuf::from("/repo/.git/HEAD")]);
    let (should_process, is_critical) = RepoWatcher::classify_event(&event, Path::new("/repo"));
    assert!(should_process, "HEAD change should be processed");
    assert!(is_critical, "HEAD change should be critical");
}

#[test]
fn classify_event_windows_head_is_critical() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\HEAD")]);
    let (should_process, is_critical) =
        RepoWatcher::classify_event(&event, Path::new(r"C:\Users\dev\repo"));
    assert!(should_process, "Windows HEAD change should be processed");
    assert!(is_critical, "Windows HEAD change should be critical");
}

#[test]
fn classify_event_windows_refs_heads_is_critical() {
    let event = make_event(vec![PathBuf::from(
        r"C:\Users\dev\repo\.git\refs\heads\main",
    )]);
    let (should_process, is_critical) =
        RepoWatcher::classify_event(&event, Path::new(r"C:\Users\dev\repo"));
    assert!(should_process, "Windows refs/heads should be processed");
    assert!(is_critical, "Windows refs/heads should be critical");
}

#[test]
fn classify_event_windows_index_is_debounced() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\index")]);
    let (should_process, is_critical) =
        RepoWatcher::classify_event(&event, Path::new(r"C:\Users\dev\repo"));
    assert!(should_process, "Windows index change should be processed");
    assert!(!is_critical, "Windows index change should NOT be critical");
}

#[test]
fn classify_event_windows_objects_excluded() {
    let event = make_event(vec![PathBuf::from(
        r"C:\Users\dev\repo\.git\objects\pack\pack-abc.idx",
    )]);
    let (should_process, _) = RepoWatcher::classify_event(&event, Path::new(r"C:\Users\dev\repo"));
    assert!(!should_process, "Windows .git/objects should be excluded");
}

// ============================================
// determine_change_type: Windows backslash paths
// ============================================

#[test]
fn determine_change_type_windows_head_is_branch() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\HEAD")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::Branch,
    );
}

#[test]
fn determine_change_type_windows_refs_remotes_is_remote() {
    let event = make_event(vec![PathBuf::from(
        r"C:\Users\dev\repo\.git\refs\remotes\origin\main",
    )]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::Remote,
    );
}

#[test]
fn determine_change_type_windows_fetch_head_is_remote() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\FETCH_HEAD")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::Remote,
    );
}

#[test]
fn determine_change_type_windows_refs_heads_is_gitmeta() {
    let event = make_event(vec![PathBuf::from(
        r"C:\Users\dev\repo\.git\refs\heads\feature",
    )]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::GitMeta,
    );
}

#[test]
fn determine_change_type_windows_index_is_files() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\index")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::Files,
    );
}

#[test]
fn determine_change_type_windows_merge_head_is_gitmeta() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\MERGE_HEAD")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::GitMeta,
    );
}

#[test]
fn determine_change_type_windows_config_is_gitmeta() {
    let event = make_event(vec![PathBuf::from(r"C:\Users\dev\repo\.git\config")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::GitMeta,
    );
}

// ============================================
// Unix paths still work (regression guard)
// ============================================

#[test]
fn determine_change_type_unix_head_is_branch() {
    let event = make_event(vec![PathBuf::from("/repo/.git/HEAD")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::Branch,
    );
}

#[test]
fn determine_change_type_unix_refs_remotes_is_remote() {
    let event = make_event(vec![PathBuf::from("/repo/.git/refs/remotes/origin/main")]);
    assert_eq!(
        RepoWatcher::determine_change_type(&event),
        RepoChangeType::Remote,
    );
}
