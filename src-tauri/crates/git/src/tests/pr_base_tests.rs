use std::cell::RefCell;

use crate::pr_base::{
    is_missing_remote_ref_error, normalize_remote, pull_head_refspec, resolve_pr_base_with,
    GitInvocation, PrBaseSource,
};

// ============================================
// is_missing_remote_ref_error
// ============================================

#[test]
fn missing_remote_ref_matches_git_fetch_message() {
    assert!(is_missing_remote_ref_error(
        "fatal: couldn't find remote ref feature/does-not-exist"
    ));
}

#[test]
fn missing_remote_ref_matches_uppercase_message() {
    assert!(is_missing_remote_ref_error(
        "FATAL: Couldn't find remote ref refs/heads/gone"
    ));
}

#[test]
fn missing_remote_ref_ignores_auth_failure() {
    assert!(!is_missing_remote_ref_error(
        "fatal: Authentication failed for 'https://github.com/acme/app.git/'"
    ));
}

#[test]
fn missing_remote_ref_ignores_network_failure() {
    assert!(!is_missing_remote_ref_error(
        "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host"
    ));
}

// ============================================
// pull_head_refspec / normalize_remote
// ============================================

#[test]
fn pull_head_refspec_formats_number() {
    assert_eq!(pull_head_refspec(42), "refs/pull/42/head");
}

#[test]
fn normalize_remote_defaults_to_origin() {
    assert_eq!(normalize_remote(None), "origin");
    assert_eq!(normalize_remote(Some("   ")), "origin");
    assert_eq!(normalize_remote(Some("upstream")), "upstream");
    assert_eq!(normalize_remote(Some("  fork ")), "fork");
}

// ============================================
// resolve_pr_base_with — mock runner harness
// ============================================

/// Records every git invocation and replies from a scripted queue.
struct MockGit {
    calls: RefCell<Vec<Vec<String>>>,
    replies: RefCell<Vec<Result<GitInvocation, String>>>,
}

impl MockGit {
    fn new(replies: Vec<Result<GitInvocation, String>>) -> Self {
        Self {
            calls: RefCell::new(Vec::new()),
            replies: RefCell::new(replies),
        }
    }

    fn run(&self, args: &[&str]) -> Result<GitInvocation, String> {
        self.calls
            .borrow_mut()
            .push(args.iter().map(|s| s.to_string()).collect());
        if self.replies.borrow().is_empty() {
            return Err(format!("unexpected git call: {:?}", args));
        }
        self.replies.borrow_mut().remove(0)
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.borrow().clone()
    }
}

fn ok(stdout: &str) -> Result<GitInvocation, String> {
    Ok(GitInvocation {
        success: true,
        stdout: stdout.to_string(),
        stderr: String::new(),
    })
}

fn fail(stderr: &str) -> Result<GitInvocation, String> {
    Ok(GitInvocation {
        success: false,
        stdout: String::new(),
        stderr: stderr.to_string(),
    })
}

