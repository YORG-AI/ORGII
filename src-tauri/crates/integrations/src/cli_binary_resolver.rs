use std::env;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliBinaryId {
    // Original 11 agents from PR #230
    CursorCli,
    ClaudeCode,
    Codex,
    Aider,
    Kiro,
    Copilot,
    Cline,
    Goose,
    OpenCode,
    KimiCli,
    // Extended CLI agents
    Amp,
    Kilo,
    Grok,
    Devin,
    Rovo,
    Hermes,
    OpenClaw,
    Aug,
    Codebuff,
    QwenCode,
    MimoCode,
    Antigravity,
    Continue,
    Droid,
    MistralVibe,
    Autohand,
    Omp,
    Pi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliBinaryResolutionSource {
    ProcessPath,
    LoginShell,
    KnownLocation,
    BareCommandFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliBinaryMetadata {
    pub id: CliBinaryId,
    pub row_id: &'static str,
    pub display_name: &'static str,
    pub command: &'static str,
    pub launchable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliBinaryResolution {
    pub metadata: &'static CliBinaryMetadata,
    pub command: String,
    pub source: CliBinaryResolutionSource,
    pub diagnostics: Vec<String>,
}

impl CliBinaryResolution {
    pub fn installed(&self) -> bool {
        !matches!(self.source, CliBinaryResolutionSource::BareCommandFallback)
    }

    pub fn path_for_detection(&self) -> String {
        if self.installed() {
            self.command.clone()
        } else {
            String::new()
        }
    }
}

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

const CLI_BINARY_METADATA: &[CliBinaryMetadata] = &[
    CliBinaryMetadata {
        id: CliBinaryId::CursorCli,
        row_id: "cursor-agent",
        display_name: "Cursor Agent",
        command: "cursor-agent",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::ClaudeCode,
        row_id: "claude",
        display_name: "Claude Code",
        command: "claude",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Codex,
        row_id: "codex",
        display_name: "Codex",
        command: "codex",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Aider,
        row_id: "aider",
        display_name: "Aider",
        command: "aider",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Kiro,
        row_id: "kiro",
        display_name: "Kiro",
        command: "kiro-cli",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Copilot,
        row_id: "copilot",
        display_name: "Copilot",
        command: "copilot",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Cline,
        row_id: "cline",
        display_name: "Cline",
        command: "cline",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Goose,
        row_id: "goose",
        display_name: "Goose",
        command: "goose",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::OpenCode,
        row_id: "opencode",
        display_name: "OpenCode",
        command: "opencode",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::KimiCli,
        row_id: "kimi",
        display_name: "Kimi",
        command: "kimi",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Amp,
        row_id: "amp",
        display_name: "Amp",
        command: "amp",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Kilo,
        row_id: "kilo",
        display_name: "Kilo Code",
        command: "kilo",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Grok,
        row_id: "grok",
        display_name: "Grok",
        command: "grok",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Devin,
        row_id: "devin",
        display_name: "Devin",
        command: "devin",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Rovo,
        row_id: "rovo",
        display_name: "Rovo Dev",
        command: "acli",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Hermes,
        row_id: "hermes",
        display_name: "Hermes",
        command: "hermes",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::OpenClaw,
        row_id: "openclaw",
        display_name: "OpenClaw",
        command: "openclaw",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Aug,
        row_id: "aug",
        display_name: "Augment Code",
        // The published @augmentcode/auggie package installs as `auggie`, not `aug`.
        command: "auggie",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Codebuff,
        row_id: "codebuff",
        display_name: "Codebuff",
        command: "codebuff",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::QwenCode,
        row_id: "qwen-code",
        display_name: "Qwen Code",
        // The upstream QwenLM/qwen-code package installs as `qwen` on PATH.
        command: "qwen",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::MimoCode,
        row_id: "mimo-code",
        display_name: "Mimo Code",
        command: "mimo",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Antigravity,
        row_id: "antigravity",
        display_name: "Antigravity",
        // The published binary is `agy`, not `antigravity`.
        command: "agy",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Continue,
        row_id: "continue",
        display_name: "Continue",
        // Continue's CLI binary is `cn`; `continue` is a shell builtin.
        command: "cn",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Droid,
        row_id: "droid",
        display_name: "Droid",
        command: "droid",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::MistralVibe,
        row_id: "mistral-vibe",
        display_name: "Mistral Vibe",
        // Mistral's installer exposes `vibe` as the binary name.
        command: "vibe",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Autohand,
        row_id: "autohand",
        display_name: "Autohand",
        command: "autohand",
        launchable: false,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Omp,
        row_id: "omp",
        display_name: "OMP",
        command: "omp",
        launchable: true,
    },
    CliBinaryMetadata {
        id: CliBinaryId::Pi,
        row_id: "pi",
        display_name: "Pi",
        command: "pi",
        launchable: true,
    },
];

pub fn all_cli_binary_metadata() -> &'static [CliBinaryMetadata] {
    CLI_BINARY_METADATA
}

pub fn launchable_cli_binary_metadata() -> impl Iterator<Item = &'static CliBinaryMetadata> {
    CLI_BINARY_METADATA
        .iter()
        .filter(|metadata| metadata.launchable)
}

pub fn metadata_for_id(id: CliBinaryId) -> &'static CliBinaryMetadata {
    CLI_BINARY_METADATA
        .iter()
        .find(|metadata| metadata.id == id)
        .expect("missing CLI binary metadata")
}

