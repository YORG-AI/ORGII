//! System dependency detection with persistence
//!
//! Checks whether common development tools (brew, node, npm, python, etc.)
//! are available on the user's PATH.
//! Results are cached to `~/.orgii/dependencies.json`
//! so that other subsystems (lint, LSP) can read them without re-scanning.

use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Single dependency detection result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub name: String,
    pub binary: String,
    pub installed: bool,
    pub version: Option<String>,
    pub category: DependencyCategory,
    /// ISO 8601 timestamp of when the IDE was last used (IDEs only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<String>,
    /// Suggested install command for the user's platform. Frontend renders it
    /// as a copy-paste preview; we don't auto-run system-level deps because
    /// most require sudo / admin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
}

/// Logical grouping shown in the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DependencyCategory {
    PackageManager,
    Runtime,
    VersionControl,
    Toolchain,
    ShellUtility,
    Database,
    Ide,
}

#[derive(Clone, Copy)]
enum ProbeSource {
    SystemPath,
}

struct Probe {
    name: &'static str,
    binary: &'static str,
    version_flag: &'static str,
    category: DependencyCategory,
    source: ProbeSource,
}

/// Per-binary install command suggestions, keyed on the probe's `binary`
/// field. The frontend picks the row matching the host OS at render time.
struct InstallHint {
    binary: &'static str,
    macos: Option<&'static str>,
    linux: Option<&'static str>,
    windows: Option<&'static str>,
}

