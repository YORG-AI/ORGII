//! Shell detection and profile system.
//!
//! Detects available shells on the system and returns typed profiles
//! for the frontend to display in a shell picker dropdown.

use serde::{Deserialize, Serialize};

// ============================================
// Types
// ============================================

/// Categorized shell kind, matching VS Code's shell type taxonomy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Sh,
    Csh,
    Ksh,
    Pwsh,
    Cmd,
    Node,
    Python,
    Ruby,
    Nushell,
    Xonsh,
    Unknown,
}

impl ShellKind {
    /// Classify a shell path or name into a `ShellKind`.
    pub fn from_shell_path(path: &str) -> Self {
        let basename = path.rsplit('/').next().unwrap_or(path);
        classify_shell_name(basename)
    }

    /// Default arguments for this shell kind in interactive mode.
    pub fn default_args(&self) -> Vec<String> {
        match self {
            ShellKind::Zsh => vec!["-il".to_string()],
            ShellKind::Bash => vec!["--login".to_string()],
            ShellKind::Fish => vec!["-il".to_string()],
            ShellKind::Sh => vec!["-il".to_string()],
            ShellKind::Csh | ShellKind::Ksh => vec!["-l".to_string()],
            ShellKind::Pwsh => vec!["-NoLogo".to_string()],
            ShellKind::Cmd => vec![],
            ShellKind::Node => vec!["--interactive".to_string()],
            ShellKind::Python => vec!["-i".to_string()],
            ShellKind::Ruby => vec!["-e".to_string(), "require 'irb'; IRB.start".to_string()],
            ShellKind::Nushell => vec!["-il".to_string()],
            ShellKind::Xonsh => vec![],
            ShellKind::Unknown => vec![],
        }
    }

    /// Shell category for UI grouping.
    pub fn category(&self) -> ShellCategory {
        match self {
            ShellKind::Zsh
            | ShellKind::Bash
            | ShellKind::Fish
            | ShellKind::Sh
            | ShellKind::Csh
            | ShellKind::Ksh
            | ShellKind::Nushell => ShellCategory::Shell,
            ShellKind::Pwsh | ShellKind::Cmd => ShellCategory::Shell,
            ShellKind::Node | ShellKind::Python | ShellKind::Ruby | ShellKind::Xonsh => {
                ShellCategory::Repl
            }
            ShellKind::Unknown => ShellCategory::Shell,
        }
    }
}

/// UI grouping category for shell profiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellCategory {
    Shell,
    Repl,
}

/// A detected shell available on the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedShell {
    /// Display name (e.g., "zsh", "Fish", "Node.js")
    pub name: String,
    /// Absolute path to the shell executable
    pub path: String,
    /// Classified shell kind
    pub kind: ShellKind,
    /// UI grouping category
    pub category: ShellCategory,
    /// Default arguments for interactive mode
    pub default_args: Vec<String>,
    /// Whether this is the system default shell ($SHELL)
    pub is_default: bool,
}

// ============================================
// Detection Logic
// ============================================

/// Detect all available shells on the system.
///
/// On Unix, parses `/etc/shells` and probes for REPL shells (node, python, etc.).
/// On Windows, checks common shell installation paths.
pub fn detect_shells() -> Vec<DetectedShell> {
    // $SHELL is Unix-only; on Windows use COMSPEC
    #[cfg(unix)]
    let default_shell = std::env::var("SHELL").unwrap_or_default();
    #[cfg(windows)]
    let default_shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

    let mut shells = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        // Parse /etc/shells for system-registered shells. On macOS / Linux
        // this file is always present; a read failure typically means a
        // permission flip or a chrooted environment. Silently producing
        // "no detected shells" would make the terminal launcher fall back
        // to an empty list with no hint why — warn so the cause surfaces.
        let etc_shells_content = match std::fs::read_to_string("/etc/shells") {
            Ok(c) => Some(c),
            Err(err) => {
                if err.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        error = %err,
                        "terminal::shells: /etc/shells read failed; system-registered shells will be missing from the launcher"
                    );
                }
                None
            }
        };
        if let Some(content) = etc_shells_content {
            for entry in parse_etc_shells(&content) {
                let kind = ShellKind::from_shell_path(&entry);
                let is_default = entry == default_shell;
                let basename = entry.rsplit('/').next().unwrap_or(&entry);
                shells.push(DetectedShell {
                    name: basename.to_string(),
                    path: entry,
                    category: kind.category(),
                    default_args: kind.default_args(),
                    kind,
                    is_default,
                });
            }
        }

        // Probe for REPL shells not in /etc/shells
        for (probe_name, kind) in REPL_PROBES {
            if shells.iter().any(|shell| shell.kind == *kind) {
                continue;
            }
            if let Some(path) = which_executable(probe_name) {
                shells.push(DetectedShell {
                    name: display_name_for_kind(kind),
                    path,
                    category: kind.category(),
                    default_args: kind.default_args(),
                    kind: kind.clone(),
                    is_default: false,
                });
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = default_shell;
        shells.push(DetectedShell {
            name: "PowerShell".to_string(),
            path: "powershell.exe".to_string(),
            kind: ShellKind::Pwsh,
            category: ShellCategory::Shell,
            default_args: ShellKind::Pwsh.default_args(),
            is_default: true,
        });
        shells.push(DetectedShell {
            name: "Command Prompt".to_string(),
            path: "cmd.exe".to_string(),
            kind: ShellKind::Cmd,
            category: ShellCategory::Shell,
            default_args: ShellKind::Cmd.default_args(),
            is_default: false,
        });
        for (probe_name, kind) in REPL_PROBES {
            if let Some(path) = which_executable(probe_name) {
                shells.push(DetectedShell {
                    name: display_name_for_kind(kind),
                    path,
                    category: kind.category(),
                    default_args: kind.default_args(),
                    kind: kind.clone(),
                    is_default: false,
                });
            }
        }
    }

    // Deduplicate by resolved path
    dedup_shells(&mut shells);

    // Sort: default first, then shells before REPLs, then alphabetical
    shells.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then(left.category.cmp(&right.category))
            .then(left.name.cmp(&right.name))
    });

    shells
}

