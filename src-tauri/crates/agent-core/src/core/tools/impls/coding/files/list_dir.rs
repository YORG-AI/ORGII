//! `list_dir` tool — list files and directories under a given path.

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use super::{allowed_roots, authorize_path, live_allowed_dir, map_err, WorkspaceStateHandle};
use crate::security::SecurityPolicy;
use crate::tools::impls::coding::action_router::ActionRouter;
use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};

pub struct ListDirTool {
    /// Construction-time sandbox root; `None` = unrestricted. When
    /// `workspace_state` is attached the live `working_dir()` is read on
    /// every call instead.
    allowed_dir: Option<PathBuf>,
    additional_allowed_dirs: Vec<PathBuf>,
    workspace_state: Option<WorkspaceStateHandle>,
    router: Option<ActionRouter>,
    security_policy: Option<Arc<SecurityPolicy>>,
}

impl ListDirTool {
    pub fn new(allowed_dir: Option<PathBuf>) -> Self {
        Self {
            allowed_dir,
            additional_allowed_dirs: Vec::new(),
            workspace_state: None,
            router: None,
            security_policy: None,
        }
    }

    pub fn with_router(mut self, router: ActionRouter) -> Self {
        self.router = Some(router);
        self
    }

    pub fn with_security_policy(mut self, policy: Arc<SecurityPolicy>) -> Self {
        self.security_policy = Some(policy);
        self
    }

    pub fn with_scratchpad(mut self, scratchpad_dir: PathBuf) -> Self {
        self.additional_allowed_dirs.push(scratchpad_dir);
        self
    }

    /// See [`super::ReadFileTool::with_workspace_state`].
    pub fn with_workspace_state(mut self, state: WorkspaceStateHandle) -> Self {
        self.workspace_state = Some(state);
        self
    }

    /// Live primary sandbox root — see [`live_allowed_dir`].
    fn current_allowed_dir(&self) -> Option<PathBuf> {
        live_allowed_dir(
            self.allowed_dir.is_some(),
            self.workspace_state.as_ref(),
            self.allowed_dir.as_ref(),
        )
    }
}

#[async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        tool_names::LIST_DIR
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "List files and directories in a given path."
    }

    fn llm_description(&self) -> Option<String> {
        let workspace = self
            .current_allowed_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(unrestricted)".to_string());
        Some(format!(
            "List files and directories. Working directory: {workspace}"
        ))
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list"
                }
            },
            "required": ["path"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let raw_path = required_string(&params, "path")?;

        let allowed = self.current_allowed_dir();
        let extras = allowed_roots(&self.additional_allowed_dirs, self.workspace_state.as_ref());
        let (authorized_path, authorized_roots) = authorize_path(
            &raw_path,
            allowed.as_deref(),
            &extras,
            self.security_policy.as_deref(),
        )
        .map_err(map_err)?;
        let authorized_path = authorized_path.to_string_lossy().into_owned();

        if let Some(ref router) = self.router {
            if router.should_route() {
                if let Some(result) = router
                    .try_execute(
                        "file.listDir",
                        serde_json::json!({
                            "path": &authorized_path,
                        }),
                    )
                    .await?
                {
                    return Ok(result);
                }
            }
        }

        let entries = crate::tool_infra::file::list_dir_with_extras(
            &authorized_path,
            allowed.as_deref(),
            &authorized_roots,
        )
        .await
        .map_err(map_err)?;

        let formatted: Vec<String> = entries
            .iter()
            .map(|(name, is_dir)| {
                let prefix = if *is_dir { "dir" } else { "file" };
                format!("[{}] {}", prefix, name)
            })
            .collect();

        Ok(formatted.join("\n"))
    }
}