const INSTALL_HINTS: &[InstallHint] = &[
    InstallHint { binary: "brew", macos: Some("/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""), linux: Some("/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""), windows: None },
    InstallHint { binary: "npm", macos: Some("brew install node"), linux: Some("sudo apt install nodejs npm"), windows: Some("winget install OpenJS.NodeJS") },
    InstallHint { binary: "npx", macos: Some("brew install node"), linux: Some("sudo apt install nodejs npm"), windows: Some("winget install OpenJS.NodeJS") },
    InstallHint { binary: "yarn", macos: Some("brew install yarn"), linux: Some("npm install -g yarn"), windows: Some("npm install -g yarn") },
    InstallHint { binary: "pnpm", macos: Some("brew install pnpm"), linux: Some("curl -fsSL https://get.pnpm.io/install.sh | sh -"), windows: Some("iwr https://get.pnpm.io/install.ps1 -useb | iex") },
    InstallHint { binary: "pip", macos: Some("brew install python"), linux: Some("sudo apt install python3-pip"), windows: Some("winget install Python.Python.3.12") },
    InstallHint { binary: "pip3", macos: Some("brew install python"), linux: Some("sudo apt install python3-pip"), windows: Some("winget install Python.Python.3.12") },
    InstallHint { binary: "cargo", macos: Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"), linux: Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"), windows: Some("winget install Rustlang.Rustup") },
    InstallHint { binary: "rustup", macos: Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"), linux: Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"), windows: Some("winget install Rustlang.Rustup") },
    InstallHint { binary: "gem", macos: Some("brew install ruby"), linux: Some("sudo apt install ruby-full"), windows: Some("winget install RubyInstallerTeam.Ruby.3.3") },
    InstallHint { binary: "composer", macos: Some("brew install composer"), linux: Some("sudo apt install composer"), windows: Some("winget install ComposerHQ.Composer") },
    InstallHint { binary: "opam", macos: Some("brew install opam"), linux: Some("sh <(curl -fsSL https://raw.githubusercontent.com/ocaml/opam/master/shell/install.sh)"), windows: None },
    InstallHint { binary: "ghcup", macos: Some("curl --proto '=https' --tlsv1.2 -sSf https://get-ghcup.haskell.org | sh"), linux: Some("curl --proto '=https' --tlsv1.2 -sSf https://get-ghcup.haskell.org | sh"), windows: None },
    InstallHint { binary: "node", macos: Some("brew install node"), linux: Some("curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -"), windows: Some("winget install OpenJS.NodeJS") },
    InstallHint { binary: "python", macos: Some("brew install python"), linux: Some("sudo apt install python3"), windows: Some("winget install Python.Python.3.12") },
    InstallHint { binary: "python3", macos: Some("brew install python"), linux: Some("sudo apt install python3"), windows: Some("winget install Python.Python.3.12") },
    InstallHint { binary: "ruby", macos: Some("brew install ruby"), linux: Some("sudo apt install ruby-full"), windows: Some("winget install RubyInstallerTeam.Ruby.3.3") },
    InstallHint { binary: "go", macos: Some("brew install go"), linux: Some("sudo apt install golang-go"), windows: Some("winget install GoLang.Go") },
    InstallHint { binary: "java", macos: Some("brew install openjdk"), linux: Some("sudo apt install default-jdk"), windows: Some("winget install EclipseAdoptium.Temurin.21.JDK") },
    InstallHint { binary: "deno", macos: Some("brew install deno"), linux: Some("curl -fsSL https://deno.land/install.sh | sh"), windows: Some("winget install DenoLand.Deno") },
    InstallHint { binary: "bun", macos: Some("brew install oven-sh/bun/bun"), linux: Some("curl -fsSL https://bun.sh/install | bash"), windows: Some("powershell -c \"irm bun.sh/install.ps1 | iex\"") },
    InstallHint { binary: "php", macos: Some("brew install php"), linux: Some("sudo apt install php"), windows: Some("winget install PHP.PHP") },
    InstallHint { binary: "perl", macos: Some("brew install perl"), linux: Some("sudo apt install perl"), windows: Some("winget install StrawberryPerl.StrawberryPerl") },
    InstallHint { binary: "lua", macos: Some("brew install lua"), linux: Some("sudo apt install lua5.4"), windows: Some("winget install DEVCOM.Lua") },
    InstallHint { binary: "Rscript", macos: Some("brew install r"), linux: Some("sudo apt install r-base"), windows: Some("winget install RProject.R") },
    InstallHint { binary: "dotnet", macos: Some("brew install dotnet"), linux: Some("sudo apt install dotnet-sdk-8.0"), windows: Some("winget install Microsoft.DotNet.SDK.8") },
    InstallHint { binary: "mix", macos: Some("brew install elixir"), linux: Some("sudo apt install elixir"), windows: Some("winget install Elixir.Elixir") },
    InstallHint { binary: "swift", macos: Some("xcode-select --install"), linux: Some("curl -O https://download.swift.org/swift-latest/swift.tar.gz"), windows: Some("winget install Swift.Toolchain") },
    InstallHint { binary: "kotlin", macos: Some("brew install kotlin"), linux: Some("sdk install kotlin"), windows: Some("winget install JetBrains.Kotlin") },
    InstallHint { binary: "git", macos: Some("brew install git"), linux: Some("sudo apt install git"), windows: Some("winget install Git.Git") },
    InstallHint { binary: "gh", macos: Some("brew install gh"), linux: Some("sudo apt install gh"), windows: Some("winget install GitHub.cli") },
    InstallHint { binary: "git-lfs", macos: Some("brew install git-lfs"), linux: Some("sudo apt install git-lfs"), windows: Some("winget install GitHub.GitLFS") },
    InstallHint { binary: "svn", macos: Some("brew install subversion"), linux: Some("sudo apt install subversion"), windows: Some("winget install TortoiseSVN.TortoiseSVN") },
    InstallHint { binary: "hg", macos: Some("brew install mercurial"), linux: Some("sudo apt install mercurial"), windows: Some("winget install Mercurial.Mercurial") },
    InstallHint { binary: "glab", macos: Some("brew install glab"), linux: Some("curl -s https://gitlab.com/gitlab-org/cli/-/raw/main/scripts/install.sh | sudo sh"), windows: Some("winget install GitLab.GLab") },
    InstallHint { binary: "docker", macos: Some("brew install --cask docker"), linux: Some("curl -fsSL https://get.docker.com | sh"), windows: Some("winget install Docker.DockerDesktop") },
    InstallHint { binary: "rustc", macos: Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"), linux: Some("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"), windows: Some("winget install Rustlang.Rustup") },
    InstallHint { binary: "gcc", macos: Some("brew install gcc"), linux: Some("sudo apt install build-essential"), windows: Some("winget install MSYS2.MSYS2") },
    InstallHint { binary: "g++", macos: Some("brew install gcc"), linux: Some("sudo apt install g++"), windows: Some("winget install MSYS2.MSYS2") },
    InstallHint { binary: "clang", macos: Some("xcode-select --install"), linux: Some("sudo apt install clang"), windows: Some("winget install LLVM.LLVM") },
    InstallHint { binary: "make", macos: Some("xcode-select --install"), linux: Some("sudo apt install make"), windows: Some("winget install GnuWin32.Make") },
    InstallHint { binary: "cmake", macos: Some("brew install cmake"), linux: Some("sudo apt install cmake"), windows: Some("winget install Kitware.CMake") },
    InstallHint { binary: "javac", macos: Some("brew install openjdk"), linux: Some("sudo apt install default-jdk"), windows: Some("winget install EclipseAdoptium.Temurin.21.JDK") },
    InstallHint { binary: "kubectl", macos: Some("brew install kubectl"), linux: Some("sudo snap install kubectl --classic"), windows: Some("winget install Kubernetes.kubectl") },
    InstallHint { binary: "curl", macos: Some("brew install curl"), linux: Some("sudo apt install curl"), windows: Some("winget install cURL.cURL") },
    InstallHint { binary: "wget", macos: Some("brew install wget"), linux: Some("sudo apt install wget"), windows: Some("winget install JernejSimoncic.Wget") },
    InstallHint { binary: "ssh", macos: None, linux: Some("sudo apt install openssh-client"), windows: Some("winget install Microsoft.OpenSSH.Beta") },
    InstallHint { binary: "tar", macos: None, linux: Some("sudo apt install tar"), windows: Some("winget install GnuWin32.Tar") },
    InstallHint { binary: "unzip", macos: None, linux: Some("sudo apt install unzip"), windows: Some("winget install GnuWin32.UnZip") },
    InstallHint { binary: "jq", macos: Some("brew install jq"), linux: Some("sudo apt install jq"), windows: Some("winget install stedolan.jq") },
    InstallHint { binary: "ffmpeg", macos: Some("brew install ffmpeg"), linux: Some("sudo apt install ffmpeg"), windows: Some("winget install Gyan.FFmpeg") },
    InstallHint { binary: "psql", macos: Some("brew install postgresql"), linux: Some("sudo apt install postgresql-client"), windows: Some("winget install PostgreSQL.PostgreSQL") },
    InstallHint { binary: "mysql", macos: Some("brew install mysql-client"), linux: Some("sudo apt install mysql-client"), windows: Some("winget install Oracle.MySQL") },
    InstallHint { binary: "sqlite3", macos: None, linux: Some("sudo apt install sqlite3"), windows: Some("winget install SQLite.SQLite") },
    InstallHint { binary: "redis-cli", macos: Some("brew install redis"), linux: Some("sudo apt install redis-tools"), windows: Some("winget install Redis.Redis") },
    InstallHint { binary: "mongosh", macos: Some("brew install mongosh"), linux: Some("sudo apt install mongodb-mongosh"), windows: Some("winget install MongoDB.Shell") },
];

