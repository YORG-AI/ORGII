//! CLI install, uninstall, and install-method inference helpers.

use super::super::CliInstallMethod;

pub(crate) fn cli_install_methods(name: &str) -> Vec<CliInstallMethod> {
    let m = |id: &str, label: &str, cmd: &str| CliInstallMethod {
        id: id.into(),
        label: label.into(),
        command: cmd.into(),
    };
    match name {
        "claude_code" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://claude.ai/install.sh | bash",
            ),
            m(
                "powershell",
                "PowerShell",
                "irm https://claude.ai/install.ps1 | iex",
            ),
            m("homebrew", "Homebrew", "brew install --cask claude-code"),
            m("npm", "npm", "npm install -g @anthropic-ai/claude-code"),
        ],
        "codex" => vec![
            m("npm", "npm", "npm install -g @openai/codex"),
            m("homebrew", "Homebrew", "brew install --cask codex"),
        ],
        "cursor_cli" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://cursor.com/install | bash",
            ),
            m("npm", "npm", "npm install -g cursor-cli"),
        ],
        "kiro" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://cli.kiro.dev/install | bash",
            ),
            m(
                "appimage",
                "AppImage",
                "curl -L https://desktop-release.q.us-east-1.amazonaws.com/latest/kiro-cli.appimage -o kiro-cli.appimage && chmod +x kiro-cli.appimage",
            ),
            m(
                "deb",
                ".deb",
                "wget https://desktop-release.q.us-east-1.amazonaws.com/latest/kiro-cli.deb && sudo dpkg -i kiro-cli.deb && sudo apt-get install -f",
            ),
            m(
                "zip-x64",
                "Linux x86-64",
                "curl --proto '=https' --tlsv1.2 -sSf 'https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-x86_64-linux.zip' -o kirocli.zip && unzip kirocli.zip && ./kirocli/install.sh",
            ),
        ],
        "copilot" => vec![
            m("npm", "npm", "npm install -g @github/copilot"),
            m(
                "curl",
                "curl",
                "curl -fsSL https://gh.io/copilot-install | bash",
            ),
            m("homebrew", "Homebrew", "brew install copilot-cli"),
            m("winget", "WinGet", "winget install GitHub.Copilot"),
        ],
        "kimi_cli" => vec![
            m(
                "curl",
                "curl",
                "curl -LsSf https://code.kimi.com/install.sh | bash",
            ),
            m(
                "powershell",
                "PowerShell",
                "irm https://code.kimi.com/install.ps1 | iex",
            ),
            m("uv", "uv", "uv tool install --python 3.13 kimi-cli"),
        ],
        "aider" => vec![
            m("pip", "pip / pipx", "pip install aider-chat"),
            m("brew", "Homebrew", "brew install aider"),
        ],
        "goose" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash",
            ),
            m("homebrew", "Homebrew", "brew install block-goose-cli"),
        ],
        "amp" => vec![
            m("npm", "npm", "npm install -g @ampcode/cli"),
        ],
        "cline" => vec![
            m("npm", "npm", "npm install -g cline"),
        ],
        "kilo" => vec![
            m("npm", "npm", "npm install -g @kilocode/cli"),
        ],
        "grok_cli" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://raw.githubusercontent.com/xai-org/grok-cli/main/install.sh | bash",
            ),
            m("npm", "npm", "npm install -g grok-cli"),
        ],
        "devin" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://cli.devin.ai/install.sh | bash",
            ),
            m("homebrew", "Homebrew", "brew install --cask devin-cli"),
        ],
        "rovo" => vec![
            m(
                "curl",
                "curl",
                "arch=$(uname -m); case \"$arch\" in arm64|aarch64) acli_arch=arm64 ;; x86_64|amd64) acli_arch=amd64 ;; *) echo \"Unsupported architecture: $arch\" >&2; exit 1 ;; esac; os=$(uname -s | tr '[:upper:]' '[:lower:]'); mkdir -p ~/.local/bin && curl -fsSL \"https://acli.atlassian.com/${os}/latest/acli_${os}_${acli_arch}/acli\" -o ~/.local/bin/acli && chmod +x ~/.local/bin/acli",
            ),
        ],
        "hermes" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
            ),
            m(
                "powershell",
                "PowerShell",
                "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
            ),
        ],
        "openclaw" => vec![
            m("npm", "npm", "npm install -g openclaw"),
        ],
        "aug" => vec![
            m("npm", "npm", "npm install -g @augmentcode/auggie"),
        ],
        "codebuff" => vec![
            m("npm", "npm", "npm install -g codebuff"),
        ],
        "qwen_code" => vec![
            m("npm", "npm", "npm install -g qwen-code"),
        ],
        "mimo_code" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://mimo.xiaomi.com/install | bash",
            ),
            m("npm", "npm", "npm install -g @mimo-ai/cli"),
        ],
        "antigravity" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            ),
            m(
                "powershell",
                "PowerShell",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ),
            m(
                "cmd",
                "Windows CMD",
                "curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd",
            ),
        ],
        "continue_cli" => vec![
            m("npm", "npm", "npm install -g @continuedev/cli"),
        ],
        "droid" => vec![
            m("npm", "npm", "npm install -g droid"),
        ],
        "mistral_vibe" => vec![
            m(
                "curl",
                "curl",
                "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
            ),
            m("uv", "uv", "uv tool install mistral-vibe"),
            m("pip", "pip", "pip install mistral-vibe"),
        ],
        "autohand" => vec![
            m("npm", "npm", "npm install -g autohand-cli"),
        ],
        "omp" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://omp.sh/install | sh",
            ),
            m("bun", "Bun", "bun install -g @oh-my-pi/pi-coding-agent"),
            m("npm", "npm", "npm install -g @oh-my-pi/pi-coding-agent"),
        ],
        "pi" => vec![
            m("npm", "npm", "npm install -g @earendil-works/pi-coding-agent"),
        ],
        "qoder_cli" => vec![
            m(
                "curl",
                "curl",
                "curl -fsSL https://qoder.com/install | bash",
            ),
            m(
                "powershell",
                "PowerShell",
                "irm https://qoder.com/install.ps1 | iex",
            ),
            m(
                "cmd",
                "Windows CMD",
                "curl -fsSL https://qoder.com/install.cmd -o install.cmd && install.cmd",
            ),
        ],
        // Trae Agent currently documents a repository checkout plus `uv sync`,
        // not a safe global install command for the registry to execute.
        "trae_cli" => Vec::new(),
        // opencode's docs steer through per-platform package managers; no
        // single command is safe for the registry to run everywhere yet.
        "opencode" => Vec::new(),
        // The caller iterates `cli_agent_registry()` entries, so any
        // CLI agent that ships in the registry but has no install_methods
        // entry here would silently render the "Install" UI as a no-op.
        // Warn so a future registry addition surfaces in logs.
        other => {
            tracing::warn!(
                "[key_vault::registry] cli_install_methods has no entry for CLI agent {:?}; \
                 the Install UI will show no options",
                other
            );
            Vec::new()
        }
    }
}

