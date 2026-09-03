use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use core_types::session_event::ShellReplayStatus;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::super::registry;
use super::super::shell_replay::{
    active_state, ShellReplayStream, ShellReplayTarget, ShellReplayWriter,
};
use super::background::{
    bounded_background_result, handle_backgrounded, SHELL_TOOL_RESULT_MAX_BYTES,
};
use super::output_runtime::{drain_output, spawn_output_runtime, OutputRuntime};
use super::stall_watchdog::looks_like_interactive_prompt;
use super::{execute_via_command, BackgroundReason, ExecIdentity, ExecMode};

#[cfg(unix)]
fn test_turn_control(
    session_id: &str,
    generation: &str,
) -> crate::tools::call_context::TurnProcessControl {
    crate::tools::call_context::TurnProcessControl {
        owner: crate::tools::call_context::TurnProcessOwner {
            session_id: session_id.to_string(),
            turn_intent_id: format!("intent-{generation}"),
            runtime_lease_id: format!("lease-{generation}"),
            dialog_turn_generation: generation.to_string(),
        },
        background_cancel: CancellationToken::new(),
        require_owned_job_finality: false,
    }
}

#[cfg(unix)]
fn parse_pid_marker(contents: &str) -> Option<(u32, u32)> {
    let mut values = contents.split_whitespace();
    let parent = values.next()?.parse().ok()?;
    let child = values.next()?.parse().ok()?;
    Some((parent, child))
}

#[cfg(unix)]
async fn wait_for_pid_marker(path: &Path) -> (u32, u32) {
    for _ in 0..200 {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Some(pids) = parse_pid_marker(&contents) {
                return pids;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("shell did not write PID marker {}", path.display());
}

#[cfg(unix)]
fn assert_pid_absent(pid: u32) {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    assert_eq!(result, -1, "PID {pid} is still alive");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH),
        "PID {pid} still exists or could not be inspected"
    );
}

#[cfg(unix)]
fn parent_child_command(marker: &Path) -> String {
    format!(
        "trap '' TERM; sh -c 'trap \"\" TERM; while :; do sleep 120; done' & child=$!; printf '%s %s\\n' \"$$\" \"$child\" > \"{}\"; wait",
        marker.display()
    )
}