fn lookup_install_hint(binary: &str) -> Option<String> {
    INSTALL_HINTS
        .iter()
        .find(|hint| hint.binary == binary)
        .and_then(|hint| {
            if cfg!(target_os = "macos") {
                hint.macos
            } else if cfg!(target_os = "windows") {
                hint.windows
            } else {
                hint.linux
            }
        })
        .map(str::to_string)
}

const PROBES: &[Probe] = &[
    // ── Package Managers ────────────────────────
    Probe {
        name: "Homebrew",
        binary: "brew",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "npm",
        binary: "npm",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "npx",
        binary: "npx",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "yarn",
        binary: "yarn",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "pnpm",
        binary: "pnpm",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "pip",
        binary: "pip",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "pip3",
        binary: "pip3",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "cargo",
        binary: "cargo",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "rustup",
        binary: "rustup",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "gem",
        binary: "gem",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Composer",
        binary: "composer",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "opam",
        binary: "opam",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "GHCup",
        binary: "ghcup",
        version_flag: "--version",
        category: DependencyCategory::PackageManager,
        source: ProbeSource::SystemPath,
    },
    // ── Runtimes ────────────────────────────────
    Probe {
        name: "Node.js",
        binary: "node",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Python",
        binary: "python",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Python 3",
        binary: "python3",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Ruby",
        binary: "ruby",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Go",
        binary: "go",
        version_flag: "version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Java",
        binary: "java",
        version_flag: "-version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Deno",
        binary: "deno",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Bun",
        binary: "bun",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "PHP",
        binary: "php",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Perl",
        binary: "perl",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Lua",
        binary: "lua",
        version_flag: "-v",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "R",
        binary: "Rscript",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: ".NET",
        binary: "dotnet",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Elixir (mix)",
        binary: "mix",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Swift",
        binary: "swift",
        version_flag: "--version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Kotlin",
        binary: "kotlin",
        version_flag: "-version",
        category: DependencyCategory::Runtime,
        source: ProbeSource::SystemPath,
    },
    // ── Version Control ─────────────────────────
    Probe {
        name: "Git",
        binary: "git",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "GitHub CLI",
        binary: "gh",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Git LFS",
        binary: "git-lfs",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "SVN",
        binary: "svn",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "Mercurial",
        binary: "hg",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "GitLab CLI",
        binary: "glab",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    },
    // ── Toolchain / Build ───────────────────────
    Probe {
        name: "Docker",
        binary: "docker",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "rustc",
        binary: "rustc",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "gcc",
        binary: "gcc",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "g++",
        binary: "g++",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "clang",
        binary: "clang",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "make",
        binary: "make",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "cmake",
        binary: "cmake",
        version_flag: "--version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "javac",
        binary: "javac",
        version_flag: "-version",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "kubectl",
        binary: "kubectl",
        version_flag: "version --client",
        category: DependencyCategory::Toolchain,
        source: ProbeSource::SystemPath,
    },
    // ── Shell Utilities ─────────────────────────
    Probe {
        name: "curl",
        binary: "curl",
        version_flag: "--version",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "wget",
        binary: "wget",
        version_flag: "--version",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "ssh",
        binary: "ssh",
        version_flag: "-V",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "tar",
        binary: "tar",
        version_flag: "--version",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "unzip",
        binary: "unzip",
        version_flag: "-v",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "jq",
        binary: "jq",
        version_flag: "--version",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "ffmpeg",
        binary: "ffmpeg",
        version_flag: "-version",
        category: DependencyCategory::ShellUtility,
        source: ProbeSource::SystemPath,
    },
    // ── Database CLIs ───────────────────────────
    Probe {
        name: "psql",
        binary: "psql",
        version_flag: "--version",
        category: DependencyCategory::Database,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "mysql",
        binary: "mysql",
        version_flag: "--version",
        category: DependencyCategory::Database,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "sqlite3",
        binary: "sqlite3",
        version_flag: "--version",
        category: DependencyCategory::Database,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "redis-cli",
        binary: "redis-cli",
        version_flag: "--version",
        category: DependencyCategory::Database,
        source: ProbeSource::SystemPath,
    },
    Probe {
        name: "mongosh",
        binary: "mongosh",
        version_flag: "--version",
        category: DependencyCategory::Database,
        source: ProbeSource::SystemPath,
    },
];