pub fn id_for_registry_name(name: &str) -> Option<CliBinaryId> {
    match name {
        "cursor_cli" => Some(CliBinaryId::CursorCli),
        "claude_code" => Some(CliBinaryId::ClaudeCode),
        "codex" => Some(CliBinaryId::Codex),
        "aider" => Some(CliBinaryId::Aider),
        "kiro" => Some(CliBinaryId::Kiro),
        "copilot" => Some(CliBinaryId::Copilot),
        "cline" => Some(CliBinaryId::Cline),
        "goose" => Some(CliBinaryId::Goose),
        "opencode" => Some(CliBinaryId::OpenCode),
        "kimi_cli" => Some(CliBinaryId::KimiCli),
        "amp" => Some(CliBinaryId::Amp),
        "kilo" => Some(CliBinaryId::Kilo),
        "grok_cli" => Some(CliBinaryId::Grok),
        "devin" => Some(CliBinaryId::Devin),
        "rovo" => Some(CliBinaryId::Rovo),
        "hermes" => Some(CliBinaryId::Hermes),
        "openclaw" => Some(CliBinaryId::OpenClaw),
        "aug" => Some(CliBinaryId::Aug),
        "codebuff" => Some(CliBinaryId::Codebuff),
        "qwen_code" => Some(CliBinaryId::QwenCode),
        "mimo_code" => Some(CliBinaryId::MimoCode),
        "antigravity" => Some(CliBinaryId::Antigravity),
        "continue_cli" => Some(CliBinaryId::Continue),
        "droid" => Some(CliBinaryId::Droid),
        "mistral_vibe" => Some(CliBinaryId::MistralVibe),
        "autohand" => Some(CliBinaryId::Autohand),
        "omp" => Some(CliBinaryId::Omp),
        "pi" => Some(CliBinaryId::Pi),
        _ => None,
    }
}

pub fn resolve_cli_binary_for_registry_name(name: &str) -> Option<CliBinaryResolution> {
    id_for_registry_name(name).map(resolve_cli_binary)
}

pub fn resolve_cli_binary(id: CliBinaryId) -> CliBinaryResolution {
    resolve_cli_binary_with_options(id, &ResolveOptions::default())
}

pub fn resolve_cli_binary_command(id: CliBinaryId) -> String {
    resolve_cli_binary(id).command
}

#[derive(Debug, Clone)]
struct ResolveOptions {
    path_env: Option<OsString>,
    shell: Option<OsString>,
    home_dir: Option<PathBuf>,
    login_shell_timeout: Duration,
}

impl Default for ResolveOptions {
    fn default() -> Self {
        Self {
            path_env: env::var_os("PATH"),
            shell: env::var_os("SHELL"),
            home_dir: dirs::home_dir(),
            login_shell_timeout: LOGIN_SHELL_TIMEOUT,
        }
    }
}

