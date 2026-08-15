//! Process utilities — timeout-aware command execution and tool detection.

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Default timeout for lint tools (seconds).
const DEFAULT_TIMEOUT_SECS: u64 = 120;

/// Longer timeout for compilation-based tools like Clippy/tsc (seconds).
pub const COMPILE_TIMEOUT_SECS: u64 = 300;

/// Spawn a `Command`, poll until it exits or the timeout fires.
/// Uses the default 120s timeout.
pub fn run_command_with_timeout(cmd: &mut Command) -> Result<Output, String> {
    run_command_with_custom_timeout(cmd, DEFAULT_TIMEOUT_SECS)
}

/// Spawn a `Command` with a custom timeout (in seconds).
/// On timeout the child is killed and an error is returned.
pub fn run_command_with_custom_timeout(
    cmd: &mut Command,
    timeout_secs: u64,
) -> Result<Output, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Suppress console window on Windows.
    app_platform::hide_console(cmd);

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("Failed to spawn process: {}", err))?;

    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|err| format!("Failed to collect output: {}", err));
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return Err(format!(
                        "Process timed out after {}s — killed",
                        timeout_secs
                    ));
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(err) => {
                let _ = child.kill();
                return Err(format!("Error waiting for process: {}", err));
            }
        }
    }
}

/// Check whether ESLint is available (local node_modules or global).
pub fn eslint_available(workspace_path: &str) -> bool {
    let local = Path::new(workspace_path)
        .join("node_modules")
        .join(".bin")
        .join("eslint");
    local.exists() || crate::command_detection::command_exists("eslint")
}
