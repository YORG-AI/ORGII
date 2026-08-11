use std::process::Command;

/// Check whether a command-line tool is available on the system PATH.
///
/// Forward PATH explicitly so app startup code that augments the process
/// environment is reflected consistently across every LSP discovery surface.
pub fn command_exists(command_name: &str) -> bool {
    let current_path = std::env::var_os("PATH");

    #[cfg(unix)]
    let mut command = {
        let mut command = Command::new("which");
        command.arg(command_name);
        command
    };

    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("where");
        command.arg(command_name);
        command
    };

    if let Some(path) = current_path {
        command.env("PATH", path);
    }
    app_platform::hide_console(&mut command);
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_platform_shell() {
        #[cfg(unix)]
        assert!(command_exists("sh"));

        #[cfg(windows)]
        assert!(command_exists("cmd"));
    }

    #[test]
    fn rejects_a_missing_command() {
        assert!(!command_exists(
            "orgii-command-detection-test-definitely-missing"
        ));
    }
}
