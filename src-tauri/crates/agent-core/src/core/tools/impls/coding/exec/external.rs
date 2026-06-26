use std::path::Path;
use std::process::Command;

use crate::tools::traits::ToolError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalTarget {
    Integrated,
    External,
}

impl TerminalTarget {
    pub fn parse(value: Option<&str>) -> Result<Self, ToolError> {
        match value {
            None | Some("integrated") => Ok(Self::Integrated),
            Some("external") => Ok(Self::External),
            Some(other) => Err(ToolError::InvalidParams(format!(
                "Unknown terminal_target \"{}\". Valid values: integrated, external.",
                other
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExternalTerminalLaunch {
    pub terminal_app: String,
    pub automation_error: Option<String>,
}

pub fn launch(command: &str, working_dir: &Path) -> Result<ExternalTerminalLaunch, ToolError> {
    launch_for_platform(command, working_dir)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_with_cd(command: &str, working_dir: &Path) -> String {
    format!(
        "cd {} && {}",
        shell_single_quote(&working_dir.to_string_lossy()),
        command
    )
}

#[cfg(target_os = "macos")]
fn launch_for_platform(
    command: &str,
    working_dir: &Path,
) -> Result<ExternalTerminalLaunch, ToolError> {
    let command = command_with_cd(command, working_dir);
    let output = Command::new("osascript")
        .arg("-e")
        .arg("tell application \"Terminal\"")
        .arg("-e")
        .arg("activate")
        .arg("-e")
        .arg(format!(
            "do script {}",
            apple_script_string_literal(&command)
        ))
        .arg("-e")
        .arg("end tell")
        .output()
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to launch Terminal.app: {err}"))
        })?;

    if output.status.success() {
        return Ok(ExternalTerminalLaunch {
            terminal_app: "Terminal.app".to_string(),
            automation_error: None,
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = if stderr.contains("Not authorized")
        || stderr.contains("not authorized")
        || stderr.contains("Operation not permitted")
        || stderr.contains("-1743")
    {
        format!(
            "Terminal.app automation was denied. Allow ORGII to control Terminal in macOS System Settings → Privacy & Security → Automation, then try again.{}",
            if stderr.is_empty() {
                String::new()
            } else {
                format!("\nAutomation error: {stderr}")
            }
        )
    } else if stderr.is_empty() {
        "Terminal.app automation failed without stderr.".to_string()
    } else {
        stderr
    };

    Err(ToolError::ExecutionFailed(message))
}

#[cfg(target_os = "macos")]
fn apple_script_string_literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(target_os = "linux")]
fn launch_for_platform(
    command: &str,
    working_dir: &Path,
) -> Result<ExternalTerminalLaunch, ToolError> {
    let shell_command = command_with_cd(command, working_dir);
    let candidates: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--", "sh", "-lc"]),
        ("konsole", &["-e", "sh", "-lc"]),
        ("kitty", &["sh", "-lc"]),
        ("alacritty", &["-e", "sh", "-lc"]),
        ("wezterm", &["start", "--", "sh", "-lc"]),
        ("xfce4-terminal", &["--command"]),
        ("xterm", &["-e", "sh", "-lc"]),
    ];

    for (app, args) in candidates {
        if !command_exists(app) {
            continue;
        }

        let mut cmd = Command::new(app);
        for arg in *args {
            cmd.arg(arg);
        }
        if *app == "xfce4-terminal" {
            cmd.arg(format!("sh -lc {}", shell_single_quote(&shell_command)));
        } else {
            cmd.arg(&shell_command);
        }

        match cmd.spawn() {
            Ok(_) => {
                return Ok(ExternalTerminalLaunch {
                    terminal_app: (*app).to_string(),
                    automation_error: None,
                })
            }
            Err(_) => continue,
        }
    }

    Err(ToolError::ExecutionFailed(
        "No supported external terminal emulator was found. Tried gnome-terminal, konsole, kitty, alacritty, wezterm, xfce4-terminal, and xterm.".to_string(),
    ))
}

#[cfg(target_os = "windows")]
fn launch_for_platform(
    command: &str,
    working_dir: &Path,
) -> Result<ExternalTerminalLaunch, ToolError> {
    let work_dir = working_dir.to_string_lossy().to_string();
    let powershell_command = format!(
        "Set-Location -LiteralPath {}; {}",
        powershell_single_quote(&work_dir),
        command
    );

    if command_exists("wt") {
        let status = Command::new("wt")
            .arg("powershell")
            .arg("-NoExit")
            .arg("-Command")
            .arg(&powershell_command)
            .spawn();
        if status.is_ok() {
            return Ok(ExternalTerminalLaunch {
                terminal_app: "Windows Terminal".to_string(),
                automation_error: None,
            });
        }
    }

    let status = Command::new("powershell")
        .arg("-NoExit")
        .arg("-Command")
        .arg(&powershell_command)
        .spawn();
    if status.is_ok() {
        return Ok(ExternalTerminalLaunch {
            terminal_app: "PowerShell".to_string(),
            automation_error: None,
        });
    }

    Command::new("cmd")
        .arg("/K")
        .arg(format!("cd /d {} && {}", cmd_quote(&work_dir), command))
        .spawn()
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to launch external terminal: {err}"))
        })?;

    Ok(ExternalTerminalLaunch {
        terminal_app: "cmd.exe".to_string(),
        automation_error: None,
    })
}

#[cfg(target_os = "windows")]
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
fn cmd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn launch_for_platform(
    _command: &str,
    _working_dir: &Path,
) -> Result<ExternalTerminalLaunch, ToolError> {
    Err(ToolError::ExecutionFailed(
        "External terminal launch is not supported on this OS.".to_string(),
    ))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn command_exists(command: &str) -> bool {
    which::which(command).is_ok()
}

pub fn format_launch_result(command: &str, launch: &ExternalTerminalLaunch) -> String {
    let automation_error = launch.automation_error.as_deref().unwrap_or("none");
    format!(
        "external_terminal_launched: true\nterminal_app: {}\ncommand_sent: {}\nautomation_error: {}\noutput_capture: unavailable (external terminal execution does not provide stdout/stderr capture; watch the opened terminal window for output)",
        launch.terminal_app, command, automation_error
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn shell_single_quote_escapes_single_quotes() {
        assert_eq!(shell_single_quote("a'b"), "'a'\\''b'");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_script_literal_escapes_quotes_and_backslashes() {
        assert_eq!(apple_script_string_literal("a\\b\"c"), "\"a\\\\b\\\"c\"");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_single_quote_doubles_single_quotes() {
        assert_eq!(powershell_single_quote("a'b"), "'a''b'");
    }
}
