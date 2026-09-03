use std::path::PathBuf;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::*;
use crate::tools::call_context::{TurnProcessControl, TurnProcessOwner};

#[tokio::test]
async fn owned_pty_requires_cleanup_barrier_after_public_status_is_terminal() {
    let owner = TurnProcessOwner {
        session_id: "owned-pty-session".to_string(),
        turn_intent_id: "owned-pty-turn".to_string(),
        runtime_lease_id: "owned-pty-lease".to_string(),
        dialog_turn_generation: "owned-pty-dialog".to_string(),
    };
    let control = TurnProcessControl {
        owner: owner.clone(),
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: true,
    };
    let process_cancel = CancellationToken::new();
    let cancellation_observer = process_cancel.clone();
    let handle = "pty-owned-barrier-test".to_string();
    let completion = register_owned_pty_replay(OwnedPtyReplayRegistration {
        handle: handle.clone(),
        pid: 424_242,
        command: "interactive test".to_string(),
        log_path: PathBuf::from("owned-pty-test.jsonl"),
        session_id: owner.session_id.clone(),
        call_id: "owned-pty-call".to_string(),
        turn_control: &control,
        process_cancel,
    });
    assert!(!owned_jobs_are_terminal(&owner));

    let owner_for_wait = owner.clone();
    let waiter = tokio::spawn(async move {
        cancel_and_await_jobs_for_owner(&owner_for_wait, Duration::from_secs(1)).await
    });
    tokio::time::timeout(
        Duration::from_millis(200),
        cancellation_observer.cancelled(),
    )
    .await
    .expect("exact PTY cancellation token was not triggered");

    mark_exited(&handle, JobStatus::Killed);
    assert!(
        !owned_jobs_are_terminal(&owner),
        "a user-visible terminal status is not OS/replay cleanup proof"
    );
    assert!(!waiter.is_finished());

    completion.finish(Ok(()));
    waiter
        .await
        .expect("owner waiter task")
        .expect("owner finality after exact PTY cleanup");
    assert!(owned_jobs_are_terminal(&owner));
    remove(&handle);
}

#[tokio::test]
async fn failed_owned_pty_cleanup_remains_non_terminal() {
    let owner = TurnProcessOwner {
        session_id: "failed-owned-pty-session".to_string(),
        turn_intent_id: "failed-owned-pty-turn".to_string(),
        runtime_lease_id: "failed-owned-pty-lease".to_string(),
        dialog_turn_generation: "failed-owned-pty-dialog".to_string(),
    };
    let control = TurnProcessControl {
        owner: owner.clone(),
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: true,
    };
    let handle = "pty-owned-cleanup-failure-test".to_string();
    let completion = register_owned_pty_replay(OwnedPtyReplayRegistration {
        handle: handle.clone(),
        pid: 424_243,
        command: "interactive cleanup failure".to_string(),
        log_path: PathBuf::from("owned-pty-cleanup-failure.jsonl"),
        session_id: owner.session_id.clone(),
        call_id: "owned-pty-cleanup-failure-call".to_string(),
        turn_control: &control,
        process_cancel: CancellationToken::new(),
    });
    mark_shell_cancel_requested(&handle);
    mark_exited(&handle, JobStatus::Killed);
    completion.finish(Err("process tree remains live".to_string()));

    assert!(!owned_jobs_are_terminal(&owner));
    let error = cancel_and_await_jobs_for_owner(&owner, Duration::from_millis(100))
        .await
        .expect_err("cleanup failure must block owner finality");
    assert!(error.contains("process tree remains live"), "{error}");
    remove(&handle);
}
