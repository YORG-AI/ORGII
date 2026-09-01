//! Execution of a single worktree setup shell command: process spawn, output
//! draining, and deadline enforcement (including process-group teardown).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const ROOT_WORKTREE_PATH_ENV: &str = "ROOT_WORKTREE_PATH";

pub(crate) fn run_worktree_setup_command_with_timeout(
    repo_path: &Path,
    worktree_path: &Path,
    command: &str,
    timeout: Duration,
) -> Result<(), String> {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(command);
        process
    } else {
        let mut process = Command::new("sh");
        process.arg("-c").arg(command);
        process
    };

    // Suppress the transient console window the spawned `cmd` would otherwise
    // flash on Windows (the GUI binary has no console of its own).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(crate::util::CREATE_NO_WINDOW);
    }

    process
        .current_dir(worktree_path)
        .env(ROOT_WORKTREE_PATH_ENV, repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    process.process_group(0);
    crate::util::close_inherited_fds(&mut process);

    let mut child = process.spawn().map_err(|err| {
        format!(
            "failed to run worktree setup command {:?}: {}",
            command, err
        )
    })?;
    let child_id = child.id();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child_id as i32), libc::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let mut taskkill = Command::new("taskkill");
                    taskkill.args(["/PID", &child_id.to_string(), "/T", "/F"]);
                    use std::os::windows::process::CommandExt;
                    taskkill.creation_flags(crate::util::CREATE_NO_WINDOW);
                    let _ = taskkill.output();
                }
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!(
                    "worktree setup command timed out after {}s and was terminated: {}",
                    timeout.as_secs_f64(),
                    command
                ));
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!("failed waiting for worktree setup command: {err}"));
            }
        }
    };
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    if status.success() {
        return Ok(());
    }

    Err(format!(
        "worktree setup command failed: {}\nstatus: {:?}\nstdout:\n{}\nstderr:\n{}",
        command,
        status.code(),
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ))
}