// ============================================
// Tauri Command
// ============================================

/// Detect available shells on the system and return typed profiles.
#[tauri::command]
pub async fn detect_available_shells() -> Result<Vec<DetectedShell>, String> {
    tokio::task::spawn_blocking(detect_shells)
        .await
        .map_err(|err| format!("Task join error: {}", err))
}

// ============================================
// Helpers (public for testing)
// ============================================

/// Shells to probe via `which` that typically aren't in /etc/shells.
const REPL_PROBES: &[(&str, ShellKind)] = &[
    ("node", ShellKind::Node),
    ("python3", ShellKind::Python),
    ("ruby", ShellKind::Ruby),
    ("nu", ShellKind::Nushell),
    ("fish", ShellKind::Fish),
    ("xonsh", ShellKind::Xonsh),
];

/// Parse `/etc/shells` content into a list of shell paths.
/// Skips comments and blank lines.
pub fn parse_etc_shells(content: &str) -> Vec<String> {
    content
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        // `/etc/shells` is a POSIX file format even when this pure parser is
        // exercised from a Windows test host. `Path::is_absolute()` applies
        // the host platform's rules and rejects valid entries such as
        // `/bin/bash` on Windows, so validate the format itself instead.
        .filter(|line| line.starts_with('/'))
        .map(|line| line.to_string())
        .collect()
}

/// Classify a shell basename (e.g., "zsh", "bash", "python3") into a `ShellKind`.
pub fn classify_shell_name(name: &str) -> ShellKind {
    let lower = name.to_lowercase();
    // Strip version suffixes like "python3.11", "ruby3.2"
    let base = lower.trim_end_matches(|ch: char| ch.is_ascii_digit() || ch == '.');

    match base {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "fish" => ShellKind::Fish,
        "sh" | "dash" | "ash" => ShellKind::Sh,
        "csh" | "tcsh" => ShellKind::Csh,
        "ksh" | "mksh" | "pdksh" => ShellKind::Ksh,
        "pwsh" | "powershell" => ShellKind::Pwsh,
        "cmd" => ShellKind::Cmd,
        "node" | "nodejs" => ShellKind::Node,
        "python" => ShellKind::Python,
        "ruby" | "irb" => ShellKind::Ruby,
        "nu" | "nushell" => ShellKind::Nushell,
        "xonsh" => ShellKind::Xonsh,
        _ => ShellKind::Unknown,
    }
}

/// Look up an executable by name using `which` (Unix) or `where` (Windows).
fn which_executable(name: &str) -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    let cmd = "which";
    #[cfg(target_os = "windows")]
    let cmd = "where";

    let mut command = std::process::Command::new(cmd);
    command.arg(name);
    // Suppress console window on Windows.
    app_platform::hide_console(&mut command);
    command.output().ok().and_then(|output| {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()?
                .trim()
                .to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        } else {
            None
        }
    })
}

/// Human-readable display name for a shell kind.
fn display_name_for_kind(kind: &ShellKind) -> String {
    match kind {
        ShellKind::Zsh => "zsh".to_string(),
        ShellKind::Bash => "bash".to_string(),
        ShellKind::Fish => "fish".to_string(),
        ShellKind::Sh => "sh".to_string(),
        ShellKind::Csh => "csh".to_string(),
        ShellKind::Ksh => "ksh".to_string(),
        ShellKind::Pwsh => "PowerShell".to_string(),
        ShellKind::Cmd => "Command Prompt".to_string(),
        ShellKind::Node => "Node.js".to_string(),
        ShellKind::Python => "Python".to_string(),
        ShellKind::Ruby => "Ruby".to_string(),
        ShellKind::Nushell => "Nushell".to_string(),
        ShellKind::Xonsh => "xonsh".to_string(),
        ShellKind::Unknown => "Unknown".to_string(),
    }
}

/// Deduplicate shells by resolved path, keeping the first occurrence.
fn dedup_shells(shells: &mut Vec<DetectedShell>) {
    let mut seen_paths = std::collections::HashSet::new();
    shells.retain(|shell| {
        let resolved = std::fs::canonicalize(&shell.path)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| shell.path.clone());
        seen_paths.insert(resolved)
    });
}

// Derive PartialOrd/Ord for ShellCategory so we can sort by it
impl PartialOrd for ShellCategory {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ShellCategory {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let rank = |cat: &ShellCategory| -> u8 {
            match cat {
                ShellCategory::Shell => 0,
                ShellCategory::Repl => 1,
            }
        };
        rank(self).cmp(&rank(other))
    }
}

impl std::hash::Hash for ShellCategory {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        let rank: u8 = match self {
            ShellCategory::Shell => 0,
            ShellCategory::Repl => 1,
        };
        rank.hash(state);
    }
}

#[cfg(test)]
#[path = "tests/shells_tests.rs"]
mod tests;
