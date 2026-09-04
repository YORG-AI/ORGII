//! Platform-specific inspection of a live shell: foreground process discovery
//! and current working directory resolution.

use super::types::ForegroundProcessInfo;

// ============================================
// Platform-specific process inspection
// ============================================

/// Get information about the foreground process in a terminal session.
pub(super) fn get_foreground_process_info(shell_pid: u32) -> Result<ForegroundProcessInfo, String> {
    #[cfg(target_os = "macos")]
    {
        get_foreground_process_macos(shell_pid)
    }
    #[cfg(target_os = "linux")]
    {
        get_foreground_process_linux(shell_pid)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = shell_pid;
        Ok(ForegroundProcessInfo {
            process_name: None,
            pid: None,
            cwd: None,
        })
    }
}

#[cfg(target_os = "macos")]
fn get_foreground_process_macos(shell_pid: u32) -> Result<ForegroundProcessInfo, String> {
    use std::process::Command;

    // Get child processes of the shell — the most recently spawned is the foreground
    let output = Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map_err(|err| format!("pgrep failed: {}", err))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let child_pids: Vec<u32> = stdout
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();

    // If no children, the shell itself is the foreground process
    let fg_pid = child_pids.last().copied().unwrap_or(shell_pid);

    let process_name = get_process_name_ps(fg_pid);
    let cwd = get_process_cwd(fg_pid).ok().flatten();

    Ok(ForegroundProcessInfo {
        process_name,
        pid: Some(fg_pid),
        cwd,
    })
}

#[cfg(target_os = "linux")]
fn get_foreground_process_linux(shell_pid: u32) -> Result<ForegroundProcessInfo, String> {
    // Read /proc/{pid}/stat to get the foreground process group (field 8, tpgid)
    let stat_path = format!("/proc/{}/stat", shell_pid);
    let stat_content = std::fs::read_to_string(&stat_path)
        .map_err(|err| format!("Failed to read {}: {}", stat_path, err))?;

    let fg_pid = parse_tpgid_from_stat(&stat_content).unwrap_or(shell_pid);

    let process_name = std::fs::read_to_string(format!("/proc/{}/comm", fg_pid))
        .ok()
        .map(|name| name.trim().to_string());

    let cwd = get_process_cwd(fg_pid).ok().flatten();

    Ok(ForegroundProcessInfo {
        process_name,
        pid: Some(fg_pid),
        cwd,
    })
}

/// Parse the tpgid (terminal foreground process group ID) from /proc/{pid}/stat.
/// Field 8 (0-indexed: 7) is tpgid. Fields are space-separated but field 2 (comm)
/// is wrapped in parentheses and may contain spaces.
#[cfg(target_os = "linux")]
fn parse_tpgid_from_stat(stat_content: &str) -> Option<u32> {
    // Skip past the comm field which is in parentheses
    let after_comm = stat_content.rfind(')')?;
    let fields_after_comm: Vec<&str> = stat_content[after_comm + 2..].split_whitespace().collect();
    // After `)`, fields are: state(0), ppid(1), pgrp(2), session(3), tty_nr(4), tpgid(5)
    fields_after_comm.get(5)?.parse::<u32>().ok()
}

/// Get process name via `ps` command (portable across macOS/Linux).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn get_process_name_ps(pid: u32) -> Option<String> {
    use std::process::Command;
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        // Strip path prefix — ps may return "/usr/local/bin/node"
        Some(name.rsplit('/').next().unwrap_or(&name).to_string())
    }
}

/// Get the current working directory of a process.
pub(super) fn get_process_cwd(pid: u32) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("lsof")
            .args(["-p", &pid.to_string(), "-Fn", "-d", "cwd"])
            .output()
            .map_err(|err| format!("lsof failed: {}", err))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // lsof -Fn outputs lines like "p12345\nn/path/to/cwd"
        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix('n') {
                if path != "/" && !path.is_empty() {
                    return Ok(Some(path.to_string()));
                }
            }
        }
        Ok(None)
    }
    #[cfg(target_os = "linux")]
    {
        let link = format!("/proc/{}/cwd", pid);
        match std::fs::read_link(&link) {
            Ok(path) => Ok(Some(path.to_string_lossy().to_string())),
            Err(_) => Ok(None),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = pid;
        Ok(None)
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[cfg(target_os = "linux")]
    mod parse_tpgid_tests {
        use super::super::parse_tpgid_from_stat;

        #[test]
        fn parses_standard_stat() {
            // pid (comm) state ppid pgrp session tty_nr tpgid ...
            let stat = "12345 (bash) S 1 12345 12345 34816 12400 4194304";
            assert_eq!(parse_tpgid_from_stat(stat), Some(12400));
        }

        #[test]
        fn parses_comm_with_spaces() {
            let stat = "12345 (my shell) S 1 12345 12345 34816 99999 4194304";
            assert_eq!(parse_tpgid_from_stat(stat), Some(99999));
        }

        #[test]
        fn rejects_invalid_stat() {
            assert_eq!(parse_tpgid_from_stat("garbage"), None);
            assert_eq!(parse_tpgid_from_stat(""), None);
        }
    }
}
