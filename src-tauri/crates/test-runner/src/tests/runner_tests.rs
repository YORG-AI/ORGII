//! Lifecycle tests for the command-execution core of the runner:
//! concurrent bounded capture, cancellation, and process-tree termination.
//!
//! Shell-based cases are Unix-only; the capture/cancellation logic they
//! exercise is platform-independent (only the kill mechanics differ).

use super::*;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn no_cancel() -> CancellationToken {
    CancellationToken::new()
}

#[cfg(unix)]
fn sh_args(script: &str) -> Vec<String> {
    vec!["-c".to_string(), script.to_string()]
}

/// A process is (still) alive when `kill(pid, 0)` succeeds.
#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 performs error checking only; it never signals.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(unix)]
#[tokio::test]
async fn completed_run_captures_status_and_both_streams() {
    let dir = std::env::temp_dir();
    let capture = tokio::time::timeout(
        Duration::from_secs(10),
        run_command_capture(
            "sh",
            &sh_args("echo out-line; echo err-line >&2; exit 3"),
            &dir,
            &no_cancel(),
            MAX_CAPTURED_STREAM_BYTES,
        ),
    )
    .await
    .expect("run must not hang")
    .expect("run must succeed");

    assert!(!capture.cancelled);
    assert_eq!(capture.status.and_then(|s| s.code()), Some(3));
    assert!(capture.stdout.text.contains("out-line"));
    assert!(capture.stderr.text.contains("err-line"));
    assert!(!capture.stdout.truncated);
    assert!(!capture.stderr.truncated);
}

/// Regression: the old implementation read stdout to EOF before touching
/// stderr, so a child that filled the stderr pipe first deadlocked forever.
#[cfg(unix)]
#[tokio::test]
async fn large_stderr_before_stdout_does_not_deadlock_and_is_bounded() {
    let dir = std::env::temp_dir();
    // ~2 MB to stderr first (far beyond the ~64 KiB pipe buffer), then stdout.
    let script = "yes err | head -c 2000000 >&2; yes out | head -c 2000000";
    let capture = tokio::time::timeout(
        Duration::from_secs(30),
        run_command_capture("sh", &sh_args(script), &dir, &no_cancel(), 64 * 1024),
    )
    .await
    .expect("concurrent capture must not deadlock")
    .expect("run must succeed");

    assert!(!capture.cancelled);
    assert_eq!(capture.stderr.total_bytes, 2_000_000);
    assert_eq!(capture.stdout.total_bytes, 2_000_000);
    assert!(capture.stderr.truncated);
    assert!(capture.stdout.truncated);
    assert!(capture.stderr.text.len() <= 64 * 1024);
    assert!(capture.stdout.text.len() <= 64 * 1024);
}

/// Cancellation must terminate the whole process group — including a
/// grandchild the direct child spawned — and report `cancelled`.
#[cfg(unix)]
#[tokio::test]
async fn cancel_kills_process_group_including_grandchildren() {
    let dir = std::env::temp_dir();
    let cancel = CancellationToken::new();

    // The child prints its background grandchild's PID, then waits on it.
    let script = "sleep 300 & echo $!; wait $!";

    let cancel_trigger = cancel.clone();
    let trigger = tokio::spawn(async move {
        // Give the shell time to spawn and print the grandchild PID.
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel_trigger.cancel();
    });

    let started = std::time::Instant::now();
    let capture = tokio::time::timeout(
        Duration::from_secs(10),
        run_command_capture(
            "sh",
            &sh_args(script),
            &dir,
            &cancel,
            MAX_CAPTURED_STREAM_BYTES,
        ),
    )
    .await
    .expect("cancellation must resolve promptly")
    .expect("run must succeed");
    trigger.await.expect("trigger task");

    assert!(capture.cancelled, "outcome must be marked cancelled");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "cancel must not wait for the 300s sleep"
    );

    let grandchild_pid: i32 = capture
        .stdout
        .text
        .lines()
        .next()
        .expect("grandchild pid line")
        .trim()
        .parse()
        .expect("grandchild pid parses");

    // SIGKILL delivery is asynchronous; poll briefly.
    let mut alive = process_alive(grandchild_pid);
    for _ in 0..40 {
        if !alive {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        alive = process_alive(grandchild_pid);
    }
    assert!(
        !alive,
        "grandchild {grandchild_pid} must be dead after group termination"
    );
}

/// A token cancelled before the run starts must still terminate promptly.
#[cfg(unix)]
#[tokio::test]
async fn pre_cancelled_token_stops_run_immediately() {
    let dir = std::env::temp_dir();
    let cancel = CancellationToken::new();
    cancel.cancel();

    let capture = tokio::time::timeout(
        Duration::from_secs(10),
        run_command_capture(
            "sh",
            &sh_args("sleep 300"),
            &dir,
            &cancel,
            MAX_CAPTURED_STREAM_BYTES,
        ),
    )
    .await
    .expect("pre-cancelled run must resolve promptly")
    .expect("run must succeed");

    assert!(capture.cancelled);
}

#[tokio::test]
async fn spawn_failure_surfaces_as_error() {
    let dir = std::env::temp_dir();
    let result = run_command_capture(
        "definitely-not-a-real-binary-orgii",
        &[],
        &dir,
        &no_cancel(),
        MAX_CAPTURED_STREAM_BYTES,
    )
    .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Failed to spawn test process"));
}

#[test]
fn tail_of_respects_char_boundaries() {
    assert_eq!(tail_of("hello", 10), "hello");
    assert_eq!(tail_of("hello", 3), "llo");
    // "😀" is 4 bytes; a 5-byte tail of "a😀😀" would split the first emoji,
    // so the boundary moves forward past it.
    assert_eq!(tail_of("a😀😀", 5), "😀");
    assert_eq!(tail_of("", 5), "");
}

/// Full-pipeline check of event ordering and the canonical run id: every
/// event and the returned summary must carry the id the caller minted.
#[cfg(unix)]
#[tokio::test]
async fn cancelled_run_emits_run_started_then_run_cancelled_with_same_id() {
    use std::sync::{Arc, Mutex};

    // Minimal directory satisfying the Cargo framework preconditions; the
    // run is cancelled immediately, so no real project is needed.
    let (_tempdir, root) = app_utils::testing::temp_dir_with_files(&[(
        "Cargo.toml",
        "[package]\nname = \"x\"\nversion = \"0.0.0\"\n",
    )]);
    let cancel = CancellationToken::new();
    cancel.cancel(); // cancel immediately: no dependence on real test output

    let events: Arc<Mutex<Vec<TestEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let emit = move |event: TestEvent| {
        sink_events.lock().expect("events lock").push(event);
    };

    let summary = run_tests(
        "run-under-test".to_string(),
        &root,
        TestFramework::Cargo,
        None,
        cancel,
        &emit,
    )
    .await
    .expect("cancelled run still returns a summary");

    assert_eq!(summary.run_id, "run-under-test");
    assert!(summary.cancelled);

    let events = events.lock().expect("events lock");
    match events.first() {
        Some(TestEvent::RunStarted { run_id, .. }) => assert_eq!(run_id, "run-under-test"),
        other => panic!("first event must be RunStarted, got {other:?}"),
    }
    match events.last() {
        Some(TestEvent::RunCancelled { run_id }) => assert_eq!(run_id, "run-under-test"),
        other => panic!("last event must be RunCancelled, got {other:?}"),
    }
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, TestEvent::RunFinished { .. })),
        "a cancelled run must not also report RunFinished"
    );
}