#[test]
fn resolves_same_repo_pr_via_branch_fetch() {
    let mock = MockGit::new(vec![
        ok(""),                                           // fetch origin <head>
        ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"), // rev-parse FETCH_HEAD
    ]);

    let result = resolve_pr_base_with(
        "origin",
        42,
        Some("feature/add-caching"),
        Some("main"),
        |args| mock.run(args),
    )
    .expect("resolution should succeed");

    assert_eq!(result.source, PrBaseSource::Branch);
    assert_eq!(result.base_ref, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(result.head_sha, result.base_ref);
    assert_eq!(
        result.branch_name_override.as_deref(),
        Some("feature/add-caching")
    );
    assert_eq!(
        result.compare_base_ref.as_deref(),
        Some("refs/remotes/origin/main")
    );

    let calls = mock.calls();
    assert_eq!(
        calls[0],
        vec!["fetch", "--no-tags", "origin", "feature/add-caching"]
    );
    assert_eq!(calls[1], vec!["rev-parse", "--verify", "FETCH_HEAD"]);
}

#[test]
fn falls_back_to_pull_ref_for_fork_pr() {
    let mock = MockGit::new(vec![
        fail("fatal: couldn't find remote ref forkbranch"), // branch fetch misses
        ok(""),                                             // fetch refs/pull/7/head
        ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),   // rev-parse FETCH_HEAD
    ]);

    let result = resolve_pr_base_with("origin", 7, Some("forkbranch"), Some("develop"), |args| {
        mock.run(args)
    })
    .expect("fork resolution should succeed");

    assert_eq!(result.source, PrBaseSource::PullRef);
    assert_eq!(result.base_ref, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    // Head branch is still surfaced as a label hint even for fork PRs.
    assert_eq!(result.branch_name_override.as_deref(), Some("forkbranch"));

    let calls = mock.calls();
    assert_eq!(calls[0], vec!["fetch", "--no-tags", "origin", "forkbranch"]);
    assert_eq!(
        calls[1],
        vec!["fetch", "--no-tags", "origin", "refs/pull/7/head"]
    );
    assert_eq!(calls[2], vec!["rev-parse", "--verify", "FETCH_HEAD"]);
}

#[test]
fn uses_pull_ref_directly_when_head_branch_unknown() {
    let mock = MockGit::new(vec![
        ok(""),                                           // fetch refs/pull/99/head
        ok("cccccccccccccccccccccccccccccccccccccccc\n"), // rev-parse FETCH_HEAD
    ]);

    let result = resolve_pr_base_with("origin", 99, None, None, |args| mock.run(args))
        .expect("resolution should succeed");

    assert_eq!(result.source, PrBaseSource::PullRef);
    assert_eq!(result.branch_name_override, None);
    assert_eq!(result.compare_base_ref, None);

    let calls = mock.calls();
    // No branch fetch attempted — straight to the pull ref.
    assert_eq!(
        calls[0],
        vec!["fetch", "--no-tags", "origin", "refs/pull/99/head"]
    );
}

#[test]
fn surfaces_non_missing_ref_fetch_failure_without_fallback() {
    let mock = MockGit::new(vec![fail(
        "fatal: Authentication failed for 'https://github.com/acme/app.git/'",
    )]);

    let err = resolve_pr_base_with("origin", 3, Some("feature/x"), None, |args| mock.run(args))
        .expect_err("auth failure must surface, not fall back to pull ref");

    assert!(err.contains("Authentication failed"), "got: {err}");
    // Only the branch fetch ran — the fallback must not fire on a hard error.
    assert_eq!(mock.calls().len(), 1);
}

#[test]
fn errors_when_pull_ref_fetch_fails() {
    let mock = MockGit::new(vec![fail(
        "fatal: couldn't find remote ref refs/pull/500/head",
    )]);

    let err = resolve_pr_base_with("origin", 500, None, None, |args| mock.run(args))
        .expect_err("a failed pull-ref fetch must error");

    assert!(err.contains("refs/pull/500/head"), "got: {err}");
}

#[test]
fn errors_when_rev_parse_returns_empty() {
    let mock = MockGit::new(vec![
        ok(""), // fetch succeeds
        ok(""), // rev-parse returns empty stdout
    ]);

    let err = resolve_pr_base_with("origin", 1, Some("feature/x"), None, |args| mock.run(args))
        .expect_err("empty rev-parse output must error");

    assert!(err.contains("empty"), "got: {err}");
}

#[test]
fn blank_head_branch_is_treated_as_unknown() {
    let mock = MockGit::new(vec![
        ok(""),                                           // fetch refs/pull/8/head
        ok("dddddddddddddddddddddddddddddddddddddddd\n"), // rev-parse
    ]);

    let result = resolve_pr_base_with("origin", 8, Some("   "), None, |args| mock.run(args))
        .expect("blank head branch should skip branch fetch");

    assert_eq!(result.source, PrBaseSource::PullRef);
    assert_eq!(
        mock.calls()[0],
        vec!["fetch", "--no-tags", "origin", "refs/pull/8/head"]
    );
}
