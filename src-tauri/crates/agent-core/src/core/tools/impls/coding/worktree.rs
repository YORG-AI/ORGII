//! Git Worktree tool — create and manage isolated worktrees.
//!
//! Provides workspace isolation for subagents and parallel work:
//! - `add` — Create a worktree from a branch/ref, switch workspace context
//! - `leave` — Return to the original workspace, optionally delete the worktree
//! - `list` — List existing worktrees

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::session::workspace::SessionWorkspace;

use crate::tools::names;
use crate::tools::traits::{params_schema, parse_params_described, Tool, ToolError};

// ============================================
// Structured Responses
// ============================================

#[derive(Debug, Serialize)]
struct AddResult {
    success: bool,
    reused: bool,
    branch: String,
    path: String,
    base: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct LeaveResult {
    success: bool,
    removed: bool,
    branch: String,
    path: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct WorktreeEntry {
    path: String,
    branch: String,
}

#[derive(Debug, Serialize)]
struct ListResult {
    success: bool,
    count: usize,
    entries: Vec<WorktreeEntry>,
    content: String,
}

// ============================================
// Params
// ============================================

/// Flat params: tagged-enum schemas (top-level `oneOf`) get flattened to an
/// empty schema by LLM providers, so the model never sees the fields. Keep
/// this a plain object with scalar properties; per-action requiredness is
/// enforced in `execute_text` with self-correcting error messages.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorktreeParams {
    /// Operation to perform. One of: `add` (create a worktree and switch
    /// context to it), `leave` (return to the original workspace), `list`
    /// (list all worktrees).
    pub action: String,
    /// `add` only (required): branch name to create or check out in the
    /// worktree.
    #[serde(default)]
    pub branch: Option<String>,
    /// `add` only: optional base ref to branch from (default: HEAD).
    #[serde(default)]
    pub base_ref: Option<String>,
    /// `leave` only: remove the worktree directory after leaving
    /// (default: false).
    #[serde(default)]
    pub remove: Option<bool>,
}

// ============================================
// State
// ============================================

#[derive(Debug, Default)]
struct WorktreeState {
    original_workspace: Option<PathBuf>,
    current_worktree: Option<PathBuf>,
    current_branch: Option<String>,
}

// ============================================
// Tool
// ============================================

pub struct WorktreeTool {
    session_id: String,
    workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    state: Mutex<WorktreeState>,
}

impl WorktreeTool {
    pub fn new(
        session_id: String,
        workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    ) -> Self {
        Self {
            session_id,
            workspace_state,
            state: Mutex::new(WorktreeState::default()),
        }
    }
}

#[async_trait]
impl Tool for WorktreeTool {
    fn name(&self) -> &str {
        names::WORKTREE
    }

