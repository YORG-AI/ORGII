use app_paths as paths;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GenericCliConfigFormat {
    Json,
    Jsonc,
    Toml,
    Yaml,
    Text,
}

#[derive(Debug, Clone, Copy)]
enum ConfigBase {
    Home,
    XdgConfig,
    AppData,
    GooseConfig,
}

#[derive(Debug, Clone, Copy)]
struct AllowedCliConfig {
    agent_name: &'static str,
    file_id: &'static str,
    base: ConfigBase,
    relative_path: &'static str,
    format: GenericCliConfigFormat,
}

const ALLOWED_CLI_CONFIGS: &[AllowedCliConfig] = &[
    cfg(
        "cursor_cli",
        "cli",
        ConfigBase::Home,
        ".cursor/cli-config.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "claude_code",
        "settings",
        ConfigBase::Home,
        ".claude/settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "codex",
        "config",
        ConfigBase::Home,
        ".codex/config.toml",
        GenericCliConfigFormat::Toml,
    ),
    cfg(
        "kiro",
        "settings",
        ConfigBase::Home,
        ".kiro/settings/cli.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "kiro",
        "mcp",
        ConfigBase::Home,
        ".kiro/settings/mcp.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "copilot",
        "settings",
        ConfigBase::Home,
        ".copilot/settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "copilot",
        "mcp",
        ConfigBase::Home,
        ".copilot/mcp-config.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "copilot",
        "permissions",
        ConfigBase::Home,
        ".copilot/permissions-config.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "kimi_cli",
        "config",
        ConfigBase::Home,
        ".kimi-code/config.toml",
        GenericCliConfigFormat::Toml,
    ),
    cfg(
        "kimi_cli",
        "tui",
        ConfigBase::Home,
        ".kimi-code/tui.toml",
        GenericCliConfigFormat::Toml,
    ),
    cfg(
        "opencode",
        "config",
        ConfigBase::XdgConfig,
        "opencode/opencode.jsonc",
        GenericCliConfigFormat::Jsonc,
    ),
    cfg(
        "aider",
        "config",
        ConfigBase::Home,
        ".aider.conf.yml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "goose",
        "config",
        ConfigBase::GooseConfig,
        "config.yaml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "goose",
        "secrets",
        ConfigBase::GooseConfig,
        "secrets.yaml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "goose",
        "permissions",
        ConfigBase::GooseConfig,
        "permission.yaml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "amp",
        "settings",
        ConfigBase::XdgConfig,
        "amp/settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "cline",
        "providers",
        ConfigBase::Home,
        ".cline/data/settings/providers.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "cline",
        "settings",
        ConfigBase::Home,
        ".cline/data/settings/global-settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "cline",
        "mcp",
        ConfigBase::Home,
        ".cline/data/settings/cline_mcp_settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "kilo",
        "config",
        ConfigBase::XdgConfig,
        "kilo/kilo.jsonc",
        GenericCliConfigFormat::Jsonc,
    ),
    cfg(
        "devin",
        "config",
        ConfigBase::AppData,
        "devin/config.json",
        GenericCliConfigFormat::Jsonc,
    ),
    cfg(
        "rovo",
        "config",
        ConfigBase::Home,
        ".rovodev/config.yml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "rovo",
        "mcp",
        ConfigBase::Home,
        ".rovodev/mcp.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "hermes",
        "config",
        ConfigBase::Home,
        ".hermes/config.yaml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "hermes",
        "soul",
        ConfigBase::Home,
        ".hermes/SOUL.md",
        GenericCliConfigFormat::Text,
    ),
    cfg(
        "openclaw",
        "config",
        ConfigBase::Home,
        ".openclaw/openclaw.json",
        GenericCliConfigFormat::Jsonc,
    ),
    cfg(
        "aug",
        "settings",
        ConfigBase::Home,
        ".augment/.auggie.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "qwen_code",
        "settings",
        ConfigBase::Home,
        ".qwen/settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "mimo_code",
        "config",
        ConfigBase::XdgConfig,
        "mimocode/mimocode.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "mimo_code",
        "tui",
        ConfigBase::XdgConfig,
        "mimocode/tui.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "continue_cli",
        "config",
        ConfigBase::Home,
        ".continue/config.yaml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "continue_cli",
        "advanced",
        ConfigBase::Home,
        ".continue/config.ts",
        GenericCliConfigFormat::Text,
    ),
    cfg(
        "continue_cli",
        "permissions",
        ConfigBase::Home,
        ".continue/permissions.yaml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "droid",
        "settings",
        ConfigBase::Home,
        ".factory/settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "droid",
        "local",
        ConfigBase::Home,
        ".factory/settings.local.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "droid",
        "mcp",
        ConfigBase::Home,
        ".factory/mcp.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "mistral_vibe",
        "config",
        ConfigBase::Home,
        ".vibe/config.toml",
        GenericCliConfigFormat::Toml,
    ),
    cfg(
        "mistral_vibe",
        "env",
        ConfigBase::Home,
        ".vibe/.env",
        GenericCliConfigFormat::Text,
    ),
    cfg(
        "autohand",
        "config",
        ConfigBase::Home,
        ".autohand/config.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "omp",
        "models",
        ConfigBase::Home,
        ".oh-omp/agent/models.yml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "omp",
        "settings",
        ConfigBase::Home,
        ".oh-omp/agent/config.yml",
        GenericCliConfigFormat::Yaml,
    ),
    cfg(
        "pi",
        "settings",
        ConfigBase::Home,
        ".pi/agent/settings.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "pi",
        "models",
        ConfigBase::Home,
        ".pi/agent/models.json",
        GenericCliConfigFormat::Json,
    ),
    cfg(
        "pi",
        "auth",
        ConfigBase::Home,
        ".pi/agent/auth.json",
        GenericCliConfigFormat::Json,
    ),
];

