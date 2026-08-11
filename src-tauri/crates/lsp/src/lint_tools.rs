//! Lint Tools Detection
//!
//! Detects installed lint and formatting tools across various languages.

use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::command_detection::command_exists;

/// Information about a lint tool
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LintToolInfo {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
    pub install_hint: String,
    pub installed: bool,
    pub version: Option<String>,
    pub uninstall_supported: bool,
    /// The package manager binary required to install this tool (e.g. "npm", "pip3", "brew").
    pub requires_binary: Option<String>,
    /// Whether the required binary is available on the system (from cached dependency scan).
    pub prerequisite_met: bool,
}

/// Check if uninstall is supported based on install hint
fn is_uninstall_supported(install_hint: &str) -> bool {
    let hint_lower = install_hint.to_lowercase();
    // These package managers support uninstall
    if hint_lower.contains("npm")
        || hint_lower.contains("pnpm")
        || hint_lower.contains("yarn")
        || hint_lower.contains("bun")
    {
        return true;
    }
    if hint_lower.contains("pip") {
        return true;
    }
    if hint_lower.contains("cargo") {
        return true;
    }
    if hint_lower.contains("rustup") {
        return true;
    }
    if hint_lower.contains("gem") {
        return true;
    }
    if hint_lower.contains("brew") {
        return true;
    }
    if hint_lower.contains("ghcup") {
        return true;
    }
    if hint_lower.contains("opam") {
        return true;
    }
    // "go install", "Included with", etc. are NOT supported
    false
}

/// Lint tool configuration
struct LintToolConfig {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    version_arg: &'static str,
    languages: &'static [&'static str],
    install_hint: &'static str,
}