    fn description(&self) -> &str {
        "Manage git worktrees for isolated parallel work. Actions: add (create worktree), leave (return to main), list (show worktrees)."
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn parameters(&self) -> Value {
        params_schema::<WorktreeParams>()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let params: WorktreeParams = parse_params_described(params)?;
        match params.action.as_str() {
            "add" => {
                let branch = params.branch.as_deref().ok_or_else(|| {
                    ToolError::InvalidParams(
                        "`add` requires `branch` — the branch name for the new worktree"
                            .to_string(),
                    )
                })?;
                self.add_worktree(branch, params.base_ref.as_deref()).await
            }
            "leave" => self.leave_worktree(params.remove.unwrap_or(false)).await,
            "list" => self.list_worktrees().await,
            other => Err(ToolError::InvalidParams(format!(
                "unknown action \"{other}\"; valid actions: `add`, `leave`, `list`"
            ))),
        }
    }
}

impl WorktreeTool {
    async fn add_worktree(
        &self,
        branch: &str,
        base_ref: Option<&str>,
    ) -> Result<String, ToolError> {
        let mut state = self.state.lock().await;
        if state.current_worktree.is_some() || self.workspace_state.read().is_worktree() {
            return Err(ToolError::ExecutionFailed(
                "Already in a worktree. Leave first before adding another.".to_string(),
            ));
        }

        let workspace_root = self.workspace_state.read().workspace_root.clone();
        let worktree_dir = workspace_root.join(".orgii").join("worktrees").join(branch);
        let path_str = worktree_dir.to_string_lossy().to_string();
        let base = base_ref.unwrap_or("HEAD");
        let mut created = false;

        if worktree_dir.exists() {
            info!(
                "[worktree] Reusing existing worktree at {}",
                worktree_dir.display()
            );
        } else {
            let mut cmd_args = vec![
                "worktree".to_string(),
                "add".to_string(),
                "-b".to_string(),
                branch.to_string(),
                path_str.clone(),
                base.to_string(),
            ];

            let output = run_git(&workspace_root, &cmd_args).await?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if stderr.contains("already exists") {
                    cmd_args = vec![
                        "worktree".to_string(),
                        "add".to_string(),
                        path_str.clone(),
                        branch.to_string(),
                    ];
                    let retry = run_git(&workspace_root, &cmd_args).await?;
                    if !retry.status.success() {
                        return Err(ToolError::ExecutionFailed(format!(
                            "git worktree add failed: {}",
                            String::from_utf8_lossy(&retry.stderr)
                        )));
                    }
                } else {
                    return Err(ToolError::ExecutionFailed(format!(
                        "git worktree add failed: {}",
                        stderr
                    )));
                }
            }
            created = true;
        }

        let mut next_workspace = self.workspace_state.read().clone();
        next_workspace.working_dir = worktree_dir.clone();
        if let Err(err) = persist_workspace(&self.session_id, &next_workspace).await {
            if created {
                let _ = run_git(
                    &workspace_root,
                    &[
                        "worktree".to_string(),
                        "remove".to_string(),
                        "--force".to_string(),
                        path_str.clone(),
                    ],
                )
                .await;
                let _ = run_git(
                    &workspace_root,
                    &["branch".to_string(), "-D".to_string(), branch.to_string()],
                )
                .await;
            }
            return Err(err);
        }

        *self.workspace_state.write() = next_workspace;
        state.original_workspace = Some(workspace_root.clone());
        state.current_worktree = Some(worktree_dir);
        state.current_branch = Some(branch.to_string());

        info!("[worktree] Entered worktree at {}", path_str);

        let result = AddResult {
            success: true,
            reused: !created,
            branch: branch.to_string(),
            path: path_str.clone(),
            base: base.to_string(),
            content: format!(
                "{} worktree at `{}`\nBranch: `{}`\nBase: `{}`\n\nFile operations now target this worktree. Use `leave` to return.",
                if created { "Created" } else { "Switched to existing" },
                path_str,
                branch,
                base
            ),
        };
        Ok(serde_json::to_string(&result).unwrap())
    }

