//! Code Map management tool — inspect and control Code Map indexing.
//!
//! Companion to the read-only `use_code_map` query tool. This tool owns index
//! lifecycle actions so agents can prepare the graph before using symbol search,
//! callers/callees, impact, or exploration.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use code_map::{cancel_index, clear_index, get_status, start_index, CodeMapStatus};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Mutex as TokioMutex;

use crate::security::SecurityPolicy;
use crate::session::workspace::SessionWorkspace;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_bool, optional_string, required_string, Tool, ToolError};

pub struct ManageCodeMapTool {
    default_workspace: PathBuf,
    active_repo: TokioMutex<Option<PathBuf>>,
    app_handle: Option<AppHandle>,
    workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    restrict_to_workspace: bool,
    security_policy: Option<Arc<SecurityPolicy>>,
}

impl ManageCodeMapTool {
    pub fn new(
        default_workspace: PathBuf,
        app_handle: Option<AppHandle>,
        workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    ) -> Self {
        Self {
            default_workspace,
            active_repo: TokioMutex::new(None),
            app_handle,
            workspace_state,
            restrict_to_workspace: false,
            security_policy: None,
        }
    }

    pub fn with_restrict_to_workspace(mut self, restricted: bool) -> Self {
        self.restrict_to_workspace = restricted;
        self
    }

    pub fn with_security_policy(mut self, policy: Arc<SecurityPolicy>) -> Self {
        self.security_policy = Some(policy);
        self
    }

    async fn resolve_workspace_path(&self, params: &Value) -> Result<PathBuf, ToolError> {
        if let Some(path) = optional_string(params, "workspace_path").map(PathBuf::from) {
            return self.authorize_workspace_path(path).await;
        }

        let active_path = self.active_repo.lock().await.clone();
        if let Some(path) = active_path {
            return self.authorize_workspace_path(path).await;
        }

        let path = self.workspace_state.read().working_dir().to_path_buf();
        self.authorize_workspace_path(path).await
    }

    async fn authorize_workspace_path(&self, path: PathBuf) -> Result<PathBuf, ToolError> {
        let workspace_only = self
            .security_policy
            .as_ref()
            .is_some_and(|policy| policy.workspace_only);
        let containment_required = self.restrict_to_workspace || workspace_only;
        let current_workspace = self.workspace_state.read().working_dir().to_path_buf();
        let mut extra = self.workspace_state.read().effective_roots();
        extra.extend(self.active_repo.lock().await.clone());

        // Preserve the legacy selected-workspace base for explicit relative
        // paths without making open policy enforce containment.
        if let Some(policy) = self.security_policy.as_deref() {
            policy
                .validate_path_syntax(&path.to_string_lossy())
                .map_err(map_path_error)?;
        }
        let resolved_input = if path.is_absolute() {
            path.clone()
        } else {
            current_workspace.join(path)
        };
        crate::security::global_path_exemptions::authorize_path(
            &resolved_input.to_string_lossy(),
            containment_required.then_some(current_workspace.as_path()),
            &extra,
            self.security_policy.as_deref(),
        )
        .map_err(map_path_error)
        .map(|authorized| authorized.canonicalize().unwrap_or(authorized))
    }

    async fn execute_status(&self, params: &Value) -> Result<String, ToolError> {
        let workspace_path = self.resolve_workspace_path(params).await?;
        let status = get_status(workspace_path)
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        serialize_status_with_next_step(&status)
    }

    async fn execute_index(&self, params: &Value, force: bool) -> Result<String, ToolError> {
        let workspace_path = self.resolve_workspace_path(params).await?;
        let status = start_index(self.app_handle.clone(), workspace_path, force)
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        serialize_status_with_next_step(&status)
    }

    async fn execute_cancel(&self, params: &Value) -> Result<String, ToolError> {
        let workspace_path = self.resolve_workspace_path(params).await?;
        let cancelled = cancel_index(workspace_path.clone())
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        let status = get_status(workspace_path)
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        serialize_json(&json!({
            "cancelled": cancelled,
            "status": status,
            "nextStep": if cancelled {
                "Index cancellation was requested. Use status to confirm the final state before querying Code Map."
            } else {
                "No active Code Map index task was running for this workspace."
            }
        }))
    }

    async fn execute_clear(&self, params: &Value) -> Result<String, ToolError> {
        let workspace_path = self.resolve_workspace_path(params).await?;
        let confirmed = optional_bool(params, "confirm").unwrap_or(false);
        if !confirmed {
            return Err(ToolError::InvalidParams(
                "`clear` requires `confirm: true` because it deletes the local Code Map index for the workspace.".to_string(),
            ));
        }
        let status = clear_index(workspace_path)
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        serialize_json(&json!({
            "status": status,
            "nextStep": "The local Code Map index was cleared. Use index or reindex before running symbol graph queries."
        }))
    }
}

