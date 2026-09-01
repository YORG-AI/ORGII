//! Bounded shutdown of the spawned Codex app-server and its wrapper descendants.

use super::app_server::APP_SERVER_SHUTDOWN_TIMEOUT_SECS;
use tokio::process::Child;

pub(super) async fn terminate_codex_app_server_tree(
    child: &mut Child,
    child_pid: Option<u32>,
    operation: &str,
) {
    #[cfg(unix)]
    if let Some(pid) = child_pid {
        // SAFETY: this child was spawned as the leader of a dedicated process
        // group. Sending SIGKILL does not touch Rust-managed memory.
        let status = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
        if status != 0 {
            log::debug!(
                "[CodexAppServer] Failed to kill process group after {}: {}",
                operation,
                std::io::Error::last_os_error()
            );
        }
    }

    #[cfg(windows)]
    if let Some(pid) = child_pid {
        // The npm `cmd.exe` shim can exit before cleanup while node.exe and the
        // native Codex binary keep its pipe handles open. A Toolhelp snapshot
        // retains their original parent PIDs, so it can still find that orphaned
        // tree after the wrapper is gone; `taskkill /T` cannot.
        match tokio::time::timeout(
            std::time::Duration::from_secs(APP_SERVER_SHUTDOWN_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || terminate_windows_process_tree(pid)),
        )
        .await
        {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(err))) => log::warn!(
                "[CodexAppServer] Failed to terminate Windows process tree after {}: {}",
                operation,
                err
            ),
            Ok(Err(err)) => log::warn!(
                "[CodexAppServer] Windows process cleanup task failed after {}: {}",
                operation,
                err
            ),
            Err(_) => log::warn!(
                "[CodexAppServer] Windows process cleanup timed out after {}",
                operation
            ),
        }
    }

    if let Err(err) = child.start_kill() {
        log::debug!(
            "[CodexAppServer] Direct child already stopped after {}: {}",
            operation,
            err
        );
    }
    if tokio::time::timeout(
        std::time::Duration::from_secs(APP_SERVER_SHUTDOWN_TIMEOUT_SECS),
        child.wait(),
    )
    .await
    .is_err()
    {
        log::warn!(
            "[CodexAppServer] Direct child did not exit after {} within {}s",
            operation,
            APP_SERVER_SHUTDOWN_TIMEOUT_SECS
        );
    }
}

#[cfg(windows)]
fn terminate_windows_process_tree(root_pid: u32) -> Result<(), String> {
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    const MAX_SNAPSHOT_PROCESSES: usize = 8_192;
    const MAX_TREE_PROCESSES: usize = 32;

    // SAFETY: the returned snapshot handle is checked and closed on every path.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "CreateToolhelp32Snapshot failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut processes = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` has the required size and remains valid while the snapshot
    // is enumerated.
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while has_entry {
        if processes.len() >= MAX_SNAPSHOT_PROCESSES {
            // SAFETY: `snapshot` is a valid handle owned by this function.
            unsafe { CloseHandle(snapshot) };
            return Err(format!(
                "process snapshot exceeded {MAX_SNAPSHOT_PROCESSES} entries"
            ));
        }
        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: same initialized entry and valid snapshot as above.
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: `snapshot` is a valid handle owned by this function.
    unsafe { CloseHandle(snapshot) };

    // Seed the traversal with the captured wrapper PID even when the wrapper has
    // already exited and is absent from the snapshot.
    let mut known = HashSet::from([root_pid]);
    let mut frontier = HashSet::from([root_pid]);
    let mut descendants = Vec::new();
    let mut depth = 0usize;
    while !frontier.is_empty() {
        let mut next_frontier = HashSet::new();
        for &(pid, parent_pid) in &processes {
            if frontier.contains(&parent_pid) && known.insert(pid) {
                if descendants.len() >= MAX_TREE_PROCESSES {
                    return Err(format!(
                        "process tree rooted at {root_pid} exceeded {MAX_TREE_PROCESSES} entries"
                    ));
                }
                descendants.push((pid, depth + 1));
                next_frontier.insert(pid);
            }
        }
        frontier = next_frontier;
        depth += 1;
    }

    descendants.sort_unstable_by_key(|&(_, process_depth)| std::cmp::Reverse(process_depth));
    for (pid, _) in descendants {
        // SAFETY: the handle is checked before use and closed after termination.
        let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            continue;
        }
        // The process may exit between snapshot enumeration and this call. That
        // is already the desired state, so termination failures are non-fatal.
        unsafe {
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    #[cfg(unix)]
    #[tokio::test]
    async fn app_server_shutdown_terminates_wrapper_descendants() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 60 & helper=$!; echo $helper; wait"])
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn wrapper process");
        let child_pid = child.id();
        let stdout = child.stdout.take().expect("wrapper stdout");
        let mut reader = BufReader::new(stdout).lines();
        let helper_pid: i32 = reader
            .next_line()
            .await
            .expect("read helper pid")
            .expect("helper pid line")
            .trim()
            .parse()
            .expect("numeric helper pid");

        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            terminate_codex_app_server_tree(&mut child, child_pid, "test shutdown"),
        )
        .await
        .expect("bounded wrapper shutdown");

        let mut helper_alive = true;
        for _ in 0..20 {
            // SAFETY: signal 0 performs an existence check only.
            helper_alive = unsafe { libc::kill(helper_pid, 0) == 0 };
            if !helper_alive {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(!helper_alive, "descendant process {helper_pid} survived");
    }

    #[cfg(windows)]
    async fn windows_process_is_alive(pid: u32) -> bool {
        let script = format!(
            "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(app_platform::CREATE_NO_WINDOW);
        command
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn app_server_shutdown_terminates_windows_wrapper_descendants() {
        let script = r#"
$pingPath = Join-Path $env:SystemRoot 'System32\ping.exe'
$descendant = Start-Process -FilePath $pingPath -ArgumentList '-t','127.0.0.1' -NoNewWindow -PassThru
[Console]::Out.WriteLine($descendant.Id)
[Console]::Out.Flush()
"#;
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(app_platform::CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn Windows wrapper process");
        let child_pid = child.id();
        let stdout = child.stdout.take().expect("wrapper stdout");
        let mut reader = BufReader::new(stdout).lines();
        let descendant_pid: u32 = reader
            .next_line()
            .await
            .expect("read descendant pid")
            .expect("descendant pid line")
            .trim()
            .parse()
            .expect("numeric descendant pid");
        assert!(windows_process_is_alive(descendant_pid).await);

        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("wrapper wait stayed bounded")
            .expect("wrapper exited");
        assert!(
            windows_process_is_alive(descendant_pid).await,
            "test requires the descendant to outlive its wrapper"
        );

        tokio::time::timeout(
            std::time::Duration::from_secs(8),
            terminate_codex_app_server_tree(&mut child, child_pid, "test shutdown"),
        )
        .await
        .expect("bounded Windows wrapper shutdown");

        let mut descendant_alive = true;
        for _ in 0..20 {
            descendant_alive = windows_process_is_alive(descendant_pid).await;
            if !descendant_alive {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if descendant_alive {
            let _ = Command::new("taskkill")
                .args(["/PID", &descendant_pid.to_string(), "/T", "/F"])
                .creation_flags(app_platform::CREATE_NO_WINDOW)
                .output()
                .await;
        }
        assert!(
            !descendant_alive,
            "descendant process {descendant_pid} survived"
        );
    }
}
