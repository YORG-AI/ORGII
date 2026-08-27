//! LSP management tool — inspect, configure, and control language servers.
//!
//! Exposes the existing LSP management layer to the coding agent without
//! executing package-manager commands directly. Install and uninstall actions
//! return the command that should be run via `run_shell`.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::tools::names as tool_names;
use crate::tools::traits::{optional_string, required_string, Tool, ToolError};
use lsp::commands::{
    lsp_check_installed, lsp_get_install_command, lsp_get_supported_languages,
    lsp_get_uninstall_command, InstallCommandResult, LanguageServerInfo, UninstallCommandResult,
};
use lsp::server_defs::servers_for_language_id;
use lsp::workspace_config::{lsp_get_workspace_config, lsp_set_server_enabled, WorkspaceLspConfig};
use lsp::LspManager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedLspListEntry {
    #[serde(flatten)]
    info: LanguageServerInfo,
    running: bool,
    workspace_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedLspStatusResult {
    workspace_path: String,
    language: String,
    display_name: String,
    command: String,
    install_hint: String,
    installed: bool,
    uninstall_supported: bool,
    running: bool,
    workspace_enabled: bool,
    install_command: InstallCommandResult,
    uninstall_command: UninstallCommandResult,
}

pub struct ManageLspTool {
    lsp_manager: Arc<Mutex<LspManager>>,
    app_handle: AppHandle,
    workspace_root: PathBuf,
}

impl ManageLspTool {
    pub fn new(
        lsp_manager: Arc<Mutex<LspManager>>,
        app_handle: AppHandle,
        workspace_root: PathBuf,
    ) -> Self {
        Self {
            lsp_manager,
            app_handle,
            workspace_root,
        }
    }

    fn resolve_workspace_path(&self, params: &Value) -> String {
        resolve_path_or_default(
            optional_string(params, "workspace_path"),
            &self.workspace_root,
        )
    }

    fn resolve_root_path(&self, params: &Value) -> String {
        if let Some(root_path) = optional_string(params, "root_path") {
            return resolve_path_or_default(Some(root_path), &self.workspace_root);
        }

        self.resolve_workspace_path(params)
    }

    fn require_language(&self, params: &Value) -> Result<String, ToolError> {
        let language = normalize_language(&required_string(params, "language")?);
        validate_supported_language(&language)?;
        Ok(language)
    }

    async fn find_language_info(&self, language: &str) -> Result<LanguageServerInfo, ToolError> {
        let installed_servers = lsp_check_installed().await;
        installed_servers
            .into_iter()
            .find(|server_info| server_info.language == language)
            .ok_or_else(|| {
                ToolError::InvalidParams(format!(
                    "Unsupported language '{}'. Use the list action to inspect supported LSP servers.",
                    language
                ))
            })
    }

    async fn execute_list(&self, params: &Value) -> Result<String, ToolError> {
        let workspace_path = self.resolve_workspace_path(params);
        let workspace_config = lsp_get_workspace_config(workspace_path.clone());
        let installed_servers = lsp_check_installed().await;

        let running_servers = {
            let manager = self.lsp_manager.lock().await;
            manager.get_running_servers().await
        };
        let running_server_set: HashSet<String> = running_servers.into_iter().collect();

        // Dedupe: `LANGUAGE_DISPLAY_NAMES` lists both `c` and `cpp` (same
        // clangd binary) as separate entries to drive the frontend
        // language selector. For the agent-facing list we collapse rows
        // that share the same backing `command` so the agent doesn't see
        // phantom "two C/C++ servers" entries. We keep the first `language`
        // we encounter as the canonical id (matches the order in
        // LANGUAGE_DISPLAY_NAMES — `c` before `cpp`, but the IDs the
        // LspManager actually keys servers by are still the canonical
        // `id()` strings, so `running` works either way).
        let mut seen_commands: HashSet<String> = HashSet::new();
        let servers: Vec<ManagedLspListEntry> = installed_servers
            .into_iter()
            .filter(|server_info| seen_commands.insert(server_info.command.clone()))
            .map(|server_info| {
                // The LspManager keys running servers by `server_def.id()`,
                // not by every alias in `LANGUAGE_DISPLAY_NAMES`. Look up
                // `running` against the same id the manager uses.
                let canonical_id = canonical_server_id(&server_info.language);
                ManagedLspListEntry {
                    running: running_server_set.contains(canonical_id.as_str()),
                    workspace_enabled: is_language_enabled_in_workspace(
                        &workspace_config,
                        &server_info.language,
                    ),
                    info: server_info,
                }
            })
            .collect();

        serialize_pretty(&json!({
            "workspacePath": workspace_path,
            "count": servers.len(),
            "servers": servers,
        }))
    }

    async fn execute_running(&self) -> Result<String, ToolError> {
        let mut running_servers = {
            let manager = self.lsp_manager.lock().await;
            manager.get_running_servers().await
        };
        running_servers.sort();

        serialize_pretty(&json!({
            "count": running_servers.len(),
            "runningServers": running_servers,
        }))
    }

    async fn execute_status(&self, params: &Value) -> Result<String, ToolError> {
        let language = self.require_language(params)?;
        let workspace_path = self.resolve_workspace_path(params);
        let workspace_config = lsp_get_workspace_config(workspace_path.clone());
        let server_info = self.find_language_info(&language).await?;
        let running = {
            let manager = self.lsp_manager.lock().await;
            manager.is_server_running(&language).await
        };

        let status = ManagedLspStatusResult {
            workspace_path,
            language: server_info.language.clone(),
            display_name: server_info.display_name,
            command: server_info.command,
            install_hint: server_info.install_hint,
            installed: server_info.installed,
            uninstall_supported: server_info.uninstall_supported,
            running,
            workspace_enabled: is_language_enabled_in_workspace(&workspace_config, &language),
            install_command: lsp_get_install_command(language.clone()),
            uninstall_command: lsp_get_uninstall_command(language),
        };

        serialize_pretty(&status)
    }

    async fn execute_install_command(&self, params: &Value) -> Result<String, ToolError> {
        let language = self.require_language(params)?;
        let result = lsp_get_install_command(language.clone());

        serialize_pretty(&json!({
            "language": language,
            "result": result,
            "nextStep": "Use run_shell with the returned command if you want to install this LSP server.",
        }))
    }

    async fn execute_uninstall_command(&self, params: &Value) -> Result<String, ToolError> {
        let language = self.require_language(params)?;
        let result = lsp_get_uninstall_command(language.clone());

        serialize_pretty(&json!({
            "language": language,
            "result": result,
            "nextStep": "Use run_shell with the returned command if you want to uninstall this LSP server.",
        }))
    }

    async fn execute_set_enabled(
        &self,
        params: &Value,
        enabled: bool,
    ) -> Result<String, ToolError> {
        let language = self.require_language(params)?;
        let workspace_path = self.resolve_workspace_path(params);

        lsp_set_server_enabled(workspace_path.clone(), language.clone(), enabled)
            .map_err(ToolError::ExecutionFailed)?;

        let workspace_config = lsp_get_workspace_config(workspace_path.clone());
        let workspace_enabled = is_language_enabled_in_workspace(&workspace_config, &language);

        serialize_pretty(&json!({
            "language": language,
            "workspacePath": workspace_path,
            "workspaceEnabled": workspace_enabled,
        }))
    }

    async fn execute_start(&self, params: &Value) -> Result<String, ToolError> {
        let language = self.require_language(params)?;
        let root_path = self.resolve_root_path(params);

        let running = {
            let manager = self.lsp_manager.lock().await;
            manager
                .start_server(&language, &root_path, self.app_handle.clone())
                .await
                .map_err(ToolError::ExecutionFailed)?;
            manager.is_server_running(&language).await
        };

        serialize_pretty(&json!({
            "language": language,
            "rootPath": root_path,
            "running": running,
        }))
    }

    async fn execute_stop(&self, params: &Value) -> Result<String, ToolError> {
        let language = self.require_language(params)?;

        let running = {
            let manager = self.lsp_manager.lock().await;
            manager
                .stop_server(&language)
                .await
                .map_err(ToolError::ExecutionFailed)?;
            manager.is_server_running(&language).await
        };

        serialize_pretty(&json!({
            "language": language,
            "running": running,
        }))
    }
}

#[async_trait]
impl Tool for ManageLspTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_LSP
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn description(&self) -> &str {
        "Manage language servers for the current workspace.\n\n\
         Actions:\n\
         - `list` — list supported LSP servers with installed, running, and workspace-enabled status\n\
         - `running` — list currently running LSP servers\n\
         - `status` — inspect one language server in detail\n\
         - `install_command` — return the command needed to install a language server\n\
         - `uninstall_command` — return the command needed to uninstall a language server\n\
         - `enable` / `disable` — enable or disable a language server for the workspace\n\
         - `start` / `stop` — start or stop a language server process\n\n\
         This tool does not execute install or uninstall commands directly. Use `run_shell` with the returned command when you want to make system changes."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list",
                        "running",
                        "status",
                        "install_command",
                        "uninstall_command",
                        "enable",
                        "disable",
                        "start",
                        "stop"
                    ],
                    "description": "LSP management action to perform."
                },
                "language": {
                    "type": "string",
                    "description": "Language server identifier such as 'typescript', 'rust', or 'python'. Required for status, install_command, uninstall_command, enable, disable, start, and stop."
                },
                "workspace_path": {
                    "type": "string",
                    "description": "Workspace path for workspace-level enable/disable/status checks. Defaults to the active workspace."
                },
                "root_path": {
                    "type": "string",
                    "description": "Root path used when starting a server. Defaults to workspace_path or the active workspace."
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let action = required_string(&params, "action")?;

        match action.as_str() {
            "list" => self.execute_list(&params).await,
            "running" => self.execute_running().await,
            "status" => self.execute_status(&params).await,
            "install_command" => self.execute_install_command(&params).await,
            "uninstall_command" => self.execute_uninstall_command(&params).await,
            "enable" => self.execute_set_enabled(&params, true).await,
            "disable" => self.execute_set_enabled(&params, false).await,
            "start" => self.execute_start(&params).await,
            "stop" => self.execute_stop(&params).await,
            _ => Err(ToolError::InvalidParams(format!(
                "Unknown action '{}'. Use: list, running, status, install_command, uninstall_command, enable, disable, start, stop",
                action
            ))),
        }
    }
}

