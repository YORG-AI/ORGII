use crate::commands::remote::{
    contains_word, detect_fetch_error_type, detect_pull_error_type, detect_push_error_type,
    pull_from_remote, pull_strategy_args, should_set_upstream,
};
use crate::types::GitErrorType;

#[test]
fn list_remotes_uses_repository_metadata_without_git_cli() {
    let repo_path = std::env::temp_dir().join(format!(
        "orgii-list-remotes-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&repo_path);

    {
        let repository = git2::Repository::init(&repo_path).expect("initialize test repository");
        repository
            .remote("origin", "git@github.com:org2ai/ORGII.git")
            .expect("add origin");
        let mut config = repository.config().expect("open repository config");
        config
            .set_str(
                "remote.origin.pushurl",
                "https://github.com/org2ai/ORGII.git",
            )
            .expect("set push URL");
    }
    let nested_path = repo_path.join("src-tauri/crates/example");
    std::fs::create_dir_all(&nested_path).expect("create nested workspace");

    let remotes = crate::commands::remote::list_remotes(&nested_path).expect("list remotes");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(
        remotes[0].fetch_url.as_deref(),
        Some("git@github.com:org2ai/ORGII.git")
    );
    assert_eq!(
        remotes[0].push_url.as_deref(),
        Some("https://github.com/org2ai/ORGII.git")
    );

    let _ = std::fs::remove_dir_all(&repo_path);
}

// ============================================
// detect_push_error_type
// ============================================

#[test]
fn push_error_non_fast_forward() {
    assert_eq!(
        detect_push_error_type("! [rejected] main -> main (non-fast-forward)"),
        GitErrorType::NonFastForward,
    );
}

#[test]
fn push_error_fetch_first() {
    assert_eq!(
        detect_push_error_type("hint: fetch first"),
        GitErrorType::NonFastForward,
    );
}

#[test]
fn push_error_updates_rejected() {
    // "Updates were rejected" is a client-side hint line; git pairs it with
    // "! [rejected]", never with the server-side "! [remote rejected]"
    // marker (that one is a policy rejection and classifies as
    // ProtectedBranch — see push_classification tests below).
    assert_eq!(
        detect_push_error_type(
            "hint: Updates were rejected because the tip of your current branch is behind"
        ),
        GitErrorType::NonFastForward,
    );
}

#[test]
fn push_error_protected_branch() {
    assert_eq!(
        detect_push_error_type("remote: error: Protected branch update failed for refs/heads/main"),
        GitErrorType::ProtectedBranch,
    );
}

#[test]
fn push_error_pre_receive_hook() {
    assert_eq!(
        detect_push_error_type("remote: error: pre-receive hook declined"),
        GitErrorType::ProtectedBranch,
    );
}

#[test]
fn push_error_remote_rejected() {
    assert_eq!(
        detect_push_error_type("! [remote rejected] main -> main (cannot push to)"),
        GitErrorType::ProtectedBranch,
    );
}

#[test]
fn push_error_auth_failed() {
    assert_eq!(
        detect_push_error_type("fatal: Authentication failed for 'https://github.com'"),
        GitErrorType::AuthenticationFailed,
    );
}

#[test]
fn push_error_permission_denied() {
    assert_eq!(
        detect_push_error_type("Permission denied (publickey)."),
        GitErrorType::AuthenticationFailed,
    );
}

#[test]
fn push_error_bad_credentials() {
    assert_eq!(
        detect_push_error_type("remote: Invalid username or token."),
        GitErrorType::AuthenticationFailed,
    );
    assert_eq!(
        detect_push_error_type("HTTP Basic: Access denied"),
        GitErrorType::AuthenticationFailed,
    );
}

#[test]
fn push_error_network() {
    assert_eq!(
        detect_push_error_type("fatal: unable to access 'https://...': Could not resolve host"),
        GitErrorType::NetworkError,
    );
}

#[test]
fn push_error_connection_refused() {
    assert_eq!(
        detect_push_error_type("fatal: Connection refused"),
        GitErrorType::NetworkError,
    );
}

#[test]
fn push_error_connection_timed_out() {
    assert_eq!(
        detect_push_error_type("Connection timed out"),
        GitErrorType::NetworkError,
    );
}

#[test]
fn push_error_unknown() {
    assert_eq!(
        detect_push_error_type("some other error"),
        GitErrorType::Unknown,
    );
}

// ============================================
// should_set_upstream
// ============================================

#[test]
fn set_upstream_when_none_configured() {
    assert!(should_set_upstream(None, "feat/x", "origin"));
}

/// Regression: the old comparison used only the last `/`-segment of the
/// upstream ref, so "origin/feat/x" shortened to "x", never equalled
/// "feat/x", and every slash-named branch re-set its upstream on every push.
#[test]
fn no_set_upstream_when_upstream_matches_slash_branch() {
    assert!(!should_set_upstream(
        Some("origin/feat/x"),
        "feat/x",
        "origin"
    ));
    assert!(!should_set_upstream(
        Some("origin/feat/org2-cloud-auth"),
        "feat/org2-cloud-auth",
        "origin"
    ));
    assert!(!should_set_upstream(Some("origin/main"), "main", "origin"));
}

#[test]
fn set_upstream_for_renamed_branch_on_same_remote() {
    assert!(should_set_upstream(Some("origin/main"), "feat/x", "origin"));
}

/// An upstream deliberately configured on a different remote must be left
/// alone — `-u` would silently overwrite it.
#[test]
fn no_set_upstream_when_upstream_is_on_another_remote() {
    assert!(!should_set_upstream(
        Some("upstream/feat/x"),
        "feat/x",
        "origin"
    ));
    assert!(!should_set_upstream(
        Some("upstream/main"),
        "main",
        "origin"
    ));
}

// ============================================
// pull_strategy_args
// ============================================

/// Regression: a bare `git pull --rebase` refuses to start whenever the
/// working tree is dirty at all ("cannot pull with rebase: You have unstaged
/// changes"), even when nothing overlaps the incoming commits. `--autostash`
/// must always accompany `--rebase`.
#[test]
fn pull_strategy_rebase_always_autostashes() {
    assert_eq!(
        pull_strategy_args(Some("rebase")),
        &["--rebase", "--autostash"]
    );
}

#[test]
fn pull_strategy_merge_and_ff_only_do_not_autostash() {
    // Merge and fast-forward pulls natively tolerate non-overlapping local
    // changes and must keep refusing on genuine overlap.
    assert_eq!(pull_strategy_args(Some("merge")), &["--no-rebase"]);
    assert_eq!(pull_strategy_args(None), &["--no-rebase"]);
    assert_eq!(pull_strategy_args(Some("unknown")), &["--no-rebase"]);
    assert_eq!(pull_strategy_args(Some("ff-only")), &["--ff-only"]);
}

// ============================================
// detect_pull_error_type
// ============================================

#[test]
fn pull_error_uncommitted_changes() {
    let (err_type, _files) = detect_pull_error_type(
        "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/main.rs\nPlease commit your changes"
    );
    assert_eq!(err_type, GitErrorType::UncommittedChanges);
}

#[test]
fn pull_error_extracts_affected_files() {
    // Git indents the blocking files with a tab character, one per line.
    let msg = "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/main.rs\n\tsrc/lib.rs\nPlease commit your changes or stash them before you merge.";
    let (err_type, files) = detect_pull_error_type(msg);
    assert_eq!(err_type, GitErrorType::UncommittedChanges);
    assert_eq!(
        files,
        Some(vec!["src/main.rs".to_string(), "src/lib.rs".to_string()])
    );
}

#[test]
fn pull_error_extracts_affected_files_with_spaces() {
    let msg = "error: Your local changes to the following files would be overwritten by merge:\n\tdocs/release notes.md\nPlease commit your changes or stash them before you merge.";
    let (_, files) = detect_pull_error_type(msg);
    assert_eq!(files, Some(vec!["docs/release notes.md".to_string()]));
}

#[test]
fn pull_error_merge_conflicts() {
    let (err_type, _) = detect_pull_error_type(
        "CONFLICT (content): Merge conflict in file.txt\nAutomatic merge failed",
    );
    assert_eq!(err_type, GitErrorType::MergeConflicts);
}

#[test]
fn pull_error_auth() {
    let (err_type, _) =
        detect_pull_error_type("fatal: Authentication failed for 'https://github.com'");
    assert_eq!(err_type, GitErrorType::AuthenticationFailed);
}

#[test]
fn pull_error_bad_credentials() {
    let (err_type, _) = detect_pull_error_type("remote: Invalid username or token.");
    assert_eq!(err_type, GitErrorType::AuthenticationFailed);
}

// ============================================
// Regression tests with full, untruncated git output. Git appends
// "error: failed to push some refs to <url>" to EVERY push rejection, so a
// classifier that tests the non-fast-forward patterns first can never reach
// the protected-branch arm on real output — truncated fixtures hide that.
// ============================================

#[test]
fn push_error_protected_branch_full_real_output() {
    let msg = "remote: error: GH006: Protected branch update failed for refs/heads/main.\n\
               remote: error: Changes must be made through a pull request.\n\
                ! [remote rejected] main -> main (protected branch hook declined)\n\
               error: failed to push some refs to 'https://github.com/acme/app.git'";
    assert_eq!(detect_push_error_type(msg), GitErrorType::ProtectedBranch);
}

#[test]
fn push_error_pre_receive_hook_full_real_output() {
    let msg = "remote: GitLab: You are not allowed to push code to this project.\n\
                ! [remote rejected] main -> main (pre-receive hook declined)\n\
               error: failed to push some refs to 'https://gitlab.com/acme/app.git'";
    assert_eq!(detect_push_error_type(msg), GitErrorType::ProtectedBranch);
}

#[test]
fn push_error_plain_non_fast_forward_full_real_output() {
    // A plain non-fast-forward rejection carries none of the policy markers
    // and must still classify as NonFastForward after the reorder.
    let msg = " ! [rejected]        main -> main (fetch first)\n\
               error: failed to push some refs to 'https://github.com/acme/app.git'\n\
               hint: Updates were rejected because the remote contains work that you do not\n\
               hint: have locally. This is usually caused by another repository pushing to\n\
               hint: the same ref. If you want to integrate the remote changes, use\n\
               hint: 'git pull' before pushing again.";
    assert_eq!(detect_push_error_type(msg), GitErrorType::NonFastForward);
}

/// Regression: the extraction loop used to call `line.trim()` and then test
/// `starts_with('\t')` on the trimmed string — unconditionally false, so the
/// uncommitted-changes dialog could never list the blocking files.
#[test]
fn pull_error_affected_files_extracted_from_real_tabbed_output() {
    let msg = "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/main.rs\n\tsrc/lib.rs\nPlease commit your changes or stash them before you merge.";
    let (err_type, files) = detect_pull_error_type(msg);
    assert_eq!(err_type, GitErrorType::UncommittedChanges);
    assert_eq!(
        files,
        Some(vec!["src/main.rs".to_string(), "src/lib.rs".to_string()])
    );
}

/// Regression: the auth arm used to match the bare substring "sso", which
/// hides inside ordinary words ("processor", "associate", "lasso") in the
/// URLs and paths git embeds in its output — and the auth arm runs before the
/// network arm, so a plain DNS failure prompted for credentials.
#[test]
fn pull_error_dns_failure_on_sso_containing_repo_name_is_network() {
    let (err_type, _) = detect_pull_error_type(
        "fatal: unable to access 'https://github.com/acme/processor-service.git/': Could not resolve host: github.com",
    );
    assert_eq!(err_type, GitErrorType::NetworkError);
}

#[test]
fn pull_error_real_saml_enforcement_is_auth() {
    // Standalone "SSO"/"SAML" words (real GitHub SAML enforcement output)
    // must still classify as an auth failure after the word-boundary fix.
    let (err_type, _) = detect_pull_error_type(
        "remote: The `acme' organization has enabled or enforced SAML SSO. To access\nremote: this repository, visit https://github.com/orgs/acme/sso\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
    );
    assert_eq!(err_type, GitErrorType::AuthenticationFailed);
}

#[test]
fn pull_error_connection_timed_out_is_network() {
    let (err_type, _) = detect_pull_error_type(
        "fatal: unable to access 'https://github.com/acme/app.git/': Failed to connect to github.com port 443 after 21038 ms: Connection timed out",
    );
    assert_eq!(err_type, GitErrorType::NetworkError);
}

// ============================================
// contains_word
// ============================================

#[test]
fn contains_word_matches_standalone_tokens_only() {
    assert!(contains_word("enforced saml sso.", "sso"));
    assert!(contains_word("sso required", "sso"));
    assert!(contains_word(
        "visit https://github.com/orgs/acme/sso",
        "sso"
    ));
    assert!(!contains_word("processor-service", "sso"));
    assert!(!contains_word("refs/heads/associate-api", "sso"));
    assert!(!contains_word("missouri", "sso"));
    assert!(!contains_word("lassos", "sso"));
}

// ============================================
// pull_from_remote — integration against real repositories.
//
// pull_from_remote shells out to git, and its defects historically lived in
// exactly the gap unit fixtures cannot cover: which stream carries which
// message. These scenarios run the real binary against throwaway repos.
// ============================================

#[test]
fn pull_from_remote_reports_real_pull_outcomes() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipping: git executable not available");
        return;
    }

    let base = std::env::temp_dir().join(format!(
        "orgii-pull-int-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("create test root");

    fn git_in(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
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
    }
    fn append(path: &std::path::Path, text: &str) {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("open file");
        f.write_all(text.as_bytes()).expect("append");
    }

    let bare = base.join("remote.git");
    let a = base.join("a");
    let b = base.join("b");
    git_in(&base, &["init", "--bare", "remote.git"]);
    git_in(&base, &["init", "a"]);
    append(&a.join("s.txt"), "one\n");
    git_in(&a, &["add", "."]);
    git_in(&a, &["commit", "-m", "init"]);
    git_in(
        &a,
        &["remote", "add", "origin", bare.to_str().expect("utf8")],
    );
    git_in(&a, &["push", "-u", "origin", "main"]);
    git_in(&base, &["clone", "remote.git", "b"]);

    // Remote moves ahead on s.txt.
    append(&b.join("s.txt"), "remote-1\n");
    git_in(&b, &["commit", "-am", "remote edit 1"]);
    git_in(&b, &["push"]);

    // Scenario 1: dirty overlapping file, merge pull. Git refuses on stderr
    // with a tab-indented file list; the result must classify it and name the
    // file.
    append(&a.join("s.txt"), "local-dirty\n");
    let refused = pull_from_remote(
        &a,
        Some("origin"),
        Some("main"),
        Some("merge"),
        None,
        None,
        false,
    )
    .expect("pull runs");
    assert!(!refused.success, "overlap merge pull must fail");
    assert_eq!(refused.error_type, GitErrorType::UncommittedChanges);
    assert_eq!(refused.affected_files, Some(vec!["s.txt".to_string()]));

    // Scenario 2: same dirty state, rebase pull. The pull itself succeeds;
    // git reapplies the autostash as conflict markers and warns on STDERR —
    // the result must still surface the conflicted file.
    let autostash = pull_from_remote(
        &a,
        Some("origin"),
        Some("main"),
        Some("rebase"),
        None,
        None,
        false,
    )
    .expect("pull runs");
    assert!(autostash.success, "autostash pull exits 0");
    assert!(
        autostash.message.to_lowercase().contains("autostash"),
        "stderr autostash warning must be in the message: {}",
        autostash.message
    );
    let conflicted = autostash.conflicts.expect("conflicts listed");
    assert_eq!(conflicted, vec!["s.txt".to_string()]);
    git_in(&a, &["reset", "--hard", "origin/main"]);
    git_in(&a, &["stash", "clear"]);

    // Scenario 3: committed divergence on both sides, merge pull. The merge
    // machinery prints "CONFLICT" on STDOUT while the exit code is non-zero;
    // the result must not lose it by reading stderr alone.
    append(&b.join("s.txt"), "remote-2\n");
    git_in(&b, &["commit", "-am", "remote edit 2"]);
    git_in(&b, &["push"]);
    append(&a.join("s.txt"), "local-committed\n");
    git_in(&a, &["commit", "-am", "local edit"]);
    let conflicted = pull_from_remote(
        &a,
        Some("origin"),
        Some("main"),
        Some("merge"),
        None,
        None,
        false,
    )
    .expect("pull runs");
    assert!(!conflicted.success, "conflicting merge pull must fail");
    assert_eq!(conflicted.error_type, GitErrorType::MergeConflicts);
    assert!(
        conflicted.message.contains("CONFLICT"),
        "stdout CONFLICT line must be in the message: {}",
        conflicted.message
    );
    assert_eq!(conflicted.conflicts, Some(vec!["s.txt".to_string()]));

    let _ = std::fs::remove_dir_all(&base);
}

// ============================================
// detect_fetch_error_type
// ============================================

#[test]
fn fetch_error_auth() {
    let err_type = detect_fetch_error_type("fatal: Authentication failed for 'https://...'");
    assert_eq!(err_type, GitErrorType::AuthenticationFailed);
}

#[test]
fn fetch_error_network() {
    let err_type = detect_fetch_error_type("fatal: Could not resolve host: github.com");
    assert_eq!(err_type, GitErrorType::NetworkError);
}

#[test]
fn fetch_error_unknown() {
    let err_type = detect_fetch_error_type("everything is fine");
    assert_eq!(err_type, GitErrorType::Unknown);
}
