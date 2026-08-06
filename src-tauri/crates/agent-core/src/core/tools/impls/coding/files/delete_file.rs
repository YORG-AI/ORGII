//! `delete_file` tool — remove a single file inside the session workspace.

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use super::{allowed_roots, authorize_path, live_allowed_dir, map_err, WorkspaceStateHandle};
use crate::security::SecurityPolicy;
use crate::tools::impls::coding::action_router::ActionRouter;
use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};

pub struct DeleteFileTool {
    /// Construction-time sandbox root; `None` = unrestricted. When
    /// `workspace_state` is attached the live `working_dir()` is read on
    /// every call instead.
    allowed_dir: Option<PathBuf>,
    additional_allowed_dirs: Vec<PathBuf>,
    workspace_state: Option<WorkspaceStateHandle>,
    router: Option<ActionRouter>,
    security_policy: Option<Arc<SecurityPolicy>>,
}

impl DeleteFileTool {
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
impl Tool for DeleteFileTool {
    fn name(&self) -> &str {
        tool_names::DELETE_FILE
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn description(&self) -> &str {
        "Delete a single file from the workspace. Refuses to delete directories."
    }

    fn llm_description(&self) -> Option<String> {
        let workspace = self
            .current_allowed_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "(unrestricted)".to_string());
        Some(format!(
            "Delete a single file in {workspace}. Refuses to delete directories."
        ))
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to delete"
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
                        "file.delete",
                        serde_json::json!({ "path": &authorized_path }),
                    )
                    .await?
                {
                    return Ok(result);
                }
            }
        }

        let resolved = crate::tool_infra::file::resolve_path_with_extras(
            &authorized_path,
            allowed.as_deref(),
            &authorized_roots,
        )
        .map_err(map_err)?;

        let metadata = tokio::fs::metadata(&resolved).await.map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to access {}: {}", raw_path, err))
        })?;
        if metadata.is_dir() {
            return Err(ToolError::InvalidParams(format!(
                "delete_file refuses to delete directories: {}",
                raw_path
            )));
        }

        tokio::fs::remove_file(&resolved).await.map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to delete {}: {}", raw_path, err))
        })?;

        Ok(format!("Deleted {}", raw_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::{AutonomyLevel, CommandRiskRules, SecurityPolicy};
    use tempfile::TempDir;

    #[tokio::test]
    async fn deletes_file_inside_workspace() {
        let repo = TempDir::new().unwrap();
        let path = repo.path().join("old.rs");
        std::fs::write(&path, "obsolete").unwrap();

        let tool = DeleteFileTool::new(Some(repo.path().to_path_buf()));
        let output = tool
            .execute(
                serde_json::json!({ "path": "old.rs" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap();

        assert_eq!(output.text, "Deleted old.rs");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn rejects_directory_delete() {
        let repo = TempDir::new().unwrap();
        std::fs::create_dir(repo.path().join("nested")).unwrap();

        let tool = DeleteFileTool::new(Some(repo.path().to_path_buf()));
        let err = tool
            .execute(
                serde_json::json!({ "path": "nested" }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap_err();

        assert!(
            matches!(err, ToolError::InvalidParams(_)),
            "unexpected error variant: {:?}",
            err
        );
    }

    #[tokio::test]
    async fn rejects_file_outside_workspace() {
        let repo = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "secret").unwrap();

        let tool = DeleteFileTool::new(Some(repo.path().to_path_buf()));
        let err = tool
            .execute(
                serde_json::json!({ "path": outside_file.to_string_lossy() }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap_err();

        assert!(
            matches!(err, ToolError::PermissionDenied(_)),
            "unexpected error variant: {:?}",
            err
        );
        assert!(outside_file.exists());
    }

    #[tokio::test]
    async fn forbidden_path_is_rejected_before_deletion() {
        let repo = TempDir::new().unwrap();
        let forbidden = TempDir::new().unwrap();
        let target = forbidden.path().join("secret.txt");
        std::fs::write(&target, "secret").unwrap();
        let policy = Arc::new(SecurityPolicy::new(
            AutonomyLevel::Full,
            true,
            Vec::new(),
            Vec::new(),
            vec![forbidden.path().to_string_lossy().into_owned()],
            true,
            CommandRiskRules::default(),
        ));

        let tool =
            DeleteFileTool::new(Some(repo.path().to_path_buf())).with_security_policy(policy);
        let err = tool
            .execute(
                serde_json::json!({ "path": target.to_string_lossy() }),
                &crate::tools::call_context::CallContext::default(),
            )
            .await
            .unwrap_err();

        assert!(matches!(err, ToolError::PermissionDenied(_)));
        assert!(target.exists());
    }
}