pub(crate) fn normalize_language(language: &str) -> String {
    let normalized = language.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "ts" | "tsx" | "typescriptreact" => "typescript".to_string(),
        "js" | "jsx" | "mjs" | "cjs" | "javascriptreact" => "javascript".to_string(),
        "py" | "pyi" => "python".to_string(),
        "rs" => "rust".to_string(),
        "yml" => "yaml".to_string(),
        "md" | "mdx" => "markdown".to_string(),
        "sh" | "bash" | "zsh" | "shell" => "shellscript".to_string(),
        "c++" => "cpp".to_string(),
        _ => normalized,
    }
}

fn validate_supported_language(language: &str) -> Result<(), ToolError> {
    let supported_languages = lsp_get_supported_languages();
    if supported_languages
        .iter()
        .any(|(supported_language, _install_hint)| supported_language == language)
    {
        return Ok(());
    }

    let supported_names: Vec<String> = supported_languages
        .into_iter()
        .map(|(supported_language, _install_hint)| supported_language)
        .collect();
    Err(ToolError::InvalidParams(format!(
        "Unsupported language '{}'. Supported languages: {}",
        language,
        supported_names.join(", ")
    )))
}

pub(crate) fn is_language_enabled_in_workspace(
    config: &WorkspaceLspConfig,
    language: &str,
) -> bool {
    !config
        .disabled
        .iter()
        .any(|disabled_language| disabled_language == language)
}

/// Map a `language_id` (the alias the agent passes, e.g. `"c"` or
/// `"javascript"`) to the canonical `server_id` the `LspManager` keys
/// running servers by (e.g. `"cpp"` or `"typescript"`). Falls back to
/// the input string when no server matches — `is_server_running` /
/// running-server-set lookups will then naturally return false, matching
/// the "no server known for this language" semantic.
fn canonical_server_id(language: &str) -> String {
    servers_for_language_id(language)
        .first()
        .map(|server_def| server_def.id().to_string())
        .unwrap_or_else(|| language.to_string())
}

pub(crate) fn resolve_path_or_default(path: Option<String>, default_path: &Path) -> String {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_path.to_string_lossy().to_string())
}

fn serialize_pretty<T: Serialize>(value: &T) -> Result<String, ToolError> {
    serde_json::to_string_pretty(value).map_err(|error| {
        ToolError::ExecutionFailed(format!("Failed to serialize manage_lsp result: {}", error))
    })
}

#[cfg(test)]
mod tests;
