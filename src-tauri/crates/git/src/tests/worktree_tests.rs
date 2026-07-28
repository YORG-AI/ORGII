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