pub(crate) fn cli_uninstall_methods(name: &str) -> Vec<CliInstallMethod> {
    let m = |id: &str, label: &str, cmd: &str| CliInstallMethod {
        id: id.into(),
        label: label.into(),
        command: cmd.into(),
    };
    match name {
        "claude_code" => vec![
            m("native", "Native", "claude uninstall"),
            m("homebrew", "Homebrew", "brew uninstall --cask claude-code"),
            m("npm", "npm", "npm uninstall -g @anthropic-ai/claude-code"),
        ],
        "codex" => vec![
            m("npm", "npm", "npm uninstall -g @openai/codex"),
            m("homebrew", "Homebrew", "brew uninstall --cask codex"),
        ],
        "cursor_cli" => vec![
            m("npm", "npm", "npm uninstall -g cursor-cli"),
            m(
                "curl",
                "curl",
                "rm -rf ~/.local/bin/cursor ~/.local/share/cursor",
            ),
        ],
        "kiro" => vec![
            m("cli", "Native", "kiro-cli uninstall"),
            m("apt", "apt", "sudo apt-get remove kiro-cli"),
        ],
        "copilot" => vec![
            m("npm", "npm", "npm uninstall -g @github/copilot"),
            m("homebrew", "Homebrew", "brew uninstall copilot-cli"),
            m("winget", "WinGet", "winget uninstall GitHub.Copilot"),
        ],
        "kimi_cli" => vec![m("uv", "uv", "uv tool uninstall kimi-cli")],
        "aider" => vec![
            m("pip", "pip", "pip uninstall aider-chat"),
            m("brew", "Homebrew", "brew uninstall aider"),
        ],
        "goose" => vec![m("homebrew", "Homebrew", "brew uninstall block-goose-cli")],
        "amp" => vec![m("npm", "npm", "npm uninstall -g @ampcode/cli")],
        "cline" => vec![m("npm", "npm", "npm uninstall -g cline")],
        "kilo" => vec![m("npm", "npm", "npm uninstall -g @kilocode/cli")],
        "grok_cli" => vec![m("npm", "npm", "npm uninstall -g grok-cli")],
        "devin" => vec![m("native", "Native", "devin uninstall")],
        "rovo" => vec![m("native", "Native", "rm -f ~/.local/bin/acli")],
        "hermes" => vec![m("native", "Native", "rm -f ~/.local/bin/hermes")],
        "openclaw" => vec![m("npm", "npm", "npm uninstall -g openclaw")],
        "aug" => vec![m("npm", "npm", "npm uninstall -g @augmentcode/auggie")],
        "codebuff" => vec![m("npm", "npm", "npm uninstall -g codebuff")],
        "qwen_code" => vec![m("npm", "npm", "npm uninstall -g qwen-code")],
        "mimo_code" => vec![
            m(
                "native",
                "Native",
                "rm -f ~/.mimocode/bin/mimo ~/.local/bin/mimo",
            ),
            m("npm", "npm", "npm uninstall -g @mimo-ai/cli"),
        ],
        "antigravity" => vec![m("native", "Native", "rm -f ~/.local/bin/agy")],
        "continue_cli" => vec![m("npm", "npm", "npm uninstall -g @continuedev/cli")],
        "droid" => vec![m("npm", "npm", "npm uninstall -g droid")],
        "mistral_vibe" => vec![
            m("uv", "uv", "uv tool uninstall mistral-vibe"),
            m("pip", "pip", "pip uninstall mistral-vibe"),
        ],
        "autohand" => vec![m("npm", "npm", "npm uninstall -g autohand-cli")],
        "omp" => vec![
            m("bun", "Bun", "bun remove -g @oh-my-pi/pi-coding-agent"),
            m("npm", "npm", "npm uninstall -g @oh-my-pi/pi-coding-agent"),
        ],
        "pi" => vec![m(
            "npm",
            "npm",
            "npm uninstall -g @earendil-works/pi-coding-agent",
        )],
        // Neither project currently documents a non-destructive uninstall
        // command that the registry can safely run on every supported OS.
        "opencode" | "qoder_cli" | "trae_cli" => Vec::new(),
        // Same fail-loud principle as `cli_install_methods` above.
        other => {
            tracing::warn!(
                "[key_vault::registry] cli_uninstall_methods has no entry for CLI agent {:?}; \
                 the Uninstall UI will show no options",
                other
            );
            Vec::new()
        }
    }
}