/// Extract the first meaningful version string from command output.
fn parse_version(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        for token in trimmed.split_whitespace() {
            let clean = token
                .trim_matches(&['"', '\'', '(', ')'] as &[char])
                .trim_end_matches(&[',', ';'] as &[char]);
            // Handle name/version format (e.g. "git-lfs/3.4.0")
            let candidate = if clean.contains('/') {
                clean.rsplit('/').next().unwrap_or(clean)
            } else {
                clean
            };
            let candidate = candidate.trim_start_matches('v').trim_start_matches("go");
            if candidate
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
                && candidate.contains('.')
            {
                return Some(candidate.to_string());
            }
        }
        let mut chars = trimmed.chars();
        let truncated: String = chars.by_ref().take(80).collect();
        if chars.next().is_some() {
            return Some(truncated);
        }
        return Some(trimmed.to_string());
    }
    None
}

async fn probe_one(probe: &Probe) -> DependencyStatus {
    // Explicitly forward PATH so the augmented login-shell PATH set by
    // app_paths::augment_path_from_shell() at startup is visible to child
    // processes even across async executor threads.
    let current_path = std::env::var("PATH").unwrap_or_default();

    let mut command = match probe.source {
        ProbeSource::SystemPath => tokio::process::Command::new(probe.binary),
    };

    // Suppress the console window each version probe would flash on Windows
    // (dependency detection spawns one per known tool — a visible burst).
    #[cfg(windows)]
    command.creation_flags(app_platform::CREATE_NO_WINDOW);

    let result = command
        .args(probe.version_flag.split_whitespace())
        .env("PATH", &current_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = if stdout.trim().is_empty() {
                stderr.to_string()
            } else {
                stdout.to_string()
            };
            DependencyStatus {
                name: probe.name.to_string(),
                binary: probe.binary.to_string(),
                installed: true,
                version: parse_version(&combined),
                category: probe.category.clone(),
                last_used: None,
                install_hint: lookup_install_hint(probe.binary),
            }
        }
        _ => {
            // Version flag failed — fallback to which/where to detect presence
            // without version info (e.g. JetBrains IDE launchers).
            let found = match probe.source {
                ProbeSource::SystemPath => {
                    let which_cmd = if cfg!(windows) { "where" } else { "which" };
                    let mut which_command = tokio::process::Command::new(which_cmd);
                    which_command
                        .arg(probe.binary)
                        .env("PATH", &current_path)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::null());
                    // Suppress the `where` console window on Windows.
                    #[cfg(windows)]
                    which_command.creation_flags(app_platform::CREATE_NO_WINDOW);
                    let which_result = which_command.output().await;

                    matches!(which_result, Ok(ref out) if out.status.success())
                }
            };
            DependencyStatus {
                name: probe.name.to_string(),
                binary: probe.binary.to_string(),
                installed: found,
                version: None,
                category: probe.category.clone(),
                last_used: None,
                install_hint: lookup_install_hint(probe.binary),
            }
        }
    }
}