/// All supported lint tools
const LINT_TOOLS: &[LintToolConfig] = &[
    LintToolConfig {
        id: "eslint",
        name: "ESLint",
        command: "eslint",
        version_arg: "--version",
        languages: &["javascript", "typescript"],
        install_hint: "npm install -g eslint",
    },
    LintToolConfig {
        id: "prettier",
        name: "Prettier",
        command: "prettier",
        version_arg: "--version",
        languages: &[
            "javascript",
            "typescript",
            "css",
            "html",
            "json",
            "markdown",
        ],
        install_hint: "npm install -g prettier",
    },
    LintToolConfig {
        id: "stylelint",
        name: "Stylelint",
        command: "stylelint",
        version_arg: "--version",
        languages: &["css", "scss", "less"],
        install_hint: "npm install -g stylelint",
    },
    LintToolConfig {
        id: "biome",
        name: "Biome",
        command: "biome",
        version_arg: "--version",
        languages: &["javascript", "typescript", "json"],
        install_hint: "npm install -g @biomejs/biome",
    },
    LintToolConfig {
        id: "tsc",
        name: "TypeScript Compiler",
        command: "tsc",
        version_arg: "--version",
        languages: &["typescript"],
        install_hint: "npm install -g typescript",
    },
    LintToolConfig {
        id: "ruff",
        name: "Ruff",
        command: "ruff",
        version_arg: "--version",
        languages: &["python"],
        install_hint: "pip install ruff",
    },
    LintToolConfig {
        id: "pylint",
        name: "Pylint",
        command: "pylint",
        version_arg: "--version",
        languages: &["python"],
        install_hint: "pip install pylint",
    },
    LintToolConfig {
        id: "flake8",
        name: "Flake8",
        command: "flake8",
        version_arg: "--version",
        languages: &["python"],
        install_hint: "pip install flake8",
    },
    LintToolConfig {
        id: "mypy",
        name: "Mypy",
        command: "mypy",
        version_arg: "--version",
        languages: &["python"],
        install_hint: "pip install mypy",
    },
    LintToolConfig {
        id: "black",
        name: "Black",
        command: "black",
        version_arg: "--version",
        languages: &["python"],
        install_hint: "pip install black",
    },
    LintToolConfig {
        id: "rust-analyzer",
        name: "rust-analyzer",
        command: "rust-analyzer",
        version_arg: "--version",
        languages: &["rust"],
        install_hint: "rustup component add rust-analyzer",
    },
    LintToolConfig {
        id: "clippy",
        name: "Clippy",
        command: "cargo",
        version_arg: "clippy --version",
        languages: &["rust"],
        install_hint: "rustup component add clippy",
    },
    LintToolConfig {
        id: "rustfmt",
        name: "Rustfmt",
        command: "rustfmt",
        version_arg: "--version",
        languages: &["rust"],
        install_hint: "rustup component add rustfmt",
    },
    LintToolConfig {
        id: "golangci-lint",
        name: "golangci-lint",
        command: "golangci-lint",
        version_arg: "--version",
        languages: &["go"],
        install_hint: "brew install golangci-lint",
    },
    LintToolConfig {
        id: "gofmt",
        name: "Gofmt",
        command: "gofmt",
        version_arg: "-h", // gofmt doesn't have --version, -h works to check existence
        languages: &["go"],
        install_hint: "Included with Go",
    },
    LintToolConfig {
        id: "rubocop",
        name: "RuboCop",
        command: "rubocop",
        version_arg: "--version",
        languages: &["ruby"],
        install_hint: "gem install rubocop",
    },
    LintToolConfig {
        id: "shellcheck",
        name: "ShellCheck",
        command: "shellcheck",
        version_arg: "--version",
        languages: &["shell", "bash"],
        install_hint: "brew install shellcheck",
    },
    LintToolConfig {
        id: "hadolint",
        name: "Hadolint",
        command: "hadolint",
        version_arg: "--version",
        languages: &["dockerfile"],
        install_hint: "brew install hadolint",
    },
    LintToolConfig {
        id: "markdownlint",
        name: "markdownlint",
        command: "markdownlint",
        version_arg: "--version",
        languages: &["markdown"],
        install_hint: "npm install -g markdownlint-cli",
    },
    // C/C++
    LintToolConfig {
        id: "clang-tidy",
        name: "clang-tidy",
        command: "clang-tidy",
        version_arg: "--version",
        languages: &["c", "cpp"],
        install_hint: "brew install llvm",
    },
    LintToolConfig {
        id: "clang-format",
        name: "clang-format",
        command: "clang-format",
        version_arg: "--version",
        languages: &["c", "cpp"],
        install_hint: "brew install clang-format",
    },
    LintToolConfig {
        id: "cppcheck",
        name: "Cppcheck",
        command: "cppcheck",
        version_arg: "--version",
        languages: &["c", "cpp"],
        install_hint: "brew install cppcheck",
    },
    // Java
    LintToolConfig {
        id: "checkstyle",
        name: "Checkstyle",
        command: "checkstyle",
        version_arg: "--version",
        languages: &["java"],
        install_hint: "brew install checkstyle",
    },
    LintToolConfig {
        id: "google-java-format",
        name: "google-java-format",
        command: "google-java-format",
        version_arg: "--version",
        languages: &["java"],
        install_hint: "brew install google-java-format",
    },
    // PHP
    LintToolConfig {
        id: "phpcs",
        name: "PHP_CodeSniffer",
        command: "phpcs",
        version_arg: "--version",
        languages: &["php"],
        install_hint: "brew install php-code-sniffer",
    },
    LintToolConfig {
        id: "phpstan",
        name: "PHPStan",
        command: "phpstan",
        version_arg: "--version",
        languages: &["php"],
        install_hint: "brew install phpstan",
    },
    // Swift
    LintToolConfig {
        id: "swiftlint",
        name: "SwiftLint",
        command: "swiftlint",
        version_arg: "version",
        languages: &["swift"],
        install_hint: "brew install swiftlint",
    },
    LintToolConfig {
        id: "swift-format",
        name: "swift-format",
        command: "swift-format",
        version_arg: "--version",
        languages: &["swift"],
        install_hint: "brew install swift-format",
    },
    // Kotlin
    LintToolConfig {
        id: "ktlint",
        name: "ktlint",
        command: "ktlint",
        version_arg: "--version",
        languages: &["kotlin"],
        install_hint: "brew install ktlint",
    },
    // Lua
    LintToolConfig {
        id: "luacheck",
        name: "Luacheck",
        command: "luacheck",
        version_arg: "--version",
        languages: &["lua"],
        install_hint: "brew install luacheck",
    },
    // Elixir
    LintToolConfig {
        id: "credo",
        name: "Credo",
        command: "mix",
        version_arg: "credo --version",
        languages: &["elixir"],
        install_hint: "mix archive.install hex credo",
    },
    // SQL
    LintToolConfig {
        id: "sqlfluff",
        name: "SQLFluff",
        command: "sqlfluff",
        version_arg: "--version",
        languages: &["sql"],
        install_hint: "pip install sqlfluff",
    },
    // YAML
    LintToolConfig {
        id: "yamllint",
        name: "yamllint",
        command: "yamllint",
        version_arg: "--version",
        languages: &["yaml"],
        install_hint: "pip install yamllint",
    },
    // TOML
    LintToolConfig {
        id: "taplo",
        name: "Taplo",
        command: "taplo",
        version_arg: "--version",
        languages: &["toml"],
        install_hint: "cargo install taplo-cli",
    },
];

