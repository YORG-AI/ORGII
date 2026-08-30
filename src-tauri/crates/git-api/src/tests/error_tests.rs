use axum::http::StatusCode;

use crate::error::GitApiError;

#[test]
fn test_error_status_codes() {
    assert_eq!(
        GitApiError::RepoNotFound {
            repo_id: "test".into()
        }
        .status_code(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        GitApiError::PathTraversal {
            path: "../etc/passwd".into()
        }
        .status_code(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        GitApiError::MergeConflict {
            message: "conflict".into(),
            files: vec![]
        }
        .status_code(),
        StatusCode::CONFLICT
    );
}

#[test]
fn test_from_git_error() {
    let err = GitApiError::from_git_error("nothing to commit, working tree clean");
    assert!(matches!(err, GitApiError::NothingToCommit));

    let err = GitApiError::from_git_error("Authentication failed for 'https://...'");
    assert!(matches!(err, GitApiError::AuthenticationFailed { .. }));
}

/// Regression: git appends "error: failed to push some refs" to every push
/// rejection, and every policy rejection also contains "rejected" — so the
/// protected-branch patterns must be tested before the broad "rejected"
/// match, or a policy rejection maps to NonFastForward and the UI tells the
/// user to pull.
#[test]
fn test_from_git_error_policy_rejection_before_non_fast_forward() {
    let err = GitApiError::from_git_error(
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\n \
         ! [remote rejected] main -> main (protected branch hook declined)\n\
         error: failed to push some refs to 'https://github.com/acme/app.git'",
    );
    assert!(matches!(err, GitApiError::ProtectedBranch { .. }));
    assert_eq!(err.error_type(), "protected_branch");
    assert_eq!(err.status_code(), StatusCode::CONFLICT);

    let err = GitApiError::from_git_error(
        " ! [rejected]        main -> main (fetch first)\n\
         error: failed to push some refs to 'https://github.com/acme/app.git'",
    );
    assert!(matches!(err, GitApiError::NonFastForward { .. }));
}