// ============================================
// Persistence
// ============================================

/// Persisted cache file structure.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedDependencies {
    scanned_at: String,
    scan_duration_ms: u64,
    dependencies: Vec<DependencyStatus>,
}

/// Full scan result returned to the frontend.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDependencies {
    pub dependencies: Vec<DependencyStatus>,
    pub scan_duration_ms: u64,
    pub scanned_at: String,
    pub from_cache: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDependencyStatus {
    pub dependency: DependencyStatus,
}

fn cache_path() -> std::path::PathBuf {
    app_paths::dependencies_cache()
}

const CACHE_MAX_AGE_SECS: u64 = 3600;

fn save_cache(deps: &[DependencyStatus], duration_ms: u64) {
    let cached = CachedDependencies {
        scanned_at: chrono::Utc::now().to_rfc3339(),
        scan_duration_ms: duration_ms,
        dependencies: deps.to_vec(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&cached) {
        let path = cache_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, json);
    }
}

fn load_cache() -> Option<SystemDependencies> {
    // Silent `None` on read/parse failure makes the dependency
    // probe re-run from scratch, which is fine. But the read
    // failure (other than NotFound) and parse failure (torn write)
    // are diagnostic and deserve a warn — without them, a user
    // who keeps seeing "scanning dependencies…" with every restart
    // has no clue why their cache isn't sticking.
    let path = cache_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "platform::dependencies: cache read failed; will rescan dependencies"
                );
            }
            return None;
        }
    };
    let cached: CachedDependencies = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "platform::dependencies: cache JSON parse failed (likely torn write); will rescan dependencies"
            );
            return None;
        }
    };
    let scanned_at = match chrono::DateTime::parse_from_rfc3339(&cached.scanned_at) {
        Ok(t) => t,
        Err(err) => {
            tracing::warn!(
                value = %cached.scanned_at,
                error = %err,
                "platform::dependencies: scanned_at timestamp parse failed; treating cache as expired"
            );
            return None;
        }
    };
    let age = chrono::Utc::now()
        .signed_duration_since(scanned_at)
        .num_seconds() as u64;
    if age > CACHE_MAX_AGE_SECS {
        return None;
    }

    Some(SystemDependencies {
        dependencies: cached.dependencies,
        scan_duration_ms: cached.scan_duration_ms,
        scanned_at: cached.scanned_at,
        from_cache: true,
    })
}