const fn cfg(
    agent_name: &'static str,
    file_id: &'static str,
    base: ConfigBase,
    relative_path: &'static str,
    format: GenericCliConfigFormat,
) -> AllowedCliConfig {
    AllowedCliConfig {
        agent_name,
        file_id,
        base,
        relative_path,
        format,
    }
}

fn xdg_config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths::home_dir().join(".config"))
}

fn app_data_home() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths::home_dir().join(".config"))
}

fn goose_config_home() -> PathBuf {
    if let Some(root) = std::env::var_os("GOOSE_PATH_ROOT") {
        return PathBuf::from(root).join("config");
    }

    #[cfg(target_os = "windows")]
    {
        app_data_home().join("Block").join("goose").join("config")
    }

    #[cfg(not(target_os = "windows"))]
    {
        xdg_config_home().join("goose")
    }
}

fn safe_join(base: PathBuf, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err("Config path must be relative".to_string());
    }
    if relative
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Config path cannot escape its base directory".to_string());
    }
    Ok(base.join(relative))
}

fn resolve_config(
    agent_name: &str,
    file_id: &str,
) -> Result<(PathBuf, GenericCliConfigFormat), String> {
    let config = ALLOWED_CLI_CONFIGS
        .iter()
        .find(|entry| entry.agent_name == agent_name && entry.file_id == file_id)
        .ok_or_else(|| format!("Unsupported CLI config file: {agent_name}/{file_id}"))?;
    let base = match config.base {
        ConfigBase::Home => paths::home_dir(),
        ConfigBase::XdgConfig => xdg_config_home(),
        ConfigBase::AppData => app_data_home(),
        ConfigBase::GooseConfig => goose_config_home(),
    };
    Ok((safe_join(base, config.relative_path)?, config.format))
}

pub(crate) fn resolve_config_path(agent_name: &str, file_id: &str) -> Result<PathBuf, String> {
    resolve_config(agent_name, file_id).map(|(path, _)| path)
}

fn nearest_existing_reveal_target(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return Ok(path.to_path_buf());
    }
    let mut current = path.parent();
    while let Some(candidate) = current {
        if candidate.exists() {
            return Ok(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    Err(format!(
        "No existing parent directory for {}",
        path.display()
    ))
}

fn reveal_path(path: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let result = if path.is_file() {
            Command::new("open").arg("-R").arg(&path).spawn()
        } else {
            Command::new("open").arg(&path).spawn()
        };
        return result
            .map(|_| ())
            .map_err(|err| format!("Failed to open in Finder: {err}"));
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        if path.is_file() {
            cmd.arg(format!("/select,{}", path.display()));
        } else {
            cmd.arg(&path);
        }
        app_platform::hide_console(&mut cmd);
        return cmd
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Failed to open in Explorer: {err}"));
    }

    #[cfg(target_os = "linux")]
    {
        let target = if path.is_file() {
            path.parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "Failed to get parent directory".to_string())?
        } else {
            path
        };
        let mut cmd = Command::new("xdg-open");
        cmd.arg(target);
        app_platform::hide_console(&mut cmd);
        return cmd
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Failed to open file manager: {err}"));
    }

    #[allow(unreachable_code)]
    Err("Unsupported operating system".to_string())
}

fn validate_content(format: GenericCliConfigFormat, content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Ok(());
    }
    match format {
        GenericCliConfigFormat::Json => {
            let _: serde_json::Value =
                serde_json::from_str(content).map_err(|err| format!("Invalid JSON: {err}"))?;
        }
        GenericCliConfigFormat::Toml => {
            let _: toml::Value =
                toml::from_str(content).map_err(|err| format!("Invalid TOML: {err}"))?;
        }
        GenericCliConfigFormat::Jsonc
        | GenericCliConfigFormat::Yaml
        | GenericCliConfigFormat::Text => {}
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_file_get_path(
    agent_name: String,
    file_id: String,
) -> Result<String, String> {
    let (path, _) = resolve_config(&agent_name, &file_id)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_file_read_raw(
    agent_name: String,
    file_id: String,
) -> Result<String, String> {
    let (path, _) = resolve_config(&agent_name, &file_id)?;
    if !path.exists() {
        return Ok(String::new());
    }
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read {}: {err}", path.display()))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_file_reveal(agent_name: String, file_id: String) -> Result<(), String> {
    let (path, _) = resolve_config(&agent_name, &file_id)?;
    tokio::task::spawn_blocking(move || reveal_path(nearest_existing_reveal_target(&path)?))
        .await
        .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cli_config_file_write_raw(
    agent_name: String,
    file_id: String,
    content: String,
) -> Result<(), String> {
    let (path, format) = resolve_config(&agent_name, &file_id)?;
    tokio::task::spawn_blocking(move || {
        validate_content(format, &content)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|err| format!("Failed to create {}: {err}", dir.display()))?;
        }
        std::fs::write(&path, &content)
            .map_err(|err| format!("Failed to write {}: {err}", path.display()))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
