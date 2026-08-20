use crate::commands::streaming::detect_error_type_from_output;
use git::util::is_transient_error;

// ============================================
// detect_error_type_from_output — push
// ============================================

#[test]
fn push_non_fast_forward() {
    assert_eq!(
        detect_error_type_from_output("! [rejected] main -> main (non-fast-forward)", "push"),
        "non_fast_forward"
    );
    assert_eq!(
        detect_error_type_from_output("error: failed to push some refs to 'origin'", "push"),
        "non_fast_forward"
    );
    assert_eq!(
        detect_error_type_from_output(
            "hint: Updates were rejected because the tip of your current branch is behind",
            "push"
        ),
        "non_fast_forward"
    );
}

#[test]
fn push_protected_branch() {
    assert_eq!(
        detect_error_type_from_output(
            "remote: error: GH006: Protected branch update failed",
            "push"
        ),
        "protected_branch"
    );
    assert_eq!(
        detect_error_type_from_output(
            "! [remote rejected] main -> main (pre-receive hook declined)",
            "push"
        ),
        "protected_branch"
    );
}

// ============================================
// detect_error_type_from_output — pull
// ============================================

#[test]
fn pull_uncommitted_changes() {
    assert_eq!(
        detect_error_type_from_output(
            "error: Your local changes to the following files would be overwritten by merge",
            "pull"
        ),
        "uncommitted_changes"
    );
    assert_eq!(
        detect_error_type_from_output(
            "Please commit your changes or stash them before you merge.",
            "pull"
        ),
        "uncommitted_changes"
    );
}

#[test]
fn pull_merge_conflicts() {
    assert_eq!(
        detect_error_type_from_output(
            "CONFLICT (content): Merge conflict in src/main.rs\nAutomatic merge failed",
            "pull"
        ),
        "merge_conflicts"
    );
}

// ============================================
// detect_error_type_from_output — fetch
// ============================================

#[test]
fn fetch_deleted_branch() {
    assert_eq!(
        detect_error_type_from_output(" - [deleted]         origin/old-branch", "fetch"),
        "remote_branch_deleted"
    );
}

// ============================================
// detect_error_type_from_output — common errors
// ============================================

#[test]
fn authentication_failed_common() {
    for op in &["push", "pull", "fetch"] {
        assert_eq!(
            detect_error_type_from_output(
                "fatal: Authentication failed for 'https://github.com/...'",
                op
            ),
            "authentication_failed"
        );
    }
}

#[test]
fn bad_credentials_common() {
    for op in &["push", "pull", "fetch"] {
        assert_eq!(
            detect_error_type_from_output("remote: Invalid username or token.", op),
            "authentication_failed"
        );
        assert_eq!(
            detect_error_type_from_output("HTTP Basic: Access denied", op),
            "authentication_failed"
        );
    }
}

#[test]
fn network_error_common() {
    for op in &["push", "pull", "fetch"] {
        assert_eq!(
            detect_error_type_from_output("fatal: unable to access 'https://github.com/...': Could not resolve host: github.com", op),
            "network_error"
        );
        assert_eq!(
            detect_error_type_from_output("Connection timed out", op),
            "network_error"
        );
    }
}

#[test]
fn unknown_error_for_unrecognized_message() {
    assert_eq!(
        detect_error_type_from_output("some random error", "push"),
        "unknown"
    );
    assert_eq!(detect_error_type_from_output("", "pull"), "unknown");
}

// ============================================
// is_transient_error
// ============================================

#[test]
fn transient_bad_file_descriptor() {
    assert!(is_transient_error("Bad file descriptor (os error 9)"));
}

#[test]
fn transient_resource_temporarily_unavailable() {
    assert!(is_transient_error("Resource temporarily unavailable"));
}

#[test]
fn transient_too_many_open_files() {
    assert!(is_transient_error("Too many open files (os error 24)"));
}

#[test]
fn non_transient_error() {
    assert!(!is_transient_error("Permission denied"));
    assert!(!is_transient_error("No such file or directory"));
    assert!(!is_transient_error(""));
}
