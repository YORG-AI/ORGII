use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use core_types::session_event::ShellReplayStatus;
use tokio::sync::watch;

use super::super::shell_replay::{
    active_state, ShellReplayStream, ShellReplayTarget, ShellReplayWriter,
};
use super::background::{bounded_background_result, SHELL_TOOL_RESULT_MAX_BYTES};
use super::output_runtime::{drain_output, OutputRuntime};
use super::stall_watchdog::looks_like_interactive_prompt;
use super::{execute_via_command, ExecIdentity, ExecMode};

#[test]
fn interactive_prompt_detection_matches_common_prompts() {
    for tail in [
        "Cloning into 'repo'...\nUsername for 'https://github.com':",
        "sudo: reading password\n[stderr] Password:",
        "Overwrite existing file? [y/N]",
        "Do you want to continue? (yes/no):",
        "some output\nAccept the license terms? [y/n]?",
        "Press ENTER to continue",
        "compiling...\n>>>",
        "$",
        "Enter passphrase for key '/Users/x/.ssh/id_ed25519':",
    ] {
        assert!(
            looks_like_interactive_prompt(tail),
            "should match prompt tail: {tail:?}"
        );
    }
}

#[test]
fn interactive_prompt_detection_ignores_ordinary_output() {
    for tail in [
        "",
        "   \n  ",
        "Compiling agent_core v0.1.0",
        "test result: ok. 3164 passed; 0 failed",
        "webpack compiled successfully in 4123 ms",
        "GET /api/health 200 3ms",
        "warning: unused variable `x`",
        "vite v5.0.0 dev server running at:\n> Local: http://localhost:5173/",
        "What's next?\n  cd app && npm run dev",
    ] {
        assert!(
            !looks_like_interactive_prompt(tail),
            "should NOT match ordinary tail: {tail:?}"
        );
    }
}

#[test]
fn background_tool_result_stays_inside_model_budget() {
    let preview = "中🙂ansi\x1b[31m".repeat(8_000);
    let result = bounded_background_result(
        preview,
        "[process started in background as PID 42]",
        "\nComplete output: Session Replay",
    );
    assert!(result.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
    assert!(result.contains("Session Replay"));
    assert!(!result.contains('\u{fffd}'));
}

#[tokio::test]
#[serial_test::serial]
async fn writer_join_failure_marks_exact_replay_incomplete_without_panicking() {
    let _sandbox = test_helpers::test_env::sandbox();
    let root = super::super::shell_replay::resolve_replay_root();
    let target = ShellReplayTarget::new("join-failure-session", "join-failure-call");
    let mut writer =
        ShellReplayWriter::create(&root, target.clone(), "emit", Path::new("/tmp"), None).unwrap();
    writer
        .append(ShellReplayStream::Stdout, b"before panic")
        .unwrap();
    let log_path = Some(writer.path().to_path_buf());
    let (_failure_tx, failure_rx) = watch::channel(None);
    let runtime = OutputRuntime {
        stdout_task: tokio::spawn(async {}),
        stderr_task: tokio::spawn(async {}),
        writer_task: tokio::spawn(async move {
            let _owned_writer = writer;
            panic!("injected writer failure");
        }),
        failure_rx,
        log_path,
        replay_target: target.clone(),
        app_handle: None,
    };

    let error = match drain_output(runtime).await {
        Ok(_) => panic!("injected writer failure unexpectedly succeeded"),
        Err(error) => error,
    };
    assert!(error.contains("writer task failed"));
    let state = super::super::shell_replay::load_replay_state(&target.session_id, &target.call_id)
        .unwrap()
        .unwrap();
    assert_eq!(state.status, ShellReplayStatus::Incomplete);
    assert!(state.error.unwrap().contains("writer task failed"));
    assert!(active_state(&target.session_id, &target.call_id).is_none());
}

async fn wait_for_terminal_replay(session_id: &str, call_id: &str) -> ShellReplayStatus {
    for _ in 0..100 {
        if let Some(state) =
            super::super::shell_replay::load_replay_state(session_id, call_id).unwrap()
        {
            if state.status != ShellReplayStatus::Running {
                return state.status;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("replay {session_id}/{call_id} did not cross its completion barrier");
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn real_subprocess_background_timeout_and_cancel_cross_completion_barrier() {
    let _sandbox = test_helpers::test_env::sandbox();
    let root = super::super::shell_replay::resolve_replay_root();
    let cwd = std::env::temp_dir();
    let session_id = "subprocess-lifecycle-session";

    let explicit = ExecIdentity::new(session_id, "call-explicit-background");
    let launch = execute_via_command(
        "printf explicit-background",
        cwd.clone(),
        10,
        None,
        ExecMode::Background,
        &explicit,
        &root,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(launch.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
    assert_eq!(
        wait_for_terminal_replay(session_id, "call-explicit-background").await,
        ShellReplayStatus::Complete
    );

    let timed = ExecIdentity::new(session_id, "call-wait-timeout-background");
    let launch = execute_via_command(
        "printf timeout-background",
        cwd.clone(),
        10,
        Some(0),
        ExecMode::Blocking,
        &timed,
        &root,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(launch.len() <= SHELL_TOOL_RESULT_MAX_BYTES);
    assert_eq!(
        wait_for_terminal_replay(session_id, "call-wait-timeout-background").await,
        ShellReplayStatus::Complete
    );

    let cancelled = ExecIdentity::new(session_id, "call-cancelled");
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let set_cancel = {
        let cancel_flag = cancel_flag.clone();
        async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_flag.store(true, Ordering::Relaxed);
        }
    };
    let execute = execute_via_command(
        "printf before-cancel; sleep 10",
        cwd,
        20,
        None,
        ExecMode::Blocking,
        &cancelled,
        &root,
        None,
        Some(cancel_flag.as_ref()),
    );
    let (result, ()) = tokio::join!(execute, set_cancel);
    assert!(result.is_err());
    assert_ne!(
        wait_for_terminal_replay(session_id, "call-cancelled").await,
        ShellReplayStatus::Running
    );
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
#[ignore = "real 10 MiB subprocess/RSS-adjacent acceptance"]
async fn real_subprocess_ten_megabytes_is_complete_and_bounded() {
    let _sandbox = test_helpers::test_env::sandbox();
    let root = super::super::shell_replay::resolve_replay_root();
    let identity = ExecIdentity::new("subprocess-10m-session", "subprocess-10m-call");
    let result = execute_via_command(
        "yes x | head -c 10485760",
        std::env::temp_dir(),
        30,
        None,
        ExecMode::Blocking,
        &identity,
        &root,
        None,
        None,
    )
    .await
    .unwrap();
    assert!(result.len() <= super::super::shell_replay::SHELL_REPLAY_SUMMARY_MAX_BYTES);
    let state =
        super::super::shell_replay::load_replay_state(&identity.session_id, &identity.call_id)
            .unwrap()
            .unwrap();
    assert_eq!(state.status, ShellReplayStatus::Complete);
    assert_eq!(state.bookmark.visible_bytes, 10 * 1024 * 1024);
    assert!(state.terminal_preview.len() <= super::super::shell_replay::SHELL_REPLAY_PREVIEW_BYTES);
}
