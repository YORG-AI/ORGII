use crate::worktree::*;

// ============================================
// repo_hash
// ============================================

#[test]
fn repo_hash_stable() {
    let path = "/path/to/my-app";
    let hash1 = repo_hash(path);
    let hash2 = repo_hash(path);
    assert_eq!(hash1, hash2);
}

#[test]
fn repo_hash_contains_repo_name() {
    let hash = repo_hash("/path/to/my-app");
    assert!(hash.contains("my-app"));
}

#[test]
fn repo_hash_sanitizes_special_chars() {
    let hash = repo_hash("/path/to/My App!");
    assert!(hash.chars().all(|c| c.is_alphanumeric() || c == '-'));
    assert!(!hash.contains(' '));
    assert!(!hash.contains('!'));
}

#[test]
fn repo_hash_different_paths_different_hashes() {
    let hash1 = repo_hash("/path/to/repo-a");
    let hash2 = repo_hash("/path/to/repo-b");
    assert_ne!(hash1, hash2);
}

#[test]
fn repo_hash_empty_repo_name_fallback() {
    let hash = repo_hash("/");
    assert!(hash.starts_with("repo-"));
}

// ============================================
// validate_session_id
// ============================================

#[test]
fn validate_session_id_valid_uuid_like() {
    assert!(validate_session_id("abc123-def456-ghi789").is_ok());
}

#[test]
fn validate_session_id_empty_err() {
    assert!(validate_session_id("").is_err());
}

#[test]
fn validate_session_id_double_dot_err() {
    assert!(validate_session_id("session..id").is_err());
}

#[test]
fn validate_session_id_slash_err() {
    assert!(validate_session_id("session/id").is_err());
}

#[test]
fn validate_session_id_backslash_err() {
    assert!(validate_session_id("session\\id").is_err());
}

#[test]
fn validate_session_id_null_byte_err() {
    assert!(validate_session_id("session\0id").is_err());
}

#[test]
fn validate_session_id_alphanumeric_dashes_ok() {
    assert!(validate_session_id("code-abc123").is_ok());
}

// ============================================
// session_branch_name
// ============================================

#[test]
fn session_branch_name_strips_cli_prefix() {
    assert_eq!(session_branch_name("cliagent-abc123"), "agent/abc123");
}

#[test]
fn session_branch_name_no_prefix() {
    assert_eq!(session_branch_name("abc123"), "agent/abc123");
}

#[test]
fn session_branch_name_non_matching_prefix_kept() {
    assert_eq!(session_branch_name("code-abc123"), "agent/code-abc123");
}

#[test]
fn session_branch_name_empty_suffix_uses_full() {
    assert_eq!(session_branch_name("cliagent-"), "agent/cliagent-");
}

#[test]
fn session_branch_name_sanitizes_colon() {
    assert_eq!(
        session_branch_name("agent-builtin:explore-abc123"),
        "agent/agent-builtin-explore-abc123"
    );
}

#[test]
fn session_branch_name_sanitizes_multiple_invalid_chars() {
    assert_eq!(
        session_branch_name("shadow-builtin:general-x y~z"),
        "agent/shadow-builtin-general-x-y-z"
    );
}

// ============================================
// SessionWorktreeState::has_changes
// ============================================

#[test]
fn session_worktree_state_has_changes_matrix() {
    let base = SessionWorktreeState {
        worktree_path: std::path::PathBuf::from("/tmp/wt"),
        branch: "agent/abc".to_string(),
        worktree_exists: true,
        dirty: false,
        commits_ahead_of_base: 0,
    };
    assert!(!base.has_changes(), "clean + not ahead must be removable");

    let dirty = SessionWorktreeState {
        dirty: true,
        ..base.clone()
    };
    assert!(dirty.has_changes(), "dirty worktree must be kept");

    let ahead = SessionWorktreeState {
        commits_ahead_of_base: 2,
        ..base.clone()
    };
    assert!(ahead.has_changes(), "committed-ahead branch must be kept");

    // A pruned worktree dir with surviving commits still counts as work.
    let pruned_but_committed = SessionWorktreeState {
        worktree_exists: false,
        commits_ahead_of_base: 1,
        ..base
    };
    assert!(pruned_but_committed.has_changes());
}

// ============================================
// MergeStrategy::parse
// ============================================

#[test]
fn merge_strategy_parse() {
    assert_eq!(MergeStrategy::parse("auto"), MergeStrategy::AutoMerge);
    assert_eq!(MergeStrategy::parse("leave"), MergeStrategy::LeaveAsBranch);
    assert_eq!(MergeStrategy::parse("ff"), MergeStrategy::FastForward);
    assert_eq!(
        MergeStrategy::parse("unknown"),
        MergeStrategy::LeaveAsBranch
    );
}

