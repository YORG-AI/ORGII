//! Code, file, and symbol search tool.
//!
//! Thin wrapper over `tool_service::search` — the shared implementation
//! used by both this agent tool and Tauri search commands.
//!
//! When `ActionRouter` is present and in "work_station" mode, `code`
//! searches are routed through the frontend ActionSystem (`search.codebase`).

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use super::action_router::ActionRouter;
use crate::session::workspace::SessionWorkspace;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_int, optional_string, required_string, Tool, ToolError};

fn optional_string_array(params: &Value, key: &str) -> Result<Option<Vec<String>>, ToolError> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    let Some(array) = value.as_array() else {
        return Err(ToolError::InvalidParams(format!(
            "parameter '{}' must be an array of strings",
            key
        )));
    };
    let mut paths = Vec::with_capacity(array.len());
    for item in array {
        let Some(path) = item.as_str() else {
            return Err(ToolError::InvalidParams(format!(
                "parameter '{}' must contain only strings",
                key
            )));
        };
        paths.push(path.to_string());
    }
    Ok(Some(paths))
}

fn has_explicit_repo_scope(params: &Value) -> bool {
    params.get("repo_path").is_some() || params.get("repo_paths").is_some()
}

/// Code and file search tool.
pub struct SearchTool {
    /// Default repo path to search in (config workspace).
    default_repo: PathBuf,
    /// Active IDE repo path — overrides default_repo when set.
    active_repo: TokioMutex<Option<PathBuf>>,
    workspace_state: Option<Arc<parking_lot::RwLock<SessionWorkspace>>>,
    /// When true (`policy.workspace_only`), explicit `repo_path` params are
    /// confined to the session workspace. When false (the default policy),
    /// this read-only tool may search any path — the workspace is a focus,
    /// not a sandbox.
    restrict_to_workspace: bool,
    /// Optional router for Workstation mode.
    router: Option<ActionRouter>,
}

impl SearchTool {
    pub fn new(default_repo: PathBuf) -> Self {
        Self {
            default_repo,
            active_repo: TokioMutex::new(None),
            workspace_state: None,
            restrict_to_workspace: false,
            router: None,
        }
    }

    pub fn with_router(mut self, router: ActionRouter) -> Self {
        self.router = Some(router);
        self
    }

    pub fn with_restrict_to_workspace(mut self, restricted: bool) -> Self {
        self.restrict_to_workspace = restricted;
        self
    }

    pub fn with_workspace_state(
        mut self,
        workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    ) -> Self {
        self.workspace_state = Some(workspace_state);
        self
    }

    /// Resolve repo paths: explicit `repo_paths`/`repo_path` > active IDE repo > current workspace.
    ///
    /// Explicit paths are validated against the live session workspace only
    /// when the agent policy sets `workspace_only` (threaded via
    /// [`Self::with_restrict_to_workspace`]). Search is read-only; under the
    /// default-open policy any local path is fair game, same as `read_file`.
    async fn resolve_repos(&self, params: &Value) -> Result<Vec<PathBuf>, ToolError> {
        let explicit_repo_path = optional_string(params, "repo_path");
        let explicit_repo_paths = optional_string_array(params, "repo_paths")?;

        // Be tolerant when a model supplies both `repo_path` and `repo_paths`
        // (some providers leak both sibling fields). Merge them and dedup rather
        // than erroring — a hard error here can trap the agent in a repeated
        // tool-error loop until it hits the consecutive-error stop guard.
        let has_explicit = explicit_repo_path.is_some() || explicit_repo_paths.is_some();
        let paths = if has_explicit {
            let mut candidates: Vec<String> = Vec::new();
            if let Some(explicit_path) = explicit_repo_path {
                candidates.push(explicit_path);
            }
            if let Some(explicit_paths) = explicit_repo_paths {
                candidates.extend(explicit_paths);
            }
            let mut merged: Vec<PathBuf> = Vec::new();
            for candidate in candidates {
                let path = PathBuf::from(candidate);
                if !path.as_os_str().is_empty() && !merged.contains(&path) {
                    merged.push(path);
                }
            }
            if merged.is_empty() {
                return Err(ToolError::InvalidParams(
                    "provide at least one path in 'repo_path' or 'repo_paths'".to_string(),
                ));
            }
            merged
        } else {
            let active = self.active_repo.lock().await;
            vec![active.clone().unwrap_or_else(|| {
                self.workspace_state
                    .as_ref()
                    .map(|workspace| workspace.read().working_dir().to_path_buf())
                    .unwrap_or_else(|| self.default_repo.clone())
            })]
        };

        if self.restrict_to_workspace {
            if let Some(ref workspace) = self.workspace_state {
                let extra: Vec<PathBuf> =
                    self.active_repo.lock().await.clone().into_iter().collect();
                for path in &paths {
                    workspace
                        .read()
                        .is_path_allowed(path, &extra)
                        .map_err(ToolError::PermissionDenied)?;
                }
            }
        }

        Ok(paths)
    }
}

