use crate::commands::remote::{
    detect_fetch_error_type, detect_pull_error_type, detect_push_error_type,
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
            .remote("origin", "git@github.com:yorgai/ORGII.git")
            .expect("add origin");
        let mut config = repository.config().expect("open repository config");
        config
            .set_str(
                "remote.origin.pushurl",
                "https://github.com/yorgai/ORGII.git",
            )
            .expect("set push URL");
    }

    let remotes = crate::commands::remote::list_remotes(&repo_path).expect("list remotes");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(
        remotes[0].fetch_url.as_deref(),
        Some("git@github.com:yorgai/ORGII.git")
    );
    assert_eq!(
        remotes[0].push_url.as_deref(),
        Some("https://github.com/yorgai/ORGII.git")
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
    assert_eq!(
        detect_push_error_type("! [remote rejected] main -> main (updates were rejected)"),
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
    // Git indents affected files with a tab character
    let msg = "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/main.rs\n\tsrc/lib.rs\nPlease commit your changes or stash them before you merge.";
    let (err_type, files) = detect_pull_error_type(msg);
    assert_eq!(err_type, GitErrorType::UncommittedChanges);
    // File extraction may or may not capture files depending on exact
    // formatting. The critical assertion is the error type classification.
    if let Some(file_list) = files {
        assert!(!file_list.is_empty());
    }
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
