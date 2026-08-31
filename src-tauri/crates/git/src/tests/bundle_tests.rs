use crate::bundle::*;

// ============================================
// Git repo info tests
// ============================================

#[test]
fn test_git_repo_info_non_repo() {
    // Test with a path that's not a git repo (like /tmp)
    let result = get_git_repo_info("/tmp".to_string());
    assert!(result.is_ok());
    let info = result.unwrap();
    assert!(!info.is_git_repo || info.branch_name.is_some());
}

// ============================================
// Ahead/behind calculation tests
// ============================================

#[test]
fn test_ahead_behind_invalid_path() {
    // Test with non-existent path
    let result = calculate_ahead_behind("/nonexistent/path".to_string(), "abc123".to_string());
    assert!(result.is_err());
}

#[test]
fn test_ahead_behind_non_repo() {
    // Test with path that exists but is not a git repo
    let result = calculate_ahead_behind("/tmp".to_string(), "abc123".to_string());
    assert!(result.is_err());
}

#[test]
fn test_ahead_behind_invalid_sha() {
    // This test needs a real git repo, so we use the current project
    // The test will fail with "invalid SHA" error which is expected
    let result = calculate_ahead_behind(".".to_string(), "invalid_sha".to_string());
    // Should error because "invalid_sha" is not a valid git object
    assert!(result.is_err());
}

// Note: Testing actual ahead/behind calculations requires a real git repo
// with known commit history. These tests verify error handling.
// Integration tests with actual repos would be needed for full coverage.

// ============================================
// git_commit — nothing-to-commit detection
// ============================================

/// Regression: git prints "nothing to commit, working tree clean" to STDOUT
/// (exit 1) with an empty stderr; git_commit checked stderr only, so a benign
/// no-op commit surfaced as `Err("git commit failed: ")` with no message.
#[test]
fn git_commit_treats_clean_tree_as_ok() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipping: git executable not available");
        return;
    }

    let repo = std::env::temp_dir().join(format!(
        "orgii-bundle-commit-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("create test repo dir");

    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write file");
    git(&["add", "."]);
    git(&["commit", "-m", "init"]);

    // Clean tree: must be Ok, not "git commit failed: ".
    let result = git_commit(
        repo.to_string_lossy().to_string(),
        "noop commit".to_string(),
    );
    assert_eq!(result, Ok(()), "clean tree is a benign no-op");

    // Dirty tree: commits normally.
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").expect("write file");
    git(&["add", "."]);
    let result = git_commit(
        repo.to_string_lossy().to_string(),
        "real commit".to_string(),
    );
    assert_eq!(result, Ok(()));

    let _ = std::fs::remove_dir_all(&repo);
}
