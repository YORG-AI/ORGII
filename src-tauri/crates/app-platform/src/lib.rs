//! Platform-specific FFI shims hoisted out of `app::infrastructure::platform`
//! so workspace crates (notably `agent_core`) can depend on them without
//! depending back on the `app` crate.
//!
//! Currently exposes only the macOS `objc_bridge` — additional sibling
//! modules (e.g. Windows DWM helpers) can be added here as the
//! modularization work progresses.

#[cfg(target_os = "macos")]
pub mod objc_bridge;

/// Windows `CREATE_NO_WINDOW` process-creation flag.
///
/// The app's GUI binary is built with `#![windows_subsystem = "windows"]`, so it
/// has no console of its own. Any *console* subprocess it spawns (git, `cmd`,
/// language servers, dependency probes, `netsh`, …) would otherwise allocate and
/// briefly flash a brand-new console window. Because some of these run on a timer
/// (git status polling) or in bursts (dependency detection), the user perceives
/// terminals that "keep coming out". Passing this flag to `CreateProcess`
/// suppresses the window without affecting captured stdout/stderr.
///
/// Exposed so callers that build a `tokio::process::Command` (whose
/// `creation_flags` is an inherent method) can reuse the same constant:
/// `#[cfg(windows)] cmd.creation_flags(app_platform::CREATE_NO_WINDOW);`
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply [`CREATE_NO_WINDOW`] to a `std::process::Command` on Windows so the
/// spawned process does not flash a console window. No-op on other platforms.
///
/// Call this right before `spawn()` / `output()` / `status()`.
pub fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};

    #[test]
    fn hide_console_leaves_the_command_runnable() {
        // On Windows this sets CREATE_NO_WINDOW; everywhere else it is a
        // no-op. Either way the command must still spawn and capture output —
        // this is the shim every subprocess in the app passes through.
        let mut command = Command::new("echo");
        command.arg("orgii").stdout(Stdio::piped());

        super::hide_console(&mut command);

        let output = command.output().expect("spawn echo");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "orgii");
    }

    #[test]
    fn hide_console_can_be_applied_more_than_once() {
        let mut command = Command::new("echo");
        command.arg("twice").stdout(Stdio::piped());

        super::hide_console(&mut command);
        super::hide_console(&mut command);

        let output = command.output().expect("spawn echo");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "twice");
    }

    #[cfg(windows)]
    #[test]
    fn create_no_window_matches_the_win32_constant() {
        assert_eq!(super::CREATE_NO_WINDOW, 0x0800_0000);
    }
}
