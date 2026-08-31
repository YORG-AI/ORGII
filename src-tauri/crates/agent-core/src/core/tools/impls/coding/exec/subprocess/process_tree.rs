//! Platform-specific subprocess-tree termination.

use std::time::Duration;

use tracing::warn;

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) -> std::io::Result<()> {
    let group_result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if group_result == 0 {
        return Ok(());
    }
    let group_error = std::io::Error::last_os_error();
    if unsafe { libc::kill(pid as libc::pid_t, signal) } == 0 {
        return Ok(());
    }
    let process_error = std::io::Error::last_os_error();
    if group_error.raw_os_error() == Some(libc::ESRCH) {
        Err(process_error)
    } else {
        Err(group_error)
    }
}

#[cfg(unix)]
pub(super) async fn terminate_child_tree(pid: u32, child: &mut tokio::process::Child) {
    if pid != 0 {
        if let Err(err) = signal_process_group(pid, libc::SIGTERM) {
            if err.raw_os_error() != Some(libc::ESRCH) {
                warn!("[subprocess] failed to SIGTERM process group {pid}: {err}");
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Err(err) = signal_process_group(pid, libc::SIGKILL) {
            if err.raw_os_error() != Some(libc::ESRCH) {
                warn!("[subprocess] failed to SIGKILL process group {pid}: {err}");
            }
        }
    }
    if let Err(err) = child.kill().await {
        if err.kind() != std::io::ErrorKind::InvalidInput {
            warn!("[subprocess] failed to kill child process: {err}");
        }
    }
}

#[cfg(windows)]
pub(super) async fn terminate_child_tree(_pid: u32, child: &mut tokio::process::Child) {
    if let Err(err) = child.kill().await {
        warn!("[subprocess] failed to kill child process: {err}");
    }
}
