//! Workspace management tool.
//!
//! Unified tool for managing orgii workspaces (git repositories and work folders)
//! tracked by the IDE. Consolidates list / add / create / remove into a
//! single `manage_workspace` tool with an `action` parameter.
//!
//! Actions:
//! - `list`   — Enumerate all workspaces currently tracked.
//! - `add`    — Register an existing local directory (auto-detects git vs folder).
//! - `create` — Create a new empty workspace (git repo or plain folder).
//! - `remove` — Unregister a workspace (files on disk are untouched).
//!
//! All actions delegate to `git::repos::repo_service`, the same layer
//! the Tauri commands use, so human UI and agent share one implementation.

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params_described, Tool, ToolError};
use git::repos::repo_db::RepoRecord;
use git::repos::repo_service;

// ============================================
// Params
// ============================================

/// Flat params: tagged-enum schemas (top-level `oneOf`) get flattened to an
/// empty schema by LLM providers, so the model never sees the fields. Keep
/// this a plain object with scalar properties; per-action requiredness is
/// enforced in `execute_text` with self-correcting error messages.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ManageWorkspaceParams {
    /// Operation to perform. One of: `list` (enumerate tracked workspaces),
    /// `add` (register an existing directory), `create` (create a new empty
    /// workspace), `remove` (unregister; files on disk are untouched).
    pub action: String,
    /// Absolute path to the workspace directory. Required for `add` and
    /// `create`; for `remove` provide either `path` or `repo_id`.
    #[serde(default)]
    pub path: Option<String>,
    /// `add`/`create` only: optional display name (defaults to the directory
    /// basename).
    #[serde(default)]
    pub name: Option<String>,
    /// `create` only: when true (default) the new workspace is initialised
    /// as a git repo. Set to false for a plain work folder.
    #[serde(default)]
    pub git: Option<bool>,
    /// `remove` only: repo identifier (usually the canonical path).
    /// Alternative to `path`.
    #[serde(default)]
    pub repo_id: Option<String>,
}

fn require_path(params: &ManageWorkspaceParams, action: &str) -> Result<String, ToolError> {
    params.path.clone().ok_or_else(|| {
        ToolError::InvalidParams(format!(
            "`{action}` requires `path` — the absolute directory path"
        ))
    })
}

// ============================================
// Tool
// ============================================

/// Unified workspace management tool.
#[derive(Default)]
pub struct ManageWorkspaceTool;

impl ManageWorkspaceTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for ManageWorkspaceTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_WORKSPACE
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn search_hint(&self) -> &str {
        "workspace folder directory repo add register create remove track project"
    }

    fn description(&self) -> &str {
        "Manage orgii workspaces (git repositories and work folders) tracked by the IDE.\n\n\
         ## Actions\n\
         - **list**   — List all currently tracked workspaces with names, absolute paths, and kinds (git/folder). Use this FIRST when the user mentions a project by name — it's instant and avoids slow filesystem searches.\n\
         - **add**    — Register an existing local directory as a workspace. Kind (git / folder) is auto-detected from the presence of `.git`.\n\
         - **create** — Create a new empty workspace. Defaults to `git=true` (runs `git init`); set `git=false` for a plain work folder.\n\
         - **remove** — Unregister a workspace. Files on disk are NOT deleted — only the tracked entry.\n\n\
         ## Cloning repositories\n\
         This tool does not clone. To clone a remote repo, use `run_shell` with `git clone`, wait for the process to exit with `await_output` if it backgrounds, then register the cloned path with `manage_workspace` action `add`.\n\n\
         ## Examples\n\
         - `{\"action\": \"list\"}`\n\
         - `{\"action\": \"add\", \"path\": \"/Users/me/code/my-app\"}`\n\
         - `{\"action\": \"create\", \"path\": \"/Users/me/code/new-thing\", \"git\": true}`\n\
         - `{\"action\": \"remove\", \"path\": \"/Users/me/code/old-thing\"}`"
    }

    fn parameters(&self) -> Value {
        params_schema::<ManageWorkspaceParams>()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let params: ManageWorkspaceParams = parse_params_described(params)?;
        match params.action.as_str() {
            "list" => exec_list().await,
            "add" => {
                let path = require_path(&params, "add")?;
                exec_add(path, params.name.clone()).await
            }
            "create" => {
                let path = require_path(&params, "create")?;
                exec_create(path, params.name.clone(), params.git.unwrap_or(true)).await
            }
            "remove" => exec_remove(params.path.as_deref(), params.repo_id.as_deref()).await,
            other => Err(ToolError::InvalidParams(format!(
                "unknown action \"{other}\"; valid actions: `list`, `add`, `create`, `remove`"
            ))),
        }
    }
}

// ============================================
// Action implementations
// ============================================

/// Format a single repo record as `[kind] name → path`.
fn format_entry(repo: &RepoRecord) -> String {
    format!("[{}] {} → {}", repo.kind.as_str(), repo.name, repo.path)
}

fn into_tool_err(err: String) -> ToolError {
    ToolError::ExecutionFailed(err)
}

async fn exec_list() -> Result<String, ToolError> {
    let repos = repo_service::list().await.map_err(into_tool_err)?;

    if repos.is_empty() {
        return Ok("No workspaces are currently tracked.".to_string());
    }

    let mut lines: Vec<String> = repos.iter().map(format_entry).collect();
    lines.sort();

    Ok(format!(
        "Workspaces ({}):\n{}",
        lines.len(),
        lines.join("\n")
    ))
}

async fn exec_add(path: String, name: Option<String>) -> Result<String, ToolError> {
    let record = repo_service::import_auto(path, name)
        .await
        .map_err(into_tool_err)?;
    Ok(format!("Added workspace (1):\n{}", format_entry(&record)))
}

async fn exec_create(path: String, name: Option<String>, git: bool) -> Result<String, ToolError> {
    let record = if git {
        repo_service::create_empty_repo(path, name)
            .await
            .map_err(into_tool_err)?
    } else {
        repo_service::create_folder(path, name)
            .await
            .map_err(into_tool_err)?
    };
    Ok(format!("Created workspace (1):\n{}", format_entry(&record)))
}

async fn exec_remove(path: Option<&str>, repo_id: Option<&str>) -> Result<String, ToolError> {
    let target_id = match (repo_id, path) {
        (Some(id), _) if !id.trim().is_empty() => id.to_string(),
        (_, Some(p)) if !p.trim().is_empty() => std::path::Path::new(p)
            .canonicalize()
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string()),
        _ => {
            return Err(ToolError::InvalidParams(
                "Provide either `path` or `repo_id` to remove.".to_string(),
            ));
        }
    };

    let removed = repo_service::remove(target_id.clone())
        .await
        .map_err(into_tool_err)?;

    match removed {
        Some(record) => Ok(format!("Removed workspace (1):\n{}", format_entry(&record))),
        None => Err(ToolError::InvalidParams(format!(
            "No workspace tracked for '{}'. Use the `list` action to see tracked workspaces.",
            target_id
        ))),
    }
}