#[async_trait]
impl Tool for SearchTool {
    fn name(&self) -> &str {
        tool_names::CODE_SEARCH
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn output_budget(&self) -> usize {
        20_000
    }

    fn description(&self) -> &str {
        "Search code, files, and symbols in one or more repositories/folders.\n\
         Actions:\n\
         - grep: regex search in file contents (ripgrep)\n\
         - find_files: find files by name pattern (fuzzy)\n\
         - glob: find files by glob pattern (e.g. src/**/*.ts, *.{rs,toml})\n\
         - symbols: find functions/classes/types by name (tree-sitter)\n\
         - check_status: check search status\n\
         Use repo_path for one root or repo_paths for multiple roots. Always set max_results. For 'find_files', use specific name patterns. For 'glob', use standard glob syntax."
    }

    fn llm_description(&self) -> Option<String> {
        let repo = self
            .active_repo
            .try_lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|p| p.display().to_string()))
            .unwrap_or_else(|| {
                self.workspace_state
                    .as_ref()
                    .map(|workspace| workspace.read().working_dir().display().to_string())
                    .unwrap_or_else(|| self.default_repo.display().to_string())
            });

        Some(format!(
            "Search code, files, and symbols in {repo}, or across multiple roots with repo_paths.\n\
             ALWAYS use this tool for searching — NEVER invoke `grep`, `rg`, `find`, or `ls` through the shell tool; \
             this tool's grep action is ripgrep-backed and strictly preferred.\n\
             Actions:\n\
             - grep: regex search in file contents (ripgrep)\n\
             - find_files: find files by name pattern (fuzzy)\n\
             - glob: find files by glob pattern (e.g. src/**/*.ts, *.{{rs,toml}})\n\
             - symbols: find functions/classes/types by name (tree-sitter)\n\
             - check_status: check search status\n\
             Use repo_path for one root or repo_paths for multiple roots. Always set max_results. For 'find_files', use specific name patterns. For 'glob', use standard glob syntax. \
             When you expect an open-ended exploration needing many rounds of searching, delegate to an Explore agent instead of searching inline."
        ))
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "Search action",
                    "enum": ["grep", "find_files", "glob", "symbols", "check_status"]
                },
                "pattern": {
                    "type": "string",
                    "description": "Search pattern (regex for code, glob for files, name for symbols)"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results to return (default 250)",
                    "minimum": 1,
                    "maximum": 1000
                },
                "repo_path": {
                    "type": "string",
                    "description": "Single repository or folder path to search in (defaults to workspace). Use repo_paths for multiple roots."
                },
                "repo_paths": {
                    "type": "array",
                    "description": "Multiple repository or folder paths to search in. Use this instead of repo_path for multi-root search.",
                    "items": { "type": "string" },
                    "minItems": 1
                },
                "context_lines": {
                    "type": "integer",
                    "description": "Number of context lines before and after each match (for 'grep' action only, like grep -C)",
                    "minimum": 0,
                    "maximum": 10
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
        // Default matches the reference agent's grep head limit (250);
        // oversized results are persisted retrievably by the executor.
        let max_results = optional_int(&params, "max_results")
            .map(|val| val as usize)
            .unwrap_or(250)
            .clamp(1, 1000);
        let repo_paths = self.resolve_repos(&params).await?;
        let explicit_repo_scope = has_explicit_repo_scope(&params);

        // Workstation routing: route "grep" searches through ActionSystem.
        // Falls back to direct search on timeout (e.g. after hot reload).
        if action == "grep" && !explicit_repo_scope {
            if let Some(ref router) = self.router {
                if router.should_route() {
                    let pattern = required_string(&params, "pattern")?;
                    if let Some(result) = router
                        .try_execute(
                            "search.codebase",
                            serde_json::json!({
                                "query": pattern,
                                "caseSensitive": false,
                            }),
                        )
                        .await?
                    {
                        return Ok(result);
                    }
                    // Timeout — fall through to direct search
                }
            }
        }

        match action.as_str() {
            "check_status" => crate::tool_infra::search::index_status_formatted()
                .await
                .map_err(ToolError::ExecutionFailed),
            _ => {
                // All other actions require a pattern
                let pattern = required_string(&params, "pattern")?;

                for repo_path in &repo_paths {
                    if !repo_path.exists() {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Path does not exist: {}",
                            repo_path.display()
                        )));
                    }
                }

                match action.as_str() {
                    "grep" => {
                        let context_lines = optional_int(&params, "context_lines")
                            .map(|v| (v as usize).clamp(0, 10));
                        crate::tool_infra::search::code_search_multi_formatted(
                            &pattern,
                            &repo_paths,
                            max_results,
                            context_lines,
                        )
                        .await
                        .map_err(ToolError::ExecutionFailed)
                    }
                    "find_files" => crate::tool_infra::search::file_search_multi_formatted(
                        &pattern,
                        &repo_paths,
                        max_results,
                    )
                    .await
                    .map_err(ToolError::ExecutionFailed),
                    "glob" => crate::tool_infra::search::glob_search_multi_formatted(
                        &pattern,
                        &repo_paths,
                        max_results,
                    )
                    .await
                    .map_err(ToolError::ExecutionFailed),
                    "symbols" => crate::tool_infra::search::symbol_search_formatted(
                        &pattern,
                        repo_paths
                            .iter()
                            .map(|path| path.to_string_lossy().to_string())
                            .collect(),
                        max_results,
                    )
                    .await
                    .map_err(ToolError::ExecutionFailed),
                    _ => Err(ToolError::InvalidParams(format!(
                        "Unknown action: '{}'. Use: grep, find_files, glob, symbols, check_status.",
                        action
                    ))),
                }
            }
        }
    }
}
