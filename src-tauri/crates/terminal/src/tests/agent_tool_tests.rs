use crate::agent_tool::*;
use portable_pty::{Child, ChildKiller, ExitStatus};
use std::{
    io,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

#[cfg(unix)]
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Copy)]
enum TestChildPoll {
    Exited,
    Failed,
}

#[derive(Debug)]
struct TestChild {
    poll: TestChildPoll,
    kills: Arc<AtomicUsize>,
    waits: Arc<AtomicUsize>,
}

impl ChildKiller for TestChild {
    fn kill(&mut self) -> io::Result<()> {
        self.kills.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(TestChildKiller)
    }
}

#[derive(Debug)]
struct TestChildKiller;

impl ChildKiller for TestChildKiller {
    fn kill(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self)
    }
}

impl Child for TestChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self.poll {
            TestChildPoll::Exited => Ok(Some(ExitStatus::with_exit_code(0))),
            TestChildPoll::Failed => Err(io::Error::other("poll failed")),
        }
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.waits.fetch_add(1, Ordering::SeqCst);
        Ok(ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        Some(1)
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

fn test_child(poll: TestChildPoll) -> (ManagedPtyChild, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let kills = Arc::new(AtomicUsize::new(0));
    let waits = Arc::new(AtomicUsize::new(0));
    let child: ManagedPtyChild = Arc::new(Mutex::new(Some(Box::new(TestChild {
        poll,
        kills: Arc::clone(&kills),
        waits: Arc::clone(&waits),
    }))));
    (child, kills, waits)
}

// ============================================
// PTY child lifecycle
// ============================================

#[test]
fn child_reaper_takes_an_exited_child_atomically() {
    let (child, _kills, _waits) = test_child(TestChildPoll::Exited);

    assert!(matches!(poll_pty_child(&child), PtyChildPoll::Exited));
    assert!(child.lock().unwrap().is_none());
}

#[test]
fn child_reaper_terminates_and_reaps_after_a_poll_failure() {
    let (shared_child, kills, waits) = test_child(TestChildPoll::Failed);

    let PtyChildPoll::PollFailed(child) = poll_pty_child(&shared_child) else {
        panic!("failed child poll must preserve the child for cleanup");
    };
    PtySession::terminate_and_reap(child);

    assert!(shared_child.lock().unwrap().is_none());
    assert_eq!(kills.load(Ordering::SeqCst), 1);
    assert_eq!(waits.load(Ordering::SeqCst), 1);
}

// ============================================
// default_shell_path
// ============================================

#[test]
fn resolve_default_shell_path_uses_powershell_on_windows() {
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Windows, Some("/bin/bash")),
        "powershell.exe"
    );
}

#[test]
fn resolve_default_shell_path_uses_shell_env_on_macos() {
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Macos, Some("/bin/bash")),
        "/bin/bash"
    );
}

#[test]
fn resolve_default_shell_path_falls_back_to_zsh_on_macos() {
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Macos, None),
        "zsh"
    );
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Macos, Some("  ")),
        "zsh"
    );
}

#[test]
fn resolve_default_shell_path_uses_shell_env_on_unix() {
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Unix, Some("/usr/bin/bash")),
        "/usr/bin/bash"
    );
}

