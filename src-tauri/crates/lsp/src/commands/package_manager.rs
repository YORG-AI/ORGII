//! Package Manager Detection
//!
//! Utilities for detecting installed package managers and extracting
//! package names from install hints.

use crate::command_detection::command_exists;

#[cfg(test)]
#[path = "tests/package_manager_tests.rs"]
mod tests;

/// Package manager info for install commands
#[derive(Debug, Clone)]
pub struct PackageManagerInfo {
    pub command: &'static str,
    pub install_args: Vec<&'static str>,
}

/// Package manager uninstall info
#[derive(Debug, Clone)]
pub struct PackageManagerUninstallInfo {
    pub command: &'static str,
    pub uninstall_args: Vec<&'static str>,
}

/// Detect the install command type from an install hint
pub fn detect_install_type(install_hint: &str) -> &'static str {
    let hint_lower = install_hint.to_lowercase();
    if hint_lower.contains("npm")
        || hint_lower.contains("pnpm")
        || hint_lower.contains("yarn")
        || hint_lower.contains("bun")
    {
        "npm"
    } else if hint_lower.contains("pip") {
        "pip"
    } else if hint_lower.contains("cargo") {
        "cargo"
    } else if hint_lower.contains("rustup") {
        "rustup"
    } else if hint_lower.contains("gem") {
        "gem"
    } else if hint_lower.contains("go install") {
        "go"
    } else if hint_lower.contains("ghcup") {
        "ghcup"
    } else if hint_lower.contains("opam") {
        "opam"
    } else if hint_lower.contains("brew") {
        "brew"
    } else {
        "unknown"
    }
}

