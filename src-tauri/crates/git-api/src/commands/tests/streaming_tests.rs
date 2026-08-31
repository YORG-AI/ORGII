use crate::commands::streaming::{detect_error_type_from_output, stream_git_events};
use git::util::is_transient_error;

#[cfg(unix)]
async fn collect_events(
    script: &str,
    operation: &'static str,
) -> Vec<(&'static str, serde_json::Value)> {
    use futures::StreamExt as _;

    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let stream = stream_git_events(cmd, "test command".to_string(), operation);
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        stream.collect::<Vec<_>>(),
    )
    .await
    .expect("stream must terminate — a hang here is the pipe deadlock regression")
}

/// Regression: the old implementation drained stdout to EOF before reading
/// stderr. A child that fills stderr's pipe buffer (64 KiB) while stdout is
/// still open then blocks on write(2), stdout never reaches EOF, and both
/// sides hang — reachable on any large push, whose progress goes to stderr.
#[cfg(unix)]
#[tokio::test]
async fn streams_large_stderr_without_deadlock() {
    let events = collect_events(
        // ~30k lines (>200 KiB) of stderr while stdout stays open.
        "i=0; while [ $i -lt 30000 ]; do echo stderr-noise-line 1>&2; i=$((i+1)); done; echo done-marker",
        "push",
    )
    .await;

    let end = events.last().expect("events emitted");
    assert_eq!(end.0, "end");
    assert_eq!(end.1["success"], serde_json::json!(true));
    let stdout_lines: Vec<_> = events
        .iter()
        .filter(|(kind, data)| *kind == "output" && data["stream"] == "stdout")
        .collect();
    assert_eq!(stdout_lines.len(), 1);
    assert_eq!(stdout_lines[0].1["line"], "done-marker");
    let stderr_count = events
        .iter()
        .filter(|(kind, data)| *kind == "output" && data["stream"] == "stderr")
        .count();
    assert_eq!(stderr_count, 30000);
}

/// Regression: hand-rolled JSON escaping only handled `"` and `\n`, so
/// backslashes (Windows paths, quoted-path octal escapes) produced invalid
/// frames the client dropped. The payload must carry the line verbatim.
#[cfg(unix)]
#[tokio::test]
async fn output_lines_with_backslashes_and_quotes_survive_verbatim() {
    let events = collect_events(r#"printf 'C:\\Users\\dev "quoted" path\n'"#, "pull").await;

    let line = events
        .iter()
        .find(|(kind, _)| *kind == "output")
        .expect("one output event")
        .1["line"]
        .as_str()
        .expect("line is a string");
    assert_eq!(line, r#"C:\Users\dev "quoted" path"#);
}

#[cfg(unix)]
#[tokio::test]
async fn end_event_classifies_failure_from_combined_output() {
    let events = collect_events(
        "echo 'error: failed to push some refs to x' 1>&2; exit 1",
        "push",
    )
    .await;

    assert_eq!(events.first().expect("start emitted").0, "start");
    let end = events.last().expect("end emitted");
    assert_eq!(end.0, "end");
    assert_eq!(end.1["success"], serde_json::json!(false));
    assert_eq!(end.1["error_type"], "non_fast_forward");
}

/// A missing binary must terminate the stream with a failure. On Unix the
/// fd-closing `pre_exec` also closes the runtime's exec-error pipe, so the
/// failed exec surfaces as an immediate child exit (an `end` event with
/// `success: false`) rather than a spawn error — either terminal event is a
/// correct failure signal; what must never happen is a hang or a success.
#[tokio::test]
async fn missing_binary_terminates_with_failure() {
    use futures::StreamExt as _;

    let mut cmd = tokio::process::Command::new("/nonexistent-binary-orgii-test");
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let events = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        stream_git_events(cmd, "test command".to_string(), "push").collect::<Vec<_>>(),
    )
    .await
    .expect("stream must terminate");

    let last = events.last().expect("events emitted");
    match last.0 {
        "end" => assert_eq!(last.1["success"], serde_json::json!(false)),
        "error" => assert_eq!(last.1["error_type"], "unknown"),
        other => panic!("unexpected terminal event {other}: {:?}", last.1),
    }
}

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

/// Regression: real rejections always end with "error: failed to push some
/// refs", which the non-fast-forward arm matches — protected-branch must win
/// on full output, and a plain rejection must still be non-fast-forward.
#[test]
fn push_classification_on_full_real_output() {
    assert_eq!(
        detect_error_type_from_output(
            "remote: error: GH006: Protected branch update failed for refs/heads/main.\n \
             ! [remote rejected] main -> main (protected branch hook declined)\n\
             error: failed to push some refs to 'https://github.com/acme/app.git'",
            "push"
        ),
        "protected_branch"
    );
    assert_eq!(
        detect_error_type_from_output(
            " ! [rejected]        main -> main (fetch first)\n\
             error: failed to push some refs to 'https://github.com/acme/app.git'\n\
             hint: Updates were rejected because the remote contains work that you do not\n\
             hint: have locally.",
            "push"
        ),
        "non_fast_forward"
    );
}

/// Regression: the auth arm used to match the bare substring "sso" — which
/// hides inside "processor", "associate", etc. — ahead of the network arm.
#[test]
fn dns_failure_on_sso_containing_repo_name_is_network() {
    assert_eq!(
        detect_error_type_from_output(
            "fatal: unable to access 'https://github.com/acme/processor-service.git/': Could not resolve host: github.com",
            "fetch"
        ),
        "network_error"
    );
    assert_eq!(
        detect_error_type_from_output(
            "remote: The `acme' organization has enabled or enforced SAML SSO.",
            "fetch"
        ),
        "authentication_failed"
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