// ============================================
// WorktreeMergeStatus::parse
// ============================================

#[test]
fn worktree_merge_status_parse_all_known() {
    assert_eq!(
        WorktreeMergeStatus::parse("pending"),
        Some(WorktreeMergeStatus::Pending)
    );
    assert_eq!(
        WorktreeMergeStatus::parse("merged"),
        Some(WorktreeMergeStatus::Merged)
    );
    assert_eq!(
        WorktreeMergeStatus::parse("conflict"),
        Some(WorktreeMergeStatus::Conflict)
    );
    assert_eq!(
        WorktreeMergeStatus::parse("skipped"),
        Some(WorktreeMergeStatus::Skipped)
    );
    assert_eq!(
        WorktreeMergeStatus::parse("failed"),
        Some(WorktreeMergeStatus::Failed)
    );
}

#[test]
fn worktree_merge_status_parse_unknown() {
    assert_eq!(WorktreeMergeStatus::parse("unknown"), None);
}

// ============================================
// WorktreeMergeStatus Display
// ============================================

#[test]
fn worktree_merge_status_display() {
    assert_eq!(format!("{}", WorktreeMergeStatus::Pending), "pending");
    assert_eq!(format!("{}", WorktreeMergeStatus::Merged), "merged");
    assert_eq!(format!("{}", WorktreeMergeStatus::Conflict), "conflict");
    assert_eq!(format!("{}", WorktreeMergeStatus::Skipped), "skipped");
    assert_eq!(format!("{}", WorktreeMergeStatus::Failed), "failed");
}

// ============================================
// parse_worktree_list_porcelain
// ============================================

#[test]
fn parse_porcelain_single_main_worktree() {
    let input = "\
worktree /Users/me/project
HEAD abc123def456
branch refs/heads/main
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "/Users/me/project");
    assert_eq!(entries[0].branch, "main");
    assert_eq!(entries[0].head_sha, "abc123def456");
    assert!(entries[0].is_main);
}

#[test]
fn parse_porcelain_main_plus_linked_worktrees() {
    let input = "\
worktree /Users/me/project
HEAD abc123
branch refs/heads/main

worktree /Users/me/worktrees/feature-1
HEAD def456
branch refs/heads/feature-1

worktree /Users/me/worktrees/feature-2
HEAD ghi789
branch refs/heads/feature-2
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries.len(), 3);

    assert!(entries[0].is_main);
    assert_eq!(entries[0].branch, "main");

    assert!(!entries[1].is_main);
    assert_eq!(entries[1].branch, "feature-1");
    assert_eq!(entries[1].path, "/Users/me/worktrees/feature-1");

    assert!(!entries[2].is_main);
    assert_eq!(entries[2].branch, "feature-2");
}

#[test]
fn parse_porcelain_skips_bare_repo() {
    let input = "\
worktree /Users/me/bare-repo.git
bare

worktree /Users/me/worktrees/dev
HEAD abc123
branch refs/heads/dev
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].is_main, "bare repo consumed the main slot");
    assert_eq!(entries[0].branch, "dev");
}

#[test]
fn parse_porcelain_detached_head() {
    let input = "\
worktree /Users/me/project
HEAD abc123
branch refs/heads/main

worktree /Users/me/worktrees/detached
HEAD def456
detached
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].branch, "");
    assert_eq!(entries[1].head_sha, "def456");
    assert!(!entries[1].is_main);
}

#[test]
fn parse_porcelain_empty_input() {
    let entries = parse_worktree_list_porcelain("");
    assert!(entries.is_empty());
}

#[test]
fn parse_porcelain_whitespace_only() {
    let entries = parse_worktree_list_porcelain("   \n\n   \n");
    assert!(entries.is_empty());
}

#[test]
fn parse_porcelain_strips_refs_heads_prefix() {
    let input = "\
worktree /repo
HEAD aaa
branch refs/heads/feature/nested/branch
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries[0].branch, "feature/nested/branch");
}

#[test]
fn parse_porcelain_preserves_non_standard_branch_ref() {
    let input = "\
worktree /repo
HEAD aaa
branch refs/tags/v1.0
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries[0].branch, "refs/tags/v1.0");
}

#[test]
fn parse_porcelain_bare_first_means_no_main() {
    let input = "\
worktree /bare
bare

worktree /main-repo
HEAD abc
branch refs/heads/main

worktree /linked
HEAD def
branch refs/heads/dev
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries.len(), 2);
    assert!(!entries[0].is_main, "bare consumed the main slot");
    assert!(!entries[1].is_main);
}