fn resolve_cli_binary_with_options(
    id: CliBinaryId,
    options: &ResolveOptions,
) -> CliBinaryResolution {
    let metadata = metadata_for_id(id);
    let mut diagnostics = Vec::new();

    if let Some(path) = find_on_process_path(metadata.command, options.path_env.as_ref()) {
        return CliBinaryResolution {
            metadata,
            command: path.to_string_lossy().to_string(),
            source: CliBinaryResolutionSource::ProcessPath,
            diagnostics,
        };
    }
    diagnostics.push(format!("{} not found on process PATH", metadata.command));

    if let Some(path) = resolve_via_login_shell(metadata.command, options) {
        return CliBinaryResolution {
            metadata,
            command: path.to_string_lossy().to_string(),
            source: CliBinaryResolutionSource::LoginShell,
            diagnostics,
        };
    }
    diagnostics.push(format!(
        "{} not found via login-shell lookup",
        metadata.command
    ));

    if let Some(path) = known_locations_for(id, options)
        .into_iter()
        .find(|path| is_executable_file(path))
    {
        return CliBinaryResolution {
            metadata,
            command: path.to_string_lossy().to_string(),
            source: CliBinaryResolutionSource::KnownLocation,
            diagnostics,
        };
    }
    diagnostics.push(format!(
        "{} not found in known install locations",
        metadata.command
    ));

    CliBinaryResolution {
        metadata,
        command: metadata.command.to_string(),
        source: CliBinaryResolutionSource::BareCommandFallback,
        diagnostics,
    }
}

fn find_on_process_path(command: &str, path_env: Option<&OsString>) -> Option<PathBuf> {
    if contains_path_separator(command) {
        let path = PathBuf::from(command);
        return is_executable_file(&path).then_some(path);
    }

    let path_env = path_env?;
    env::split_paths(path_env)
        .flat_map(|dir| command_path_candidates(&dir, command))
        .find(|path| is_executable_file(path))
}

fn known_locations_for(id: CliBinaryId, options: &ResolveOptions) -> Vec<PathBuf> {
    let Some(home) = options.home_dir.as_ref() else {
        return Vec::new();
    };

    let command = metadata_for_id(id).command;
    let mut locations = vec![
        home.join(".local/bin").join(command),
        home.join(".bun/bin").join(command),
        home.join(".cargo/bin").join(command),
        home.join("Library/Python/3.11/bin").join(command),
        home.join("Library/Python/3.12/bin").join(command),
        home.join("Library/Python/3.13/bin").join(command),
    ];

    match id {
        CliBinaryId::CursorCli => locations.push(home.join(".local/bin/cursor-agent")),
        CliBinaryId::KimiCli => locations.push(home.join(".kimi-code/bin/kimi")),
        CliBinaryId::Hermes => locations.push(home.join(".hermes/hermes-agent/venv/bin/hermes")),
        CliBinaryId::MimoCode => locations.push(home.join(".mimocode/bin/mimo")),
        _ => {}
    }

    locations
}

#[cfg(unix)]
fn resolve_via_login_shell(command: &str, options: &ResolveOptions) -> Option<PathBuf> {
    let shell = options
        .shell
        .clone()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| OsString::from("/bin/zsh"));
    let script = format!("command -v -- {}", shell_quote(command));
    let stdout = run_shell_command_with_timeout(&shell, &script, options.login_shell_timeout)?;
    stdout.lines().find_map(parse_command_v_path)
}

#[cfg(unix)]
fn run_shell_command_with_timeout(
    shell: &OsString,
    script: &str,
    timeout: Duration,
) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-i", "-l", "-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let started_at = std::time::Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return None;
            }
            let mut stdout = String::new();
            child.stdout.take()?.read_to_string(&mut stdout).ok()?;
            return Some(stdout);
        }

        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }

        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(unix))]
fn resolve_via_login_shell(_command: &str, _options: &ResolveOptions) -> Option<PathBuf> {
    None
}