/// Detect available package manager for a tool type
pub fn detect_package_manager(tool_type: &str) -> Option<PackageManagerInfo> {
    match tool_type {
        "npm" => {
            // Check in order of preference: pnpm, npm, yarn, bun
            if command_exists("pnpm") {
                Some(PackageManagerInfo {
                    command: "pnpm",
                    install_args: vec!["add", "-g"],
                })
            } else if command_exists("npm") {
                Some(PackageManagerInfo {
                    command: "npm",
                    install_args: vec!["install", "-g"],
                })
            } else if command_exists("yarn") {
                Some(PackageManagerInfo {
                    command: "yarn",
                    install_args: vec!["global", "add"],
                })
            } else if command_exists("bun") {
                Some(PackageManagerInfo {
                    command: "bun",
                    install_args: vec!["add", "-g"],
                })
            } else {
                None
            }
        }
        "pip" => {
            if command_exists("pip3") {
                Some(PackageManagerInfo {
                    command: "pip3",
                    install_args: vec!["install"],
                })
            } else if command_exists("pip") {
                Some(PackageManagerInfo {
                    command: "pip",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        "cargo" => {
            if command_exists("cargo") {
                Some(PackageManagerInfo {
                    command: "cargo",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        "rustup" => {
            if command_exists("rustup") {
                Some(PackageManagerInfo {
                    command: "rustup",
                    install_args: vec!["component", "add"],
                })
            } else {
                None
            }
        }
        "gem" => {
            if command_exists("gem") {
                Some(PackageManagerInfo {
                    command: "gem",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        "go" => {
            if command_exists("go") {
                Some(PackageManagerInfo {
                    command: "go",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        "ghcup" => {
            if command_exists("ghcup") {
                Some(PackageManagerInfo {
                    command: "ghcup",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        "opam" => {
            if command_exists("opam") {
                Some(PackageManagerInfo {
                    command: "opam",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        "brew" => {
            if command_exists("brew") {
                Some(PackageManagerInfo {
                    command: "brew",
                    install_args: vec!["install"],
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Detect available package manager for uninstall
pub fn detect_package_manager_uninstall(tool_type: &str) -> Option<PackageManagerUninstallInfo> {
    match tool_type {
        "npm" => {
            // Check in order of preference: pnpm, npm, yarn, bun
            if command_exists("pnpm") {
                Some(PackageManagerUninstallInfo {
                    command: "pnpm",
                    uninstall_args: vec!["remove", "-g"],
                })
            } else if command_exists("npm") {
                Some(PackageManagerUninstallInfo {
                    command: "npm",
                    uninstall_args: vec!["uninstall", "-g"],
                })
            } else if command_exists("yarn") {
                Some(PackageManagerUninstallInfo {
                    command: "yarn",
                    uninstall_args: vec!["global", "remove"],
                })
            } else if command_exists("bun") {
                Some(PackageManagerUninstallInfo {
                    command: "bun",
                    uninstall_args: vec!["remove", "-g"],
                })
            } else {
                None
            }
        }
        "pip" => {
            if command_exists("pip3") {
                Some(PackageManagerUninstallInfo {
                    command: "pip3",
                    uninstall_args: vec!["uninstall", "-y"],
                })
            } else if command_exists("pip") {
                Some(PackageManagerUninstallInfo {
                    command: "pip",
                    uninstall_args: vec!["uninstall", "-y"],
                })
            } else {
                None
            }
        }
        "cargo" => {
            if command_exists("cargo") {
                Some(PackageManagerUninstallInfo {
                    command: "cargo",
                    uninstall_args: vec!["uninstall"],
                })
            } else {
                None
            }
        }
        "rustup" => {
            if command_exists("rustup") {
                Some(PackageManagerUninstallInfo {
                    command: "rustup",
                    uninstall_args: vec!["component", "remove"],
                })
            } else {
                None
            }
        }
        "gem" => {
            if command_exists("gem") {
                Some(PackageManagerUninstallInfo {
                    command: "gem",
                    uninstall_args: vec!["uninstall"],
                })
            } else {
                None
            }
        }
        "go" => {
            // Go install doesn't have a standard uninstall
            // You typically just delete the binary from GOPATH/bin
            None
        }
        "ghcup" => {
            if command_exists("ghcup") {
                Some(PackageManagerUninstallInfo {
                    command: "ghcup",
                    uninstall_args: vec!["rm"],
                })
            } else {
                None
            }
        }
        "opam" => {
            if command_exists("opam") {
                Some(PackageManagerUninstallInfo {
                    command: "opam",
                    uninstall_args: vec!["remove"],
                })
            } else {
                None
            }
        }
        "brew" => {
            if command_exists("brew") {
                Some(PackageManagerUninstallInfo {
                    command: "brew",
                    uninstall_args: vec!["uninstall"],
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Extract package names from install hint
/// Supports multiple packages, e.g.:
///   "npm install -g typescript-language-server typescript" -> "typescript-language-server typescript"
///   "pip install pyright" -> "pyright"
pub fn extract_package_name(install_hint: &str) -> Option<String> {
    let hint_lower = install_hint.to_lowercase();
    let words: Vec<&str> = install_hint.split_whitespace().collect();

    // Find the index after all command/flag words, remaining words are package names
    if hint_lower.contains("npm")
        || hint_lower.contains("pnpm")
        || hint_lower.contains("yarn")
        || hint_lower.contains("bun")
    {
        // npm install -g <packages...> / pnpm add -g <packages...> / yarn global add <packages...>
        // Find position after the last flag (e.g., "-g")
        let pkg_start = words
            .iter()
            .rposition(|w| w.starts_with('-'))
            .map(|i| i + 1)
            .or_else(|| {
                // yarn global add <pkg> - find "add" position
                words
                    .iter()
                    .position(|w| *w == "add" || *w == "install" || *w == "i")
                    .map(|i| i + 1)
            })
            .unwrap_or(words.len());
        let packages: Vec<&str> = words[pkg_start..].to_vec();
        if packages.is_empty() {
            None
        } else {
            Some(packages.join(" "))
        }
    } else if hint_lower.contains("rustup component add") {
        extract_after_keyword(&words, "add")
    } else if hint_lower.contains("pip")
        || hint_lower.contains("cargo install")
        || hint_lower.contains("gem install")
        || hint_lower.contains("go install")
        || hint_lower.contains("ghcup install")
        || hint_lower.contains("opam install")
        || hint_lower.contains("brew install")
    {
        extract_after_install(&words)
    } else {
        None
    }
}

/// Helper: extract packages after "install" keyword
fn extract_after_install(words: &[&str]) -> Option<String> {
    extract_after_keyword(words, "install")
}

/// Helper: extract packages after a specific keyword
fn extract_after_keyword(words: &[&str], keyword: &str) -> Option<String> {
    let pkg_start = words
        .iter()
        .position(|w| *w == keyword)
        .map(|i| i + 1)
        .unwrap_or(words.len());
    let packages: Vec<&str> = words[pkg_start..].to_vec();
    if packages.is_empty() {
        None
    } else {
        Some(packages.join(" "))
    }
}