/// Get version of a tool
fn get_tool_version(config: &LintToolConfig) -> Option<String> {
    // Special case for clippy which needs cargo clippy --version
    let output = if config.id == "clippy" {
        let mut command = Command::new("cargo");
        command.args(["clippy", "--version"]);
        // Suppress console window on Windows.
        app_platform::hide_console(&mut command);
        command.output().ok()?
    } else if config.id == "gofmt" {
        // gofmt doesn't have version, just check existence
        return if command_exists("gofmt") {
            Some("installed".to_string())
        } else {
            None
        };
    } else {
        let mut command = Command::new(config.command);
        command.arg(config.version_arg);
        // Suppress console window on Windows.
        app_platform::hide_console(&mut command);
        command.output().ok()?
    };

    if output.status.success() || !output.stdout.is_empty() {
        let version = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();

        // Clean up version string - extract just the version number if possible
        let version = version
            .replace("v", "")
            .split_whitespace()
            .find(|s| {
                s.chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
            })
            .unwrap_or(&version)
            .to_string();

        if version.is_empty() {
            None
        } else {
            Some(version)
        }
    } else {
        None
    }
}

/// Derive the binary required to install a lint tool from its install_hint.
fn required_binary(install_hint: &str) -> Option<&'static str> {
    let hint = install_hint.to_lowercase();
    if hint.starts_with("npm ") || hint.contains("npm install") {
        Some("npm")
    } else if hint.starts_with("pip3 ") {
        Some("pip3")
    } else if hint.starts_with("pip ") || hint.contains("pip install") {
        Some("pip")
    } else if hint.starts_with("cargo ") || hint.contains("cargo install") {
        Some("cargo")
    } else if hint.starts_with("rustup ") {
        Some("rustup")
    } else if hint.starts_with("gem ") {
        Some("gem")
    } else if hint.starts_with("brew ") || hint.contains("brew install") {
        Some("brew")
    } else if hint.starts_with("go install") {
        Some("go")
    } else if hint.starts_with("mix ") {
        Some("mix")
    } else {
        None
    }
}

/// Check whether `binary` was reported as installed by the most recent
/// system-dependency probe.
///
/// Reads `~/.orgii/dependencies.json` directly (written by the `app` crate's
/// `infrastructure::platform::dependencies::detect_system_dependencies`).
/// Returning `false` when the cache is missing or unreadable matches the
/// caller-side semantics: the LSP UI will surface the lint tool's prereq
/// as unmet rather than blocking on a re-scan.
fn is_binary_available_cached(binary: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct DepRow {
        binary: String,
        installed: bool,
    }
    #[derive(serde::Deserialize)]
    struct CachedDeps {
        dependencies: Vec<DepRow>,
    }

    let path = app_paths::dependencies_cache();
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let cached: CachedDeps = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(_) => return false,
    };
    cached
        .dependencies
        .iter()
        .any(|dep| dep.binary == binary && dep.installed)
}

/// Check all lint tools and return their status
pub fn check_lint_tools() -> Vec<LintToolInfo> {
    LINT_TOOLS
        .iter()
        .map(|config| {
            let installed = command_exists(config.command);
            let version = if installed {
                get_tool_version(config)
            } else {
                None
            };
            let uninstall_supported = is_uninstall_supported(config.install_hint);
            let req_bin = required_binary(config.install_hint);
            let prerequisite_met = match req_bin {
                Some(bin) => is_binary_available_cached(bin),
                None => true,
            };

            LintToolInfo {
                id: config.id.to_string(),
                name: config.name.to_string(),
                languages: config.languages.iter().map(|s| s.to_string()).collect(),
                install_hint: config.install_hint.to_string(),
                installed,
                version,
                uninstall_supported,
                requires_binary: req_bin.map(|s| s.to_string()),
                prerequisite_met,
            }
        })
        .collect()
}

/// Get list of all supported lint tools with their info
pub fn get_supported_lint_tools() -> Vec<(&'static str, &'static str, &'static str)> {
    LINT_TOOLS
        .iter()
        .map(|config| (config.id, config.name, config.install_hint))
        .collect()
}

/// Get install hint for a specific lint tool by ID
pub fn get_lint_tool_install_hint(tool_id: &str) -> Option<&'static str> {
    LINT_TOOLS
        .iter()
        .find(|config| config.id == tool_id)
        .map(|config| config.install_hint)
}

#[cfg(test)]
#[path = "tests/lint_tools_tests.rs"]
mod tests;