#[test]
fn parse_porcelain_is_main_only_first_entry() {
    let input = "\
worktree /main-repo
HEAD abc
branch refs/heads/main

worktree /linked-a
HEAD def
branch refs/heads/dev

worktree /linked-b
HEAD ghi
branch refs/heads/staging
";
    let entries = parse_worktree_list_porcelain(input);
    assert_eq!(entries.len(), 3);
    assert!(entries[0].is_main);
    assert!(!entries[1].is_main);
    assert!(!entries[2].is_main);
}

#[cfg(unix)]
#[test]
fn worktree_setup_command_is_terminated_at_deadline() {
    let dir = std::env::temp_dir();
    let started = std::time::Instant::now();
    let error = run_worktree_setup_command_with_timeout(
        &dir,
        &dir,
        "sleep 2",
        std::time::Duration::from_millis(50),
    )
    .expect_err("sleeping setup hook should time out");

    assert!(error.contains("timed out"));
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

// ============================================
// Liveness lock
// ============================================

fn unique_test_dir(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("orgii-worktree-lock-test-{tag}-{pid}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn worktree_lock_absent_file_is_stale() {
    let dir = unique_test_dir("absent");
    assert!(!worktree_lock_is_held(&dir));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn worktree_lock_acquire_then_release_is_stale_again() {
    let dir = unique_test_dir("acquire-release");

    let guard = try_acquire_worktree_lock(&dir)
        .unwrap()
        .expect("fresh lock file must be acquirable");
    assert!(worktree_lock_is_held(&dir));

    drop(guard);
    let probe = try_acquire_worktree_lock(&dir);
    assert!(
        matches!(&probe, Ok(Some(_))),
        "lock must become acquirable again once the holder drops its fd: {}",
        match &probe {
            Ok(Some(_)) => "acquired".to_string(),
            Ok(None) => "still held (EWOULDBLOCK)".to_string(),
            Err(err) => format!("probe error: {err}"),
        }
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn worktree_lock_held_by_another_fd_refuses() {
    let dir = unique_test_dir("held");

    let _holder = try_acquire_worktree_lock(&dir)
        .unwrap()
        .expect("first acquire should succeed");

    assert!(worktree_lock_is_held(&dir));
    let second = try_acquire_worktree_lock(&dir).unwrap();
    assert!(
        second.is_none(),
        "a second, independent fd must not acquire a lock already held"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn worktree_lock_probe_failure_blocks_cleanup() {
    let dir = unique_test_dir("probe-failure");
    std::fs::create_dir(dir.join(".orgii-worktree.lock")).unwrap();

    assert!(
        worktree_lock_is_held(&dir),
        "an unreadable lock target must fail closed so cleanup cannot remove user work"
    );

    std::fs::remove_dir_all(&dir).ok();
}

// ============================================
// session_worktree_root_for_path
// ============================================

#[test]
fn session_worktree_root_for_path_resolves_root_and_subdir() {
    let root = app_paths::agent_worktrees_root();
    let worktree_root = root.join("repo-hash-abc").join("session-123");
    let nested = worktree_root.join("src").join("lib.rs");

    assert_eq!(
        session_worktree_root_for_path(&worktree_root),
        Some(worktree_root.clone())
    );
    assert_eq!(session_worktree_root_for_path(&nested), Some(worktree_root));
}

#[test]
fn session_worktree_root_for_path_outside_root_is_none() {
    assert_eq!(
        session_worktree_root_for_path(std::path::Path::new("/tmp/not-a-worktree")),
        None
    );
}

fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn worktree_excludes_keep_lock_and_tmp_out_of_status() {
    let root = unique_test_dir("excludes");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);

    let worktree = root.join("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "session-x",
            worktree.to_str().unwrap(),
            "main",
        ],
    );

    ensure_worktree_excludes(&worktree).unwrap();
    ensure_worktree_excludes(&worktree).unwrap();

    std::fs::write(worktree.join(".orgii-worktree.lock"), "").unwrap();
    std::fs::create_dir_all(worktree.join(".orgii-tmp")).unwrap();
    std::fs::write(worktree.join(".orgii-tmp").join("scratch"), "x").unwrap();
    std::fs::write(worktree.join("work.txt"), "y").unwrap();

    let status = git(&worktree, &["status", "--porcelain"]);
    assert_eq!(status, "?? work.txt");

    let exclude = git(&worktree, &["rev-parse", "--git-path", "info/exclude"]);
    let exclude_path = {
        let candidate = std::path::PathBuf::from(&exclude);
        if candidate.is_absolute() {
            candidate
        } else {
            worktree.join(candidate)
        }
    };
    let contents = std::fs::read_to_string(exclude_path).unwrap();
    assert_eq!(contents.matches("/.orgii-worktree.lock").count(), 1);
    assert_eq!(contents.matches("/.orgii-tmp/").count(), 1);

    std::fs::remove_dir_all(&root).ok();
}