// ============================================
// Public API for other Rust modules
// ============================================

/// Check if a specific binary is installed according to the cached scan.
/// Falls back to false if no cache exists.
///
/// Callers use this to gate optional features (e.g. show "git not
/// installed" UI). Silently returning `false` on read or parse
/// failure is fine for the gate, but the operator should still see
/// a one-time hint in logs that the cache itself was unreadable —
/// otherwise the UI says "binary not installed" while the binary is
/// actually present and the cache is just torn.
pub fn is_binary_available(binary: &str) -> bool {
    let path = cache_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    binary = %binary,
                    "platform::dependencies: is_binary_available read failed; reporting binary as unavailable"
                );
            }
            return false;
        }
    };
    let cached = match serde_json::from_str::<CachedDependencies>(&contents) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                binary = %binary,
                "platform::dependencies: is_binary_available JSON parse failed; reporting binary as unavailable"
            );
            return false;
        }
    };
    cached
        .dependencies
        .iter()
        .any(|dep| dep.binary == binary && dep.installed)
}

// ============================================
// Tauri commands
// ============================================

#[tauri::command]
pub async fn detect_git_dependency() -> Result<GitDependencyStatus, String> {
    let git_probe = Probe {
        name: "Git",
        binary: "git",
        version_flag: "--version",
        category: DependencyCategory::VersionControl,
        source: ProbeSource::SystemPath,
    };

    let mut dependency = probe_one(&git_probe).await;
    dependency.installed = git::resolved_git_executable_details().is_ok();
    Ok(GitDependencyStatus { dependency })
}

/// Scan all dependencies, persist results, and return them.
///
/// Runs tool probes in parallel, then appends IDE results from the existing
/// `server_detect_ides` detector (which handles CLI + macOS .app bundles).
#[tauri::command]
pub async fn detect_system_dependencies() -> Result<SystemDependencies, String> {
    let start = Instant::now();

    let probe_futures: Vec<_> = PROBES.iter().map(probe_one).collect();
    let (tool_deps, ide_result) = tokio::join!(
        futures::future::join_all(probe_futures),
        integrations::external_ide::server_detect_ides(),
    );

    let mut dependencies = tool_deps;

    if let Ok(ides) = ide_result {
        for ide in ides {
            let name = ide.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let path = ide.get("path").and_then(|v| v.as_str()).unwrap_or_default();
            let category = ide
                .get("category")
                .and_then(|v| v.as_str())
                .unwrap_or("ide");
            let installed = ide
                .get("installed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let version = ide
                .get("version")
                .and_then(|v| v.as_str())
                .map(String::from);
            let last_used = ide
                .get("lastUsed")
                .and_then(|v| v.as_str())
                .map(String::from);
            if name.is_empty() || category == "ai_cli" {
                continue;
            }
            dependencies.push(DependencyStatus {
                name: name.to_string(),
                binary: path.to_string(),
                installed,
                version,
                category: DependencyCategory::Ide,
                last_used,
                install_hint: None,
            });
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    let scanned_at = chrono::Utc::now().to_rfc3339();

    save_cache(&dependencies, duration_ms);

    Ok(SystemDependencies {
        dependencies,
        scan_duration_ms: duration_ms,
        scanned_at,
        from_cache: false,
    })
}

/// Return cached results if fresh (< 1 hour), otherwise trigger a new scan.
#[tauri::command]
pub async fn get_cached_dependencies() -> Result<SystemDependencies, String> {
    if let Some(cached) = load_cache() {
        return Ok(cached);
    }
    detect_system_dependencies().await
}