    async fn leave_worktree(&self, remove: bool) -> Result<String, ToolError> {
        let mut state = self.state.lock().await;
        let current_workspace = self.workspace_state.read().clone();
        if !current_workspace.is_worktree() {
            return Err(ToolError::ExecutionFailed(
                "Not currently in a worktree.".to_string(),
            ));
        }

        let worktree_dir = state
            .current_worktree
            .take()
            .unwrap_or_else(|| current_workspace.working_dir.clone());
        let branch = state.current_branch.take().unwrap_or_default();
        let workspace_root = current_workspace.workspace_root.clone();
        state.original_workspace.take();
        let path_str = worktree_dir.to_string_lossy().to_string();

        // When removing: do the physical git operation FIRST, before persisting the
        // workspace change. This prevents an orphan worktree on disk: if persist
        // fails after git remove, the worktree is already gone. If git remove fails,
        // we keep the workspace pointing at the worktree so the agent can retry.
        let mut actually_removed = false;
        if remove {
            let output = run_git(
                &workspace_root,
                &[
                    "worktree".to_string(),
                    "remove".to_string(),
                    "--force".to_string(),
                    path_str.clone(),
                ],
            )
            .await;

            match output {
                Ok(out) if out.status.success() => {
                    actually_removed = true;
                    info!("[worktree] Removed worktree at {}", path_str);
                }
                Ok(out) => {
                    warn!(
                        "[worktree] git worktree remove failed (worktree still on disk): {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
                Err(err) => {
                    warn!(
                        "[worktree] git worktree remove error (worktree still on disk): {}",
                        err
                    );
                }
            }

            if actually_removed && !branch.is_empty() {
                let _ = run_git(
                    &workspace_root,
                    &["branch".to_string(), "-D".to_string(), branch.clone()],
                )
                .await;
            }
        }

        // Persist the workspace change back to workspace_root now that any physical
        // cleanup is done. If we're not removing, this is the first write; if we
        // are removing it follows the git op so a persist failure leaves a clean disk.
        let mut next_workspace = current_workspace.clone();
        next_workspace.working_dir = workspace_root.clone();
        persist_workspace(&self.session_id, &next_workspace).await?;
        *self.workspace_state.write() = next_workspace;

        let mut content = format!(
            "Left worktree `{}`\nReturned to `{}`",
            path_str,
            workspace_root.display()
        );

        if remove {
            if actually_removed {
                content.push_str("\nRemoved worktree directory.");
            } else {
                content.push_str(&format!(
                    "\nWarning: worktree directory `{}` could not be removed (manual cleanup may be needed).",
                    path_str
                ));
            }
        } else {
            content.push_str(&format!(
                "\nNote: worktree directory `{}` was NOT removed. Pass `remove: true` to delete it.",
                path_str
            ));
        }

        let result = LeaveResult {
            success: true,
            removed: actually_removed,
            branch,
            path: path_str,
            content,
        };
        Ok(serde_json::to_string(&result).unwrap())
    }

    async fn list_worktrees(&self) -> Result<String, ToolError> {
        let workspace_root = self.workspace_state.read().workspace_root.clone();
        let output = run_git(
            &workspace_root,
            &[
                "worktree".to_string(),
                "list".to_string(),
                "--porcelain".to_string(),
            ],
        )
        .await?;

        if !output.status.success() {
            return Err(ToolError::ExecutionFailed(format!(
                "git worktree list failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.trim().is_empty() {
            let result = ListResult {
                success: true,
                count: 0,
                entries: Vec::new(),
                content: "No worktrees found.".to_string(),
            };
            return Ok(serde_json::to_string(&result).unwrap());
        }

        let mut entries: Vec<WorktreeEntry> = Vec::new();
        let mut current_path = String::new();
        let mut current_branch = String::new();

        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                if !current_path.is_empty() {
                    entries.push(WorktreeEntry {
                        path: current_path.clone(),
                        branch: current_branch.clone(),
                    });
                }
                current_path = path.to_string();
                current_branch = String::new();
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                current_branch = branch.to_string();
            } else if line == "bare" {
                current_branch = "(bare)".to_string();
            }
        }
        if !current_path.is_empty() {
            entries.push(WorktreeEntry {
                path: current_path,
                branch: current_branch,
            });
        }

        let display_lines: Vec<String> = entries
            .iter()
            .map(|entry| format!("- `{}` (branch: {})", entry.path, entry.branch))
            .collect();

        let content = format!(
            "**Worktrees ({}):**\n{}",
            entries.len(),
            display_lines.join("\n")
        );

        let result = ListResult {
            success: true,
            count: entries.len(),
            entries,
            content,
        };
        Ok(serde_json::to_string(&result).unwrap())
    }
}

async fn run_git(
    cwd: &std::path::Path,
    args: &[String],
) -> Result<std::process::Output, ToolError> {
    git::tokio_git_command()
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to resolve bundled git: {}", err))
        })?
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|err| ToolError::ExecutionFailed(format!("Failed to run git: {}", err)))
}

async fn persist_workspace(
    session_id: &str,
    workspace: &SessionWorkspace,
) -> Result<(), ToolError> {
    let session_id = session_id.to_string();
    let workspace = workspace.clone();
    tokio::task::spawn_blocking(move || {
        crate::session::persistence::save_workspace(&session_id, &workspace)
    })
    .await
    .map_err(|err| ToolError::ExecutionFailed(format!("Failed to persist workspace: {}", err)))?
    .map(|_| ())
    .map_err(|err| ToolError::ExecutionFailed(format!("Failed to persist workspace: {}", err)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn params_schema_is_llm_compatible() {
        let schema = params_schema::<WorktreeParams>();
        crate::tools::traits::assert_llm_compatible_schema(&schema)
            .expect("worktree schema must be flat and portable");
    }

    #[test]
    fn parse_add_params() {
        let params = json!({
            "action": "add",
            "branch": "feature/test"
        });
        let parsed: WorktreeParams = parse_params_described(params).unwrap();
        assert_eq!(parsed.action, "add");
        assert_eq!(parsed.branch.as_deref(), Some("feature/test"));
        assert!(parsed.base_ref.is_none());
    }

    #[test]
    fn parse_add_with_base_ref() {
        let params = json!({
            "action": "add",
            "branch": "fix/bug",
            "base_ref": "main"
        });
        let parsed: WorktreeParams = parse_params_described(params).unwrap();
        assert_eq!(parsed.branch.as_deref(), Some("fix/bug"));
        assert_eq!(parsed.base_ref.as_deref(), Some("main"));
    }

    #[test]
    fn parse_leave_params() {
        let params = json!({ "action": "leave", "remove": true });
        let parsed: WorktreeParams = parse_params_described(params).unwrap();
        assert_eq!(parsed.action, "leave");
        assert_eq!(parsed.remove, Some(true));
    }

    #[test]
    fn parse_leave_default_no_remove() {
        let params = json!({ "action": "leave" });
        let parsed: WorktreeParams = parse_params_described(params).unwrap();
        assert_eq!(parsed.action, "leave");
        assert!(parsed.remove.is_none());
    }

    #[test]
    fn parse_list_params() {
        let params = json!({ "action": "list" });
        let parsed: WorktreeParams = parse_params_described(params).unwrap();
        assert_eq!(parsed.action, "list");
    }

    #[tokio::test]
    async fn add_without_branch_fails_with_guidance() {
        let tool = test_tool();
        let result = tool
            .execute(
                json!({ "action": "add" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await;
        let err = format!("{:?}", result.unwrap_err());
        assert!(
            err.contains("branch"),
            "error must name the missing field: {err}"
        );
    }

    #[tokio::test]
    async fn unknown_action_lists_valid_actions() {
        let tool = test_tool();
        let result = tool
            .execute(
                json!({ "action": "bogus" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await;
        let err = format!("{:?}", result.unwrap_err());
        assert!(err.contains("`add`") && err.contains("`leave`") && err.contains("`list`"));
    }

    fn test_tool() -> WorktreeTool {
        WorktreeTool::new(
            "test-session".to_string(),
            Arc::new(parking_lot::RwLock::new(SessionWorkspace::new(
                PathBuf::from("/tmp"),
            ))),
        )
    }

    #[test]
    fn tool_name_and_category() {
        let tool = test_tool();
        assert_eq!(tool.name(), "worktree");
        assert_eq!(tool.category(), "coding");
    }

    #[tokio::test]
    async fn leave_without_add_fails() {
        let tool = test_tool();
        let result = tool
            .execute(
                json!({ "action": "leave" }),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await;
        assert!(result.is_err());
    }
}