#[cfg(unix)]
#[test]
fn pid_marker_parser_waits_for_a_complete_pair() {
    assert_eq!(parse_pid_marker(""), None);
    assert_eq!(parse_pid_marker("123"), None);
    assert_eq!(parse_pid_marker("123 incomplete"), None);
    assert_eq!(parse_pid_marker("123 456"), Some((123, 456)));
}

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
async fn task_handoff_fence_releases_after_spawn_not_process_exit() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().expect("temp workspace");
    let task_identity =
        crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity {
            org_run_id: "spawn-fence-run".to_string(),
            task_id: "spawn-fence-task".to_string(),
            session_id: "spawn-fence-session".to_string(),
            turn_intent_id: "spawn-fence-turn".to_string(),
            owner_member_id: "spawn-fence-member".to_string(),
            activation_generation: 1,
        };
    let permit =
        crate::coordination::agent_org_task_execution_fence::acquire_effect(&task_identity).await;
    let release =
        crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectFenceRelease::new(
            permit,
        );
    let replay_root = temp.path().join("replays");
    let work_dir = temp.path().to_path_buf();
    let execution = tokio::spawn(async move {
        execute_via_command(
            "sleep 2",
            work_dir,
            10,
            None,
            ExecMode::Blocking,
            &ExecIdentity::new("spawn-fence-session", "spawn-fence-call"),
            &replay_root,
            None,
            None,
            Some(release),
        )
        .await
    });

    let handoff = tokio::time::timeout(
        Duration::from_secs(1),
        crate::coordination::agent_org_task_execution_fence::acquire_handoff(
            "spawn-fence-run",
            "spawn-fence-task",
        ),
    )
    .await
    .expect("handoff must acquire after spawn, before process exit");
    assert!(
        !execution.is_finished(),
        "the process should still be running when the handoff fence acquires"
    );
    drop(handoff);
    execution
        .await
        .expect("subprocess task")
        .expect("subprocess completion");
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
        None,
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
async fn exact_owner_background_shell_stays_in_turn_and_skips_idle_wake() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    let mut control = test_turn_control("owned-shell-finality", "owned-shell-turn");
    control.require_owned_job_finality = true;
    let owner = control.owner.clone();
    let identity = ExecIdentity::new(&owner.session_id, "owned-shell-call")
        .with_turn_process_control(Some(control));

    execute_via_command(
        "printf owned-shell-output",
        temp.path().to_path_buf(),
        10,
        None,
        ExecMode::Background,
        &identity,
        &temp.path().join("replays"),
        None,
        None,
        None,
    )
    .await
    .expect("launch exact-owner background shell");
    assert_eq!(
        wait_for_terminal_replay(&owner.session_id, "owned-shell-call").await,
        ShellReplayStatus::Complete
    );

    let terminal = loop {
        let jobs = registry::list_jobs_for_owner(&owner);
        if jobs
            .iter()
            .all(|job| !matches!(job.status, registry::JobStatus::Running))
        {
            break jobs;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(terminal.len(), 1);
    let handle = terminal[0].handle.clone();
    assert!(terminal[0].has_unread_output);
    assert!(!registry::claim_completion_wake_for_session(
        &owner.session_id
    ));
    assert!(registry::list_jobs_for_reminder(&owner.session_id).is_empty());

    // `await_output` calls this exact acknowledgement after returning the
    // replay. Exact-owner terminal jobs are removed immediately.
    registry::acknowledge_outputs_for_owner(&owner, std::slice::from_ref(&handle));
    assert!(registry::list_jobs_for_owner(&owner).is_empty());
    assert!(registry::get_status(&handle).is_none());
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn turn_cancel_before_spawn_never_starts_the_shell() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("must-not-exist.pid");
    let control = test_turn_control("cancel-before-spawn", "turn-before");
    control.background_cancel.cancel();
    let identity = ExecIdentity::new(&control.owner.session_id, "call-before")
        .with_turn_process_control(Some(control));

    let result = execute_via_command(
        &format!("printf started > \"{}\"", marker.display()),
        temp.path().to_path_buf(),
        5,
        None,
        ExecMode::Blocking,
        &identity,
        &temp.path().join("replays"),
        None,
        None,
        None,
    )
    .await;

    assert!(result.is_err());
    assert!(!marker.exists(), "cancelled Turn spawned a shell");
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn foreground_turn_cancel_reaps_parent_child_and_process_group() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("foreground.pid");
    let control = test_turn_control("cancel-foreground", "turn-foreground");
    let identity = ExecIdentity::new(&control.owner.session_id, "call-foreground")
        .with_turn_process_control(Some(control.clone()));
    let command = parent_child_command(&marker);
    let replay_root = temp.path().join("replays");
    let cancel = async {
        let pids = wait_for_pid_marker(&marker).await;
        control.background_cancel.cancel();
        pids
    };
    let execute = execute_via_command(
        &command,
        temp.path().to_path_buf(),
        120,
        None,
        ExecMode::Blocking,
        &identity,
        &replay_root,
        None,
        None,
        None,
    );

    let (result, (parent, child)) = tokio::join!(execute, cancel);
    assert!(result.is_err());
    assert!(!registry::process_tree_exists(parent));
    assert_pid_absent(parent);
    assert_pid_absent(child);
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn background_turn_cancel_escalates_and_waits_for_parent_child_exit() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("background.pid");
    let control = test_turn_control("cancel-background", "turn-background");
    let owner = control.owner.clone();
    let identity = ExecIdentity::new(&owner.session_id, "call-background")
        .with_turn_process_control(Some(control.clone()));

    execute_via_command(
        &parent_child_command(&marker),
        temp.path().to_path_buf(),
        120,
        None,
        ExecMode::Background,
        &identity,
        &temp.path().join("replays"),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let (parent, child) = wait_for_pid_marker(&marker).await;
    assert!(registry::process_tree_exists(parent));

    let started = Instant::now();
    control.background_cancel.cancel();
    registry::await_shells_terminated_for_owner(&owner, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "process drain exceeded its bounded wait"
    );
    assert!(!registry::process_tree_exists(parent));
    assert_pid_absent(parent);
    assert_pid_absent(child);
    assert!(matches!(
        registry::get_status(&parent.to_string()).map(|value| value.0),
        Some(registry::JobStatus::Killed)
    ));
    assert_ne!(
        wait_for_terminal_replay(&owner.session_id, "call-background").await,
        ShellReplayStatus::Running
    );
    registry::remove(&parent.to_string());
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn timeout_background_turn_cancel_reaps_the_process_group() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("timeout-background.pid");
    let control = test_turn_control("cancel-timeout-background", "turn-timeout-background");
    let owner = control.owner.clone();
    let identity = ExecIdentity::new(&owner.session_id, "call-timeout-background")
        .with_turn_process_control(Some(control.clone()));

    execute_via_command(
        &parent_child_command(&marker),
        temp.path().to_path_buf(),
        120,
        Some(0),
        ExecMode::Blocking,
        &identity,
        &temp.path().join("replays"),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let (parent, child) = wait_for_pid_marker(&marker).await;
    control.background_cancel.cancel();

    registry::await_shells_terminated_for_owner(&owner, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!registry::process_tree_exists(parent));
    assert_pid_absent(parent);
    assert_pid_absent(child);
    registry::remove(&parent.to_string());
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn natural_exit_racing_turn_cancel_has_one_terminal_barrier() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    for index in 0..10 {
        let marker = temp.path().join(format!("exit-race-{index}.pid"));
        let control = test_turn_control("cancel-exit-race", &format!("turn-race-{index}"));
        let owner = control.owner.clone();
        let call_id = format!("call-exit-race-{index}");
        let identity = ExecIdentity::new(&owner.session_id, &call_id)
            .with_turn_process_control(Some(control.clone()));
        let command = format!(
            "printf '%s 0\\n' \"$$\" > \"{}\"; sleep 0.03",
            marker.display()
        );

        execute_via_command(
            &command,
            temp.path().to_path_buf(),
            10,
            None,
            ExecMode::Background,
            &identity,
            &temp.path().join("replays"),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let (pid, _) = wait_for_pid_marker(&marker).await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        control.background_cancel.cancel();
        registry::await_shells_terminated_for_owner(&owner, Duration::from_secs(3))
            .await
            .unwrap();

        assert!(!registry::process_tree_exists(pid));
        assert!(matches!(
            registry::get_status(&pid.to_string()).map(|value| value.0),
            Some(registry::JobStatus::Killed | registry::JobStatus::Exited(0))
        ));
        registry::remove(&pid.to_string());
    }
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn latched_cancel_between_spawn_and_background_registration_is_not_lost() {
    let _sandbox = test_helpers::test_env::sandbox();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("replays");
    let control = test_turn_control("cancel-transition", "turn-transition");
    let owner = control.owner.clone();
    let identity = ExecIdentity::new(&owner.session_id, "call-transition")
        .with_turn_process_control(Some(control.clone()));
    let command = "trap '' TERM; sh -c 'trap \"\" TERM; while :; do sleep 120; done' & wait";
    let replay =
        ShellReplayWriter::create(&root, identity.replay_target(), command, temp.path(), None)
            .unwrap();
    let mut shell = tokio::process::Command::new("sh");
    shell
        .arg("-c")
        .arg(command)
        .current_dir(temp.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = shell.spawn().unwrap();
    let pid = child.id().unwrap();
    let runtime = spawn_output_runtime(
        identity.clone(),
        child.stdout.take(),
        child.stderr.take(),
        replay,
    );

    control.background_cancel.cancel();
    handle_backgrounded(
        command,
        pid,
        0,
        BackgroundReason::Timeout,
        child,
        runtime,
        identity,
        None,
        None,
    )
    .unwrap();

    registry::await_shells_terminated_for_owner(&owner, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(!registry::process_tree_exists(pid));
    assert_pid_absent(pid);
    registry::remove(&pid.to_string());
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