/// Infer install method from the binary path returned by `which`/`where`.
///
/// Resolves symlinks first so that e.g. `~/.local/bin/poetry` →
/// `~/.local/pipx/venvs/poetry/bin/poetry` is detected as pip, while
/// `~/.local/bin/cursor` (a plain shell script from a curl installer) is
/// detected as curl.
pub(crate) fn infer_install_method(binary_path: &str) -> Option<String> {
    let resolved = std::fs::canonicalize(binary_path)
        .ok()
        .and_then(|p| p.to_str().map(String::from));
    let resolved_lower = resolved.as_deref().map(|s| s.to_lowercase());
    let original_lower = binary_path.to_lowercase();

    let either_contains = |pattern: &str| -> bool {
        original_lower.contains(pattern)
            || resolved_lower
                .as_deref()
                .is_some_and(|r| r.contains(pattern))
    };

    #[cfg(not(windows))]
    {
        if either_contains("/homebrew/")
            || either_contains("/cellar/")
            || either_contains("/linuxbrew/")
        {
            return Some("homebrew".into());
        }
        if either_contains("/node_modules/")
            || either_contains("/lib/node_modules/")
            || either_contains("/.nvm/")
            || either_contains("/.fnm/")
            || either_contains("/.volta/")
        {
            return Some("npm".into());
        }
        if either_contains("/.cargo/bin/") {
            return Some("cargo".into());
        }
        if either_contains("/snap/bin/") || either_contains("/snap/") {
            return Some("snap".into());
        }
        if either_contains("/pipx/")
            || either_contains("/pyenv/")
            || either_contains("/.pyenv/")
            || either_contains("/library/python/")
            || either_contains("/lib/python")
        {
            return Some("pip".into());
        }
        if either_contains("/.local/bin/") {
            return Some("curl".into());
        }
        if original_lower.starts_with("/usr/local/bin/") || original_lower.starts_with("/usr/bin/")
        {
            return Some("curl".into());
        }
    }

    #[cfg(windows)]
    {
        if either_contains(r"\node_modules\")
            || either_contains(r"\npm\")
            || either_contains(r"\nvm\")
            || either_contains(r"\fnm\")
            || either_contains(r"\volta\")
        {
            return Some("npm".into());
        }
        if either_contains(r"\scoop\") {
            return Some("scoop".into());
        }
        if either_contains(r"\cargo\bin\") {
            return Some("cargo".into());
        }
        if either_contains(r"\pipx\") || either_contains(r"\python") || either_contains(r"\pyenv\")
        {
            return Some("pip".into());
        }
        if either_contains(r"\program files") || either_contains(r"\appdata\local\programs") {
            return Some("native".into());
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qoder_cli_exposes_official_installers() {
        let methods = cli_install_methods("qoder_cli");

        assert_eq!(methods.len(), 3);
        assert!(methods
            .iter()
            .any(|method| method.command == "curl -fsSL https://qoder.com/install | bash"));
        assert!(methods
            .iter()
            .any(|method| method.command.contains("qoder.com/install.ps1")));
        assert!(methods
            .iter()
            .any(|method| method.command.contains("qoder.com/install.cmd")));
    }

    #[test]
    fn trae_cli_does_not_offer_an_undocumented_installer() {
        assert!(cli_install_methods("trae_cli").is_empty());
    }
}