fn map_path_error(err: String) -> ToolError {
    if err.contains("outside the allowed directory")
        || err.contains("null byte")
        || err.contains("forbidden location")
        || err.contains("Path traversal")
        || err.contains("URL-encoded path traversal")
    {
        ToolError::PermissionDenied(err)
    } else {
        ToolError::ExecutionFailed(err)
    }
}

#[async_trait]
impl Tool for ManageCodeMapTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_CODE_MAP
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn search_hint(&self) -> &str {
        "manage code map index reindex clear cancel status symbol graph"
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn description(&self) -> &str {
        "Manage the local Code Map index for the current workspace.\n\n\
         Use this tool to prepare or reset the persistent symbol graph that the `use_code_map` query tool reads. Call it before repository-scale Code Map queries when index readiness is unknown, and pass `workspace_path` when the user asks about a specific workspace.\n\n\
         Actions:\n\
         - `status` — inspect index state, freshness, counts, progress, and index size\n\
         - `index` — run an incremental index if the workspace is new, stale, or not indexed\n\
         - `reindex` — force a full rebuild after parser/config changes, persistent failures, or suspicious results\n\
         - `cancel` — request cancellation for an active index task\n\
         - `clear` — delete the local Code Map index; requires `confirm: true`\n\n\
         Workflow: call `status`; if ready, use `use_code_map`; if not_indexed or stale, call `index`; if failed or results look corrupted, call `reindex`; avoid `clear` unless the user asked to reset/delete the local index."
    }

    fn llm_description(&self) -> Option<String> {
        let workspace = self
            .workspace_state
            .try_read()
            .map(|state| state.working_dir().display().to_string())
            .unwrap_or_else(|| self.default_workspace.display().to_string());
        Some(format!(
            "Manage the local Code Map index for {workspace}. Call status before repository-scale use_code_map queries when readiness is unknown; call index for not_indexed/stale workspaces; call reindex for failed or suspicious indexes; pass workspace_path for a specific workspace. Actions: status, index, reindex, cancel, clear. clear requires confirm=true and should only be used when the user wants to reset/delete the local index."
        ))
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "index", "reindex", "cancel", "clear"],
                    "description": "Code Map index lifecycle action to perform."
                },
                "workspace_path": {
                    "type": "string",
                    "description": "Workspace path whose local Code Map index should be managed. Defaults to the active workspace."
                },
                "confirm": {
                    "type": "boolean",
                    "description": "Required as true for clear because it deletes the local Code Map index."
                }
            },
            "required": ["action"]
        })
    }

    async fn set_active_repo(&self, repo_path: &str) {
        let path = PathBuf::from(repo_path);
        if path.exists() {
            *self.active_repo.lock().await = Some(path);
        }
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let action = required_string(&params, "action")?;
        match action.as_str() {
            "status" => self.execute_status(&params).await,
            "index" => self.execute_index(&params, false).await,
            "reindex" => self.execute_index(&params, true).await,
            "cancel" => self.execute_cancel(&params).await,
            "clear" => self.execute_clear(&params).await,
            _ => Err(ToolError::InvalidParams(format!(
                "Unknown action '{}'. Use: status, index, reindex, cancel, clear",
                action
            ))),
        }
    }
}

fn serialize_status_with_next_step(status: &CodeMapStatus) -> Result<String, ToolError> {
    let next_step = match status.status.as_str() {
        "not_indexed" => "Run index before using the use_code_map query tool.",
        "stale" => "Run index to refresh stale files before relying on relationship results.",
        "indexing" => "Wait for indexing to finish or use cancel if it should stop.",
        "ready" => "Use the use_code_map query tool for search, node inspection, callers, callees, impact, or explore.",
        "failed" => "Review the error, fix the workspace issue, then run reindex.",
        "cancelled" => "Run index or reindex when you want to rebuild the Code Map index.",
        _ => "Use status again if you need the latest Code Map state.",
    };
    serialize_json(&json!({
        "status": status,
        "nextStep": next_step,
    }))
}

fn serialize_json<T: serde::Serialize>(value: &T) -> Result<String, ToolError> {
    serde_json::to_string_pretty(value).map_err(|err| ToolError::ExecutionFailed(err.to_string()))
}

#[cfg(test)]
#[path = "manage_code_map_tests.rs"]
mod tests;