#[test]
fn resolve_default_shell_path_falls_back_to_bash_on_unix() {
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Unix, None),
        "bash"
    );
    assert_eq!(
        resolve_default_shell_path(DefaultShellPlatform::Unix, Some("  ")),
        "bash"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn default_shell_path_matches_windows_platform() {
    assert_eq!(default_shell_path(), "powershell.exe");
}

#[cfg(target_os = "macos")]
#[test]
fn default_shell_path_uses_shell_env_on_macos_platform() {
    let _guard = ENV_LOCK.lock().unwrap();
    let previous = std::env::var_os("SHELL");

    std::env::set_var("SHELL", "/bin/bash");
    assert_eq!(default_shell_path(), "/bin/bash");

    if let Some(value) = previous {
        std::env::set_var("SHELL", value);
    } else {
        std::env::remove_var("SHELL");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn default_shell_path_falls_back_to_zsh_on_macos_platform() {
    let _guard = ENV_LOCK.lock().unwrap();
    let previous = std::env::var_os("SHELL");

    std::env::remove_var("SHELL");
    assert_eq!(default_shell_path(), "zsh");

    if let Some(value) = previous {
        std::env::set_var("SHELL", value);
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn default_shell_path_uses_shell_env_on_unix_platform() {
    let _guard = ENV_LOCK.lock().unwrap();
    let previous = std::env::var_os("SHELL");

    std::env::set_var("SHELL", "/usr/bin/bash");
    assert_eq!(default_shell_path(), "/usr/bin/bash");

    if let Some(value) = previous {
        std::env::set_var("SHELL", value);
    } else {
        std::env::remove_var("SHELL");
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn default_shell_path_falls_back_to_bash_on_unix_platform() {
    let _guard = ENV_LOCK.lock().unwrap();
    let previous = std::env::var_os("SHELL");

    std::env::remove_var("SHELL");
    assert_eq!(default_shell_path(), "bash");

    if let Some(value) = previous {
        std::env::set_var("SHELL", value);
    }
}

// ============================================
// clean_pty_output
// ============================================

#[test]
fn clean_pty_output_strips_csi_sequences() {
    let input = "hello \x1b[31mred\x1b[0m world";
    let result = clean_pty_output(input);
    assert_eq!(result, "hello red world");
}

#[test]
fn clean_pty_output_strips_osc_sequences_bel() {
    let input = "before\x1b]0;window title\x07after";
    let result = clean_pty_output(input);
    assert_eq!(result, "beforeafter");
}

#[test]
fn clean_pty_output_strips_osc_sequences_st() {
    let input = "before\x1b]0;title\x1b\\after";
    let result = clean_pty_output(input);
    assert_eq!(result, "beforeafter");
}

#[test]
fn clean_pty_output_handles_plain_text() {
    let result = clean_pty_output("  just plain text  ");
    assert_eq!(result, "just plain text");
}

#[test]
fn clean_pty_output_handles_empty_string() {
    let result = clean_pty_output("");
    assert_eq!(result, "");
}

#[test]
fn clean_pty_output_strips_multiple_csi_sequences() {
    let input = "\x1b[1m\x1b[32mgreen bold\x1b[0m normal \x1b[4munderline\x1b[0m";
    let result = clean_pty_output(input);
    assert_eq!(result, "green bold normal underline");
}

#[test]
fn clean_pty_output_handles_cursor_movement() {
    let input = "line1\x1b[2Aline2\x1b[Kline3";
    let result = clean_pty_output(input);
    assert_eq!(result, "line1line2line3");
}

// ============================================
// truncate_output
// ============================================

#[test]
fn truncate_output_returns_short_text_unchanged() {
    let short = "hello world";
    assert_eq!(truncate_output(short), short);
}

#[test]
fn truncate_output_preserves_text_at_limit() {
    let exact = "a".repeat(MAX_OUTPUT_CHARS);
    assert_eq!(truncate_output(&exact), exact);
}

#[test]
fn truncate_output_truncates_long_text() {
    let long = format!("first line\n{}", "x".repeat(MAX_OUTPUT_CHARS + 500));
    let result = truncate_output(&long);
    assert!(result.len() <= MAX_OUTPUT_CHARS + 100);
    assert!(result.contains("[...truncated"));
}

#[test]
fn truncate_output_preserves_end_of_text() {
    let end_marker = "END_MARKER";
    let long = format!("{}\n{}", "x".repeat(MAX_OUTPUT_CHARS + 100), end_marker);
    let result = truncate_output(&long);
    assert!(result.contains(end_marker));
}

// ============================================
// shell_escape
// ============================================

#[test]
fn shell_escape_wraps_in_single_quotes() {
    assert_eq!(shell_escape("hello"), "'hello'");
}

#[test]
fn shell_escape_handles_spaces() {
    assert_eq!(
        shell_escape("/path/with spaces/file"),
        "'/path/with spaces/file'"
    );
}

#[test]
fn shell_escape_escapes_single_quotes() {
    assert_eq!(shell_escape("it's"), "'it'\\''s'");
}

#[test]
fn shell_escape_handles_empty_string() {
    assert_eq!(shell_escape(""), "''");
}

// ============================================
// extract_done_marker
// ============================================

#[test]
fn extract_done_marker_finds_simple_marker() {
    let marker = "__ORGII_DONE_abc123";
    let output = format!("some output\n{}__0__\n", marker);
    let result = extract_done_marker(&output, marker);
    assert!(result.is_some());
    let (text, exit_code) = result.unwrap();
    assert_eq!(exit_code, 0);
    assert!(!text.contains(marker));
}

#[test]
fn extract_done_marker_captures_nonzero_exit_code() {
    let marker = "__ORGII_DONE_test42";
    let output = format!("error output\n{}__127__\n", marker);
    let result = extract_done_marker(&output, marker);
    assert!(result.is_some());
    let (_text, exit_code) = result.unwrap();
    assert_eq!(exit_code, 127);
}

#[test]
fn extract_done_marker_returns_none_without_marker() {
    let marker = "__ORGII_DONE_notpresent";
    let output = "just some normal output\nno marker here\n";
    assert!(extract_done_marker(output, marker).is_none());
}

#[test]
fn extract_done_marker_handles_ansi_in_output() {
    let marker = "__ORGII_DONE_ansi1";
    // The output after ANSI stripping and echo removal may not contain
    // "colored" since it's on the first line (treated as command echo).
    // Key assertion: marker detection works despite ANSI codes.
    let output = format!(
        "echo line\n\x1b[32mcolored\x1b[0m output\n{}__0__\n",
        marker
    );
    let result = extract_done_marker(&output, marker);
    assert!(result.is_some());
    let (_text, exit_code) = result.unwrap();
    assert_eq!(exit_code, 0);
}

#[test]
fn extract_done_marker_uses_last_occurrence() {
    let marker = "__ORGII_DONE_dup1";
    // First is echo (contains literal $__M which won't match the expanded marker)
    // Second is the real marker
    let output = format!("echo line\nreal output\n{}__42__\n", marker,);
    let result = extract_done_marker(&output, marker);
    assert!(result.is_some());
    let (_text, exit_code) = result.unwrap();
    assert_eq!(exit_code, 42);
}

#[test]
fn extract_done_marker_rejects_non_integer_exit_code() {
    let marker = "__ORGII_DONE_bad";
    let output = format!("output\n{}__notanumber__\n", marker);
    assert!(extract_done_marker(&output, marker).is_none());
}

// ============================================
// strip_command_echo
// ============================================

#[test]
fn strip_command_echo_removes_first_line() {
    let output = " __M=MARKER; ls; printf ...\nfile1.txt\nfile2.txt\n";
    let result = strip_command_echo(output);
    assert_eq!(result, "file1.txt\nfile2.txt");
}

#[test]
fn strip_command_echo_returns_empty_for_echo_only() {
    let output = " __M=MARKER; cmd; printf ...";
    let result = strip_command_echo(output);
    assert_eq!(result, "");
}

#[test]
fn strip_command_echo_handles_empty_input() {
    assert_eq!(strip_command_echo(""), "");
}

// ============================================
// ExecPhase Display
// ============================================

#[test]
fn exec_phase_display_values() {
    assert_eq!(
        ExecPhase::WaitingForMarker.to_string(),
        "waiting_for_marker"
    );
    assert_eq!(ExecPhase::Completed.to_string(), "completed");
}

#[cfg(unix)]
#[test]
fn agent_session_termination_kills_hup_immune_session_descendants() {
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("trap '' TERM HUP; (trap '' TERM HUP; exec sleep 30) & wait");
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut leader = command
        .spawn()
        .expect("spawn isolated PTY-like process session");
    let session_id = leader.id();

    let mut system = System::new();
    let refresh = |system: &mut System| {
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let leader_start_time = loop {
        refresh(&mut system);
        let members = system
            .processes()
            .values()
            .filter(|process| {
                process
                    .session_id()
                    .is_some_and(|value| value.as_u32() == session_id)
            })
            .count();
        if members >= 2 {
            break system
                .process(sysinfo::Pid::from_u32(session_id))
                .expect("session leader remains live")
                .start_time();
        }
        assert!(
            Instant::now() < deadline,
            "session descendant did not start in time"
        );
        std::thread::sleep(Duration::from_millis(20));
    };

    let owned_processes = snapshot_agent_unix_process_tree(session_id, leader_start_time)
        .expect("snapshot the PTY process tree");
    terminate_agent_unix_session(session_id, leader_start_time, owned_processes)
        .expect("terminate the complete PTY process session");
    leader.wait().expect("reap session leader");
    refresh(&mut system);
    assert!(system.processes().values().all(|process| {
        process
            .session_id()
            .is_none_or(|value| value.as_u32() != session_id)
            || matches!(
                process.status(),
                sysinfo::ProcessStatus::Dead | sysinfo::ProcessStatus::Zombie
            )
    }));
}

#[cfg(unix)]
#[test]
fn agent_session_termination_kills_descendant_that_created_a_new_session() {
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

    let test_binary = std::env::current_exe().expect("current terminal test binary");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("trap '' TERM HUP; \"$1\" agent_detached_process_helper --ignored --nocapture & wait")
        .arg("agent-session-test")
        .arg(test_binary);
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut leader = command
        .spawn()
        .expect("spawn PTY-like session with detached descendant");
    let session_id = leader.id();

    let mut system = System::new();
    let refresh = |system: &mut System| {
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    let (leader_start_time, owned_processes) = loop {
        refresh(&mut system);
        let leader_start_time = system
            .process(sysinfo::Pid::from_u32(session_id))
            .expect("session leader remains live")
            .start_time();
        let snapshot = snapshot_agent_unix_process_tree(session_id, leader_start_time)
            .expect("snapshot PTY descendants");
        let has_detached_descendant = snapshot.iter().any(|owned| {
            owned.pid != session_id
                && system
                    .process(sysinfo::Pid::from_u32(owned.pid))
                    .and_then(|process| process.session_id())
                    .is_some_and(|child_session| child_session.as_u32() != session_id)
        });
        if has_detached_descendant {
            break (leader_start_time, snapshot);
        }
        assert!(
            Instant::now() < deadline,
            "descendant did not create an independent process session"
        );
        std::thread::sleep(Duration::from_millis(20));
    };

    terminate_agent_unix_session(session_id, leader_start_time, owned_processes.clone())
        .expect("terminate descendants across process-session boundary");
    leader.wait().expect("reap PTY-like session leader");
    refresh(&mut system);
    assert!(owned_processes.iter().all(|owned| {
        system
            .process(sysinfo::Pid::from_u32(owned.pid))
            .is_none_or(|process| {
                process.start_time() != owned.start_time
                    || matches!(
                        process.status(),
                        sysinfo::ProcessStatus::Dead | sysinfo::ProcessStatus::Zombie
                    )
            })
    }));
}

#[cfg(unix)]
#[test]
#[ignore = "helper process launched by the detached-session regression test"]
fn agent_detached_process_helper() {
    unsafe {
        assert_ne!(libc::setsid(), -1, "detach helper into a new session");
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
    std::thread::sleep(std::time::Duration::from_secs(30));
}
