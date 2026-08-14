use std::path::PathBuf;

use crate::tools::impls::coding::exec::registry::{self, JobKind, JobStatus};

#[test]
fn test_register_shell_and_get() {
    let pid = 99990;
    let tx = registry::register_shell(
        pid,
        "sleep 100".into(),
        PathBuf::from("/tmp/1.txt"),
        "s1".into(),
    );
    let handle = pid.to_string();
    assert!(registry::get_status(&handle).is_some());
    let (status, kind) = registry::get_status(&handle).unwrap();
    assert!(matches!(status, JobStatus::Running));
    assert!(matches!(kind, JobKind::Shell { .. }));

    let _ = tx.send("hello\n".into());
    assert!(registry::subscribe(&handle).is_some());

    registry::remove(&handle);
    assert!(registry::get_status(&handle).is_none());
}

#[test]
fn test_mark_exited_shell() {
    let pid = 99991;
    let _tx = registry::register_shell(pid, "ls".into(), PathBuf::from("/tmp/2.txt"), "s1".into());
    let handle = pid.to_string();
    registry::mark_exited(&handle, JobStatus::Exited(0));
    let (status, _) = registry::get_status(&handle).unwrap();
    assert!(matches!(status, JobStatus::Exited(0)));
    registry::remove(&handle);
}

#[test]
fn test_register_subagent() {
    let handle = "shadow-builtin:general-abc123".to_string();
    let (tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "shadow".into(),
        "General Agent".into(),
        "parent-session".into(),
    );
    assert!(registry::get_status(&handle).is_some());
    let (status, kind) = registry::get_status(&handle).unwrap();
    assert!(matches!(status, JobStatus::Running));
    assert!(matches!(kind, JobKind::Subagent { .. }));

    let _ = tx.send("tool call: read_file\n".into());
    assert!(registry::subscribe(&handle).is_some());

    registry::set_final_result(&handle, "Found 7 files.".into());
    assert_eq!(
        registry::get_final_result(&handle),
        Some("Found 7 files.".into())
    );

    registry::mark_exited(&handle, JobStatus::Completed);
    let (status, _) = registry::get_status(&handle).unwrap();
    assert!(matches!(status, JobStatus::Completed));

    registry::remove(&handle);
    assert!(registry::get_status(&handle).is_none());
}

#[test]
fn test_list_shell_for_session() {
    let pid_a = 99992;
    let pid_b = 99993;
    let _tx_a = registry::register_shell(
        pid_a,
        "cmd_a".into(),
        PathBuf::from("/tmp/a.txt"),
        "session_x".into(),
    );
    let _tx_b = registry::register_shell(
        pid_b,
        "cmd_b".into(),
        PathBuf::from("/tmp/b.txt"),
        "session_y".into(),
    );

    let list = registry::list_shell_for_session("session_x");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].0, pid_a);

    registry::remove(&pid_a.to_string());
    registry::remove(&pid_b.to_string());
}