fn parse_command_v_path(line: &str) -> Option<PathBuf> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.contains('\n') || trimmed.contains('\r') {
        return None;
    }

    let path = Path::new(trimmed);
    if path.is_absolute() && is_executable_file(path) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn contains_path_separator(command: &str) -> bool {
    command.contains('/') || command.contains('\\')
}

fn command_path_candidates(dir: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            return vec![dir.join(command)];
        }

        let path_ext = env::var_os("PATHEXT")
            .and_then(|value| value.into_string().ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());

        path_ext
            .split(';')
            .filter_map(|extension| {
                let extension = extension.trim();
                if extension.is_empty() {
                    None
                } else if extension.starts_with('.') {
                    Some(dir.join(format!("{command}{extension}")))
                } else {
                    Some(dir.join(format!("{command}.{extension}")))
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![dir.join(command)]
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_executable(path: &Path) {
        fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        set_executable(path);
    }

    fn set_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn command_path_candidates_include_platform_command() {
        let dir = Path::new("/tmp/bin");
        let candidates = command_path_candidates(dir, "codex");

        #[cfg(windows)]
        assert!(candidates
            .iter()
            .any(|path| path.file_name().and_then(|name| name.to_str()) == Some("codex.CMD")));

        #[cfg(not(windows))]
        assert_eq!(candidates, vec![dir.join("codex")]);
    }

    #[test]
    fn process_path_hit_returns_absolute_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let binary = temp_dir.path().join("codex");
        make_executable(&binary);

        let options = ResolveOptions {
            path_env: Some(OsString::from(temp_dir.path().as_os_str())),
            shell: Some(OsString::from("/bin/false")),
            home_dir: None,
            login_shell_timeout: Duration::from_millis(10),
        };

        let resolution = resolve_cli_binary_with_options(CliBinaryId::Codex, &options);
        assert_eq!(resolution.command, binary.to_string_lossy());
        assert_eq!(resolution.source, CliBinaryResolutionSource::ProcessPath);
        assert!(resolution.installed());
    }

    #[test]
    fn cursor_known_location_fallback_is_preserved() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bin_dir = temp_dir.path().join(".local/bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let binary = bin_dir.join("cursor-agent");
        make_executable(&binary);

        let options = ResolveOptions {
            path_env: Some(OsString::new()),
            shell: Some(OsString::from("/bin/false")),
            home_dir: Some(temp_dir.path().to_path_buf()),
            login_shell_timeout: Duration::from_millis(10),
        };

        let resolution = resolve_cli_binary_with_options(CliBinaryId::CursorCli, &options);
        assert_eq!(resolution.command, binary.to_string_lossy());
        assert_eq!(resolution.source, CliBinaryResolutionSource::KnownLocation);
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_fallback_rejects_non_path_output() {
        let temp_dir = tempfile::tempdir().unwrap();
        let shell = temp_dir.path().join("fake-shell");
        fs::write(&shell, "#!/bin/sh\nprintf 'codex is a function\\n'\n").unwrap();
        set_executable(&shell);

        let options = ResolveOptions {
            path_env: Some(OsString::new()),
            shell: Some(shell.into_os_string()),
            home_dir: None,
            login_shell_timeout: Duration::from_millis(500),
        };

        let resolution = resolve_cli_binary_with_options(CliBinaryId::Codex, &options);
        assert_eq!(resolution.command, "codex");
        assert_eq!(
            resolution.source,
            CliBinaryResolutionSource::BareCommandFallback
        );
        assert!(!resolution.installed());
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_output_accepts_executable_absolute_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bin_dir = temp_dir.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let binary = bin_dir.join("claude");
        make_executable(&binary);

        let shell = OsString::from("/bin/sh");
        let stdout = run_shell_command_with_timeout(
            &shell,
            &format!("printf '{}\\n'", binary.to_string_lossy()),
            Duration::from_millis(500),
        )
        .unwrap();

        assert_eq!(stdout.lines().find_map(parse_command_v_path), Some(binary));
    }

    #[test]
    fn kiro_canonical_command_is_kiro_cli() {
        let metadata = metadata_for_id(CliBinaryId::Kiro);
        assert_eq!(metadata.command, "kiro-cli");
        assert_eq!(metadata.row_id, "kiro");
    }
}
