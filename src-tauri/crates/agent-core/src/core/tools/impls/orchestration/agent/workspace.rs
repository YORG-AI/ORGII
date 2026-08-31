//! Workspace selection, worktree isolation, and isolated coding overlays.

use std::path::PathBuf;
use std::sync::Arc;

use crate::definitions::schema::SubAgentIsolation;
use crate::session::workspace::SessionWorkspace;
use crate::tools::registration::{self, ToolDeps};
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::ToolError;

use super::request::{IsolationRequest, LaunchRequest};
use super::AgentTool;

pub(super) struct PreparedWorkspace {
    pub(super) registry: Arc<ToolRegistry>,
    pub(super) worktree_workspace_root: Option<PathBuf>,
}

fn subagent_worktree_max_count() -> Option<usize> {
    settings::file_io::read_settings()
        .ok()
        .and_then(|value| {
            value
                .get("git.worktree.maxCount")
                .and_then(|count| count.as_u64())
        })
        .map(|count| count as usize)
}

impl AgentTool {
    fn configured_isolation_for(&self, agent_id: &str) -> Option<SubAgentIsolation> {
        self.config
            .configured_subagents
            .iter()
            .find(|sub_agent| sub_agent.agent_id == agent_id)
            .and_then(|sub_agent| sub_agent.isolation)
    }

    pub(super) fn effective_isolation(&self, request: &LaunchRequest) -> Option<SubAgentIsolation> {
        if request.resume_session_id.is_some() {
            return None;
        }
        match request.isolation {
            IsolationRequest::Configured => self.configured_isolation_for(&request.agent_id),
            IsolationRequest::Worktree => Some(SubAgentIsolation::Worktree),
        }
    }

    async fn create_worktree_workspace(
        &self,
        session_id: &str,
        workspace_root: PathBuf,
    ) -> Result<(SessionWorkspace, git::worktree::WorktreeInfo), ToolError> {
        if !workspace_root.exists() {
            return Err(ToolError::ExecutionFailed(format!(
                "Worktree isolation requires an existing workspace path: {}",
                workspace_root.display()
            )));
        }
        let session_id = session_id.to_string();
        let worktree_info = tokio::task::spawn_blocking({
            let workspace_root = workspace_root.clone();
            let session_id = session_id.clone();
            move || {
                git::worktree::create_session_worktree(
                    &workspace_root,
                    &session_id,
                    None,
                    subagent_worktree_max_count(),
                )
            }
        })
        .await
        .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?
        .map_err(ToolError::ExecutionFailed)?;

        let workspace = SessionWorkspace::new_worktree_inheriting(
            workspace_root,
            PathBuf::from(&worktree_info.path),
            &self.config.workspace,
        );
        Ok((workspace, worktree_info))
    }

    fn with_workspace_coding_overlay(
        &self,
        base_registry: Arc<ToolRegistry>,
        workspace: SessionWorkspace,
        session_id: &str,
    ) -> Arc<ToolRegistry> {
        let security_policy = self.config.security_policy.as_ref().map(|policy| {
            Arc::new(crate::security::SecurityPolicy::new(
                policy.autonomy,
                policy.workspace_only,
                policy.blocked_commands.clone(),
                policy.confirmation_commands.clone(),
                policy.forbidden_paths.clone(),
                policy.block_high_risk_commands,
                policy.risk_rules.clone(),
            ))
        });
        let workspace_state = Arc::new(parking_lot::RwLock::new(workspace));
        let tool_deps = ToolDeps {
            workspace: workspace_state,
            scratchpad_dir: self.config.scratchpad_dir.clone(),
            readonly_extra_dirs: vec![crate::skills::loader::global_skills_dir()],
            exec_timeout: self.config.exec_timeout,
            restrict_to_workspace: self.config.restrict_to_workspace,
            pty_sessions: self.config.pty_sessions.clone(),
            app_handle: self.config.app_handle.clone(),
            security_policy,
            action_bridge: self.config.action_bridge.clone(),
            execution_mode: self.config.execution_mode,
            agent_browser_config: None,
            screenshot_store: None,
            web_search_api_key: None,
            desktop_enabled: false,
            agent_model: self.config.agent_model.clone(),
            session_id: session_id.to_string(),
            bus: None,
            session_account_id: self.config.session_account_id.clone(),
            node_registry: None,
            question_manager: None,
            secret_broker: None,
            plan_approval_manager: None,
            plan_slot_cache: None,
            agent_org_context: self.config.agent_org_context.as_deref().cloned(),
            agent_org_current_member_id: None,
            channel_context: None,
        };
        let mut overlay = ToolRegistry::with_fallback(base_registry);
        let disabled = std::collections::HashSet::new();
        registration::coding::register(&mut overlay, &tool_deps, &disabled);
        Arc::new(overlay)
    }

    pub(super) async fn prepare_workspace(
        &self,
        isolation: Option<SubAgentIsolation>,
        base_registry: Arc<ToolRegistry>,
        subagent_session_id: &str,
    ) -> Result<PreparedWorkspace, ToolError> {
        let workspace = self.resolve_repo_path().await;
        let Some(SubAgentIsolation::Worktree) = isolation else {
            return Ok(PreparedWorkspace {
                registry: base_registry,
                worktree_workspace_root: None,
            });
        };

        let (isolated_workspace, worktree_info) = match self
            .create_worktree_workspace(subagent_session_id, workspace)
            .await
        {
            Ok(result) => result,
            Err(err) => {
                let _ = crate::session::persistence::update_status(
                    subagent_session_id,
                    crate::session::SessionStatus::Failed,
                );
                return Err(err);
            }
        };
        if let Err(err) =
            crate::session::persistence::save_workspace(subagent_session_id, &isolated_workspace)
        {
            let workspace_root = isolated_workspace.workspace_root.clone();
            let session_id = subagent_session_id.to_string();
            let _ = tokio::task::spawn_blocking(move || {
                git::worktree::remove_session_worktree(&workspace_root, &session_id, true)
            })
            .await;
            let _ = crate::session::persistence::update_status(
                subagent_session_id,
                crate::session::SessionStatus::Failed,
            );
            return Err(ToolError::ExecutionFailed(format!(
                "failed to persist subagent worktree workspace: {err}"
            )));
        }
        if let Some(base_branch) = worktree_info.base_branch.as_deref() {
            if let Err(err) = crate::session::persistence::save_worktree_metadata(
                subagent_session_id,
                &worktree_info.branch,
                base_branch,
                git::worktree::WorktreeMergeStatus::Pending,
            ) {
                let workspace_root = isolated_workspace.workspace_root.clone();
                let session_id = subagent_session_id.to_string();
                let _ = tokio::task::spawn_blocking(move || {
                    git::worktree::remove_session_worktree(&workspace_root, &session_id, true)
                })
                .await;
                let _ = crate::session::persistence::clear_worktree_metadata(subagent_session_id);
                let _ = crate::session::persistence::update_status(
                    subagent_session_id,
                    crate::session::SessionStatus::Failed,
                );
                return Err(ToolError::ExecutionFailed(format!(
                    "failed to persist subagent worktree metadata: {err}"
                )));
            }
        }

        let workspace_root = isolated_workspace.workspace_root.clone();
        let registry = self.with_workspace_coding_overlay(
            base_registry,
            isolated_workspace,
            subagent_session_id,
        );
        Ok(PreparedWorkspace {
            registry,
            worktree_workspace_root: Some(workspace_root),
        })
    }
}