#[test]
fn test_subagent_not_in_shell_list() {
    // Session id must be unique to this test: `test_list_shell_for_session`
    // registers real shells under "session_x" concurrently, and the shared
    // process-global registry would make this list non-empty mid-flight.
    let handle = "agent-builtin:explore-xyz".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "explore".into(),
        "Explorer".into(),
        "session_subagent_only".into(),
    );

    let list = registry::list_shell_for_session("session_subagent_only");
    assert!(list.is_empty());

    registry::remove(&handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn test_kill_subagent_sets_job_cancel_flag() {
    use std::sync::atomic::Ordering;

    let handle = "agent-builtin:general-kill-flag".to_string();
    let (_tx, cancel) = registry::register_subagent(
        handle.clone(),
        "delegate".into(),
        "Worker".into(),
        "session_kill".into(),
    );
    assert!(!cancel.load(Ordering::SeqCst));

    registry::kill_subagent(&handle).expect("kill succeeds");
    assert!(
        cancel.load(Ordering::SeqCst),
        "kill must set the job's own cancel flag for cooperative shutdown"
    );
    let (status, _) = registry::get_status(&handle).unwrap();
    assert!(matches!(status, JobStatus::Killed));

    registry::remove(&handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn test_killed_status_is_sticky_over_completed() {
    let handle = "agent-builtin:general-sticky".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "delegate".into(),
        "Worker".into(),
        "session_sticky".into(),
    );

    registry::kill_subagent(&handle).expect("kill succeeds");
    // The cooperatively-cancelled worker's completion path still calls
    // mark_exited(Completed) — that must not overwrite the Killed verdict.
    registry::mark_exited(&handle, JobStatus::Completed);
    let (status, _) = registry::get_status(&handle).unwrap();
    assert!(matches!(status, JobStatus::Killed));

    registry::remove(&handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn test_cancel_subagents_for_session_scopes_to_session() {
    use std::sync::atomic::Ordering;

    let mine = "agent-fanout-mine".to_string();
    let other = "agent-fanout-other".to_string();
    let (_tx1, mine_flag) = registry::register_subagent(
        mine.clone(),
        "delegate".into(),
        "Mine".into(),
        "session_fanout_a".into(),
    );
    let (_tx2, other_flag) = registry::register_subagent(
        other.clone(),
        "delegate".into(),
        "Other".into(),
        "session_fanout_b".into(),
    );

    let cancelled = registry::cancel_subagents_for_session("session_fanout_a");
    assert_eq!(cancelled, 1);
    assert!(mine_flag.load(Ordering::SeqCst));
    assert!(
        !other_flag.load(Ordering::SeqCst),
        "fan-out must not touch other sessions' workers"
    );

    registry::remove(&mine);
    registry::remove(&other);
}

/// Wake-claim lifecycle: `claim_completion_wake_for_session` is the
/// exactly-once signal the job-wake coordinator uses. It claims a finished,
/// not-acknowledged, not-yet-dispatched job result and marks it dispatched
/// in the same pass — so a second call returns false (no double wake).
#[test]
fn test_claim_completion_wake_lifecycle() {
    let session = "wake-claim-session";
    let handle = "agent-builtin:explore-wakeclaim".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "delegate".into(),
        "Explore".into(),
        session.into(),
    );

    // Still running → nothing to claim.
    assert!(!registry::claim_completion_wake_for_session(session));

    // Completed but unacknowledged → first claim succeeds.
    registry::set_final_result(&handle, "explored 12 files".into());
    registry::mark_exited(&handle, JobStatus::Completed);
    assert!(registry::claim_completion_wake_for_session(session));

    // EXACTLY-ONCE invariant: a second claim of the same result returns false,
    // because the first marked it wake_dispatched. This is what makes the two
    // wake triggers (completion push + turn-end re-check) collapse to a single
    // dispatch regardless of ordering.
    assert!(
        !registry::claim_completion_wake_for_session(session),
        "a result must be claimable at most once"
    );

    // After release, it becomes claimable again (the running-owner path frees
    // the claim so the turn-end re-check can pick it up).
    registry::release_completion_wake_for_session(session);
    assert!(registry::claim_completion_wake_for_session(session));

    // Once acknowledged (the agent read it), no further claims fire.
    registry::acknowledge_output(&handle);
    registry::release_completion_wake_for_session(session);
    assert!(
        !registry::claim_completion_wake_for_session(session),
        "an acknowledged result needs no wake"
    );

    // Other sessions are never matched.
    assert!(!registry::claim_completion_wake_for_session(
        "some-other-session"
    ));

    registry::remove(&handle);
}

/// A finished **shell** job wakes its owning session exactly like a subagent:
/// exited shells (success or failure) are claimable once; a **killed** shell
/// is never claimable — whoever killed it (model kill_handle / user Stop)
/// already knows, so waking an idle session to announce it would be noise.
#[test]
fn test_claim_completion_wake_covers_shell_jobs() {
    let session = "wake-claim-shell-session";
    let pid = 99997;
    let _tx = registry::register_shell(
        pid,
        "build".into(),
        PathBuf::from("/tmp/wakeclaim.txt"),
        session.into(),
    );
    let handle = pid.to_string();

    // Still running → nothing to claim.
    assert!(!registry::claim_completion_wake_for_session(session));

    registry::mark_exited(&handle, JobStatus::Exited(0));
    assert!(
        registry::claim_completion_wake_for_session(session),
        "a completed shell with unread output must wake its owner"
    );
    assert!(
        !registry::claim_completion_wake_for_session(session),
        "shell results are claimable at most once"
    );
    registry::remove(&handle);

    let killed_pid = 99998;
    let _tx = registry::register_shell(
        killed_pid,
        "npm run dev".into(),
        PathBuf::from("/tmp/wakeclaim-killed.txt"),
        session.into(),
    );
    let killed_handle = killed_pid.to_string();
    registry::mark_exited(&killed_handle, JobStatus::Killed);
    assert!(
        !registry::claim_completion_wake_for_session(session),
        "a killed shell must never wake its owner"
    );
    registry::remove(&killed_handle);
}

/// Stall-advisory claim lifecycle: a running shell latched as waiting for
/// input is claimable exactly once via its own `stall_delivered` flag —
/// which must NOT consume the job's one completion wake. Output resuming
/// clears the latch and re-arms the advisory.
#[test]
fn test_stall_advisory_claim_lifecycle() {
    let session = "stall-claim-session";
    let pid = 99995;
    let _tx = registry::register_shell(
        pid,
        "git push".into(),
        PathBuf::from("/tmp/stall-claim.txt"),
        session.into(),
    );
    let handle = pid.to_string();

    // Running, not stalled → nothing to claim.
    assert!(!registry::claim_completion_wake_for_session(session));

    assert!(registry::mark_stalled_waiting_input(&handle));
    assert!(
        !registry::mark_stalled_waiting_input(&handle),
        "latch is one-shot until cleared"
    );
    assert_eq!(registry::is_stalled_waiting_input(&handle), Some(true));

    assert!(
        registry::claim_completion_wake_for_session(session),
        "a stalled running shell must be claimable for delivery"
    );
    assert!(
        !registry::claim_completion_wake_for_session(session),
        "the advisory is delivered at most once"
    );

    // A released claim (owner was running) becomes claimable again.
    registry::release_completion_wake_for_session(session);
    assert!(registry::claim_completion_wake_for_session(session));

    // Output resumed → latch cleared and advisory re-armed for a future
    // distinct stall.
    registry::clear_stalled_waiting_input(&handle);
    assert_eq!(registry::is_stalled_waiting_input(&handle), Some(false));
    assert!(!registry::claim_completion_wake_for_session(session));
    assert!(registry::mark_stalled_waiting_input(&handle));
    assert!(registry::claim_completion_wake_for_session(session));

    // The stall advisory never consumed the completion wake: once the job
    // exits, the completion is still claimable.
    registry::mark_exited(&handle, JobStatus::Exited(0));
    assert!(
        registry::claim_completion_wake_for_session(session),
        "completion wake must survive prior stall deliveries"
    );

    registry::remove(&handle);
}

/// Tombstone resolution: after a finished job is reaped via `remove`, a later
/// `resolve_status_with_tombstone` still reports its REAL terminal status and
/// kind (precise "it finished") — distinct from a genuinely-unknown handle,
/// which resolves to `None` (the agent mistyped it).
#[test]
fn test_tombstone_distinguishes_reaped_from_unknown() {
    let session = "tombstone-session";
    let handle = "agent-builtin:explore-tombstone".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "delegate".into(),
        "Explore".into(),
        session.into(),
    );
    registry::set_final_result(&handle, "done".into());
    registry::mark_exited(&handle, JobStatus::Completed);

    // Live job present → resolves directly.
    let live = registry::resolve_status_with_tombstone(&handle);
    assert!(matches!(
        live,
        Some((JobStatus::Completed, JobKind::Subagent { .. }))
    ));

    // Reap it. The tombstone must preserve the REAL terminal status + kind.
    registry::remove(&handle);
    assert!(
        registry::get_status(&handle).is_none(),
        "job should be gone from the live registry"
    );
    let tomb = registry::resolve_status_with_tombstone(&handle);
    assert!(
        matches!(tomb, Some((JobStatus::Completed, JobKind::Subagent { .. }))),
        "reaped job must resolve to its real terminal status + kind, got {:?}",
        tomb.map(|(s, _)| s)
    );

    // A handle that was never registered resolves to None → caller errors.
    assert!(
        registry::resolve_status_with_tombstone("agent-never-existed-xyz").is_none(),
        "an unknown handle must not be mistaken for a finished job"
    );
}

/// A reaped **shell** job's tombstone preserves the real exit code, not a
/// synthesised `Completed` — so `await_output` reports `exit N` accurately even
/// after the live job is gone.
#[test]
fn test_tombstone_preserves_shell_exit_code() {
    let session = "tombstone-shell-session";
    let pid = 99996;
    let _tx = registry::register_shell(
        pid,
        "false".into(),
        PathBuf::from("/tmp/tombstone-shell.txt"),
        session.into(),
    );
    let handle = pid.to_string();
    registry::mark_exited(&handle, JobStatus::Exited(1));
    registry::remove(&handle);

    let tomb = registry::resolve_status_with_tombstone(&handle);
    assert!(
        matches!(tomb, Some((JobStatus::Exited(1), JobKind::Shell { .. }))),
        "tombstone must preserve the real exit code + shell kind, got {:?}",
        tomb.map(|(s, _)| s)
    );
}
