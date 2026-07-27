// Additional tests for GitApiError::from_git_error patterns and error_type()
// that are not covered by the existing error_tests.rs.

use crate::error::GitApiError;
use axum::http::StatusCode;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// from_git_error — additional pattern recognition
// ---------------------------------------------------------------------------

#[test]
fn from_git_error_not_a_git_repo() {
    let err = GitApiError::from_git_error(
        "fatal: not a git repository (or any parent up to mount point /)",
    );
    assert!(
        matches!(err, GitApiError::NotAGitRepo { .. }),
        "Expected NotAGitRepo, got {:?}",
        err
    );
}

#[test]
fn from_git_error_not_a_git_repo_is_case_insensitive() {
    let err = GitApiError::from_git_error(
        "Not a git repository at /Users/me/repo/.claude/worktrees/deleted-agent",
    );
    assert!(
        matches!(&err, GitApiError::NotAGitRepo { .. }),
        "Expected NotAGitRepo, got {:?}",
        err
    );
    assert_eq!(err.status_code(), StatusCode::NOT_FOUND);
}

#[test]
fn from_git_error_non_fast_forward_rejected() {
    let err = GitApiError::from_git_error("error: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not have locally.");
    // "rejected" keyword triggers NonFastForward
    assert!(
        matches!(err, GitApiError::NonFastForward { .. }),
        "Expected NonFastForward, got {:?}",
        err
    );
}

#[test]
fn from_git_error_could_not_read_username() {
    let err =
        GitApiError::from_git_error("remote: could not read Username for 'https://github.com'");
    assert!(
        matches!(err, GitApiError::AuthenticationFailed { .. }),
        "Expected AuthenticationFailed, got {:?}",
        err
    );
}

#[test]
fn from_git_error_connection_refused() {
    let err = GitApiError::from_git_error("fatal: Connection refused");
    assert!(
        matches!(err, GitApiError::NetworkError { .. }),
        "Expected NetworkError, got {:?}",
        err
    );
}

#[test]
fn from_git_error_could_not_resolve_host() {
    let err = GitApiError::from_git_error("fatal: Could not resolve host: github.example.internal");
    assert!(
        matches!(err, GitApiError::NetworkError { .. }),
        "Expected NetworkError, got {:?}",
        err
    );
}

#[test]
fn from_git_error_fallback_to_git_operation() {
    let err = GitApiError::from_git_error("some completely unrecognised git output");
    assert!(
        matches!(err, GitApiError::GitOperation { .. }),
        "Expected GitOperation fallback, got {:?}",
        err
    );
}

// ---------------------------------------------------------------------------
// error_type() — verify each variant returns a stable slug
// ---------------------------------------------------------------------------

#[test]
fn error_type_is_stable_for_all_variants() {
    let cases: Vec<(GitApiError, &str)> = vec![
        (
            GitApiError::RepoNotFound {
                repo_id: "r".into(),
            },
            "repo_not_found",
        ),
        (
            GitApiError::RepoPathNotFound {
                path: PathBuf::from("/x"),
            },
            "repo_path_not_found",
        ),
        (
            GitApiError::NotAGitRepo {
                path: PathBuf::from("/x"),
            },
            "not_a_git_repo",
        ),
        (
            GitApiError::WatchManagerNotInitialized,
            "watch_manager_not_initialized",
        ),
        (
            GitApiError::InvalidPath {
                path: "p".into(),
                reason: "r".into(),
            },
            "invalid_path",
        ),
        (
            GitApiError::PathTraversal {
                path: "../x".into(),
            },
            "path_traversal",
        ),
        (
            GitApiError::PathNotAllowed {
                path: "/etc".into(),
            },
            "path_not_allowed",
        ),
        (
            GitApiError::GitOperation {
                message: "m".into(),
            },
            "git_operation_failed",
        ),
        (
            GitApiError::BranchNotFound { branch: "b".into() },
            "branch_not_found",
        ),
        (
            GitApiError::CommitNotFound { sha: "abc".into() },
            "commit_not_found",
        ),
        (
            GitApiError::FileNotFoundAtRef {
                file_path: "f".into(),
                git_ref: "HEAD".into(),
            },
            "file_not_found",
        ),
        (
            GitApiError::MergeConflict {
                message: "m".into(),
                files: vec![],
            },
            "merge_conflict",
        ),
        (GitApiError::NothingToCommit, "nothing_to_commit"),
        (
            GitApiError::UncommittedChanges { files: vec![] },
            "uncommitted_changes",
        ),
        (
            GitApiError::RemoteNotFound {
                remote: "origin".into(),
            },
            "remote_not_found",
        ),
        (
            GitApiError::AuthenticationFailed {
                remote: "origin".into(),
            },
            "authentication_failed",
        ),
        (
            GitApiError::NonFastForward {
                message: "m".into(),
            },
            "non_fast_forward",
        ),
        (
            GitApiError::NetworkError {
                message: "m".into(),
            },
            "network_error",
        ),
        (
            GitApiError::InvalidRequest {
                message: "m".into(),
            },
            "invalid_request",
        ),
        (
            GitApiError::InvalidEncoding {
                message: "m".into(),
            },
            "invalid_encoding",
        ),
        (
            GitApiError::InvalidRef {
                git_ref: "bad".into(),
            },
            "invalid_ref",
        ),
        (
            GitApiError::Internal {
                message: "m".into(),
            },
            "internal_error",
        ),
        (GitApiError::Timeout, "timeout"),
    ];

    for (err, expected_type) in cases {
        assert_eq!(
            err.error_type(),
            expected_type,
            "error_type mismatch for {:?}",
            err
        );
    }
}

// ---------------------------------------------------------------------------
// status_code() — verify additional variants not in existing tests
// ---------------------------------------------------------------------------

#[test]
fn uncommitted_changes_is_conflict() {
    assert_eq!(
        GitApiError::UncommittedChanges {
            files: vec!["foo.rs".into()]
        }
        .status_code(),
        StatusCode::CONFLICT
    );
}

#[test]
fn non_fast_forward_is_conflict() {
    assert_eq!(
        GitApiError::NonFastForward {
            message: "rejected".into()
        }
        .status_code(),
        StatusCode::CONFLICT
    );
}

#[test]
fn authentication_failed_is_unauthorized() {
    assert_eq!(
        GitApiError::AuthenticationFailed {
            remote: "origin".into()
        }
        .status_code(),
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn timeout_is_service_unavailable() {
    assert_eq!(
        GitApiError::Timeout.status_code(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[test]
fn nothing_to_commit_is_bad_request() {
    assert_eq!(
        GitApiError::NothingToCommit.status_code(),
        StatusCode::BAD_REQUEST
    );
}

#[test]
fn path_not_allowed_is_forbidden() {
    assert_eq!(
        GitApiError::PathNotAllowed {
            path: "/root/.ssh".into()
        }
        .status_code(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn watch_manager_not_initialized_is_internal() {
    assert_eq!(
        GitApiError::WatchManagerNotInitialized.status_code(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
}
