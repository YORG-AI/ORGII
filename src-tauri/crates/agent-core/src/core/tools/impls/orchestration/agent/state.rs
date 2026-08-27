//! Public configuration and mutable state for the unified agent tool.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use tracing::warn;

use super::super::context_builders;
use core_types::providers::NativeHarnessType;

use crate::definitions::{resolve_definition_by_id, AgentDefinition, DelegationConfig};
use crate::providers::traits::LLMProvider;
use crate::session::workspace::SessionWorkspace;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registration;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::ToolError;

/// Everything the `AgentTool` needs from its parent session.
#[derive(Clone)]
pub struct AgentToolConfig {
    /// Parent session workspace (cc-aligned three-concept model). Call sites
    /// that need a `PathBuf` use `workspace.working_dir().to_path_buf()`.
    pub workspace: SessionWorkspace,
    pub app_handle: Option<tauri::AppHandle>,
    /// The parent session's own account id, snapshotted at runtime build time.
    /// Sub-agents inherit this value — never a global account.
    pub session_account_id: Option<String>,
    pub agent_model: String,
    pub provider: Arc<dyn LLMProvider>,
    pub native_harness_type: Option<NativeHarnessType>,
    pub max_tokens: u32,
    pub temperature: f32,
    /// Optional work item ID for LinkedSession tracking.
    pub work_item_id: Option<String>,
    /// Optional workspace path for LinkedSession tracking.
    pub workspace_path: Option<String>,
    /// `None` permits all delegatable agents; `Some` is the session allowlist.
    pub allowed_subagents: Option<Vec<String>>,
    /// Full refs retain per-agent settings such as worktree isolation.
    pub configured_subagents: Vec<crate::definitions::SubAgentRef>,
    /// Ancestor agent IDs used to reject nested worker launches.
    pub delegation_chain: Vec<String>,
    /// Parent cancellation propagated into in-flight workers.
    pub parent_cancel_flag: Option<Arc<AtomicBool>>,
    /// Scratchpad directory shared with workers when available.
    pub scratchpad_dir: Option<PathBuf>,
    /// Coding-tool dependencies used for worktree-isolated registries.
    pub exec_timeout: u64,
    pub restrict_to_workspace: bool,
    pub pty_sessions: Option<registration::PtySessions>,
    pub security_policy: Option<Arc<crate::security::SecurityPolicy>>,
    pub action_bridge: Option<Arc<crate::tools::impls::web::control_orgii::ActionBridge>>,
    pub execution_mode: crate::integrations::config::ExecutionMode,
    /// Parent Agent Org context inherited for worker prompt construction.
    pub agent_org_context: Option<Arc<crate::coordination::agent_org_runs::AgentOrgRunContext>>,
    /// Whether the parent participates in an Agent Org run as a member.
    pub is_org_member: bool,
}

/// The unified agent tool.
pub struct AgentTool {
    pub(super) config: AgentToolConfig,
    /// Externally-owned slot swapped to the final overlay-aware registry.
    pub(super) parent_registry: Arc<parking_lot::RwLock<Arc<ToolRegistry>>>,
    pub(super) parent_policy: Arc<ResolvedToolPolicy>,
    pub(super) model: Arc<TokioMutex<String>>,
    pub(super) parent_session_id: Arc<TokioMutex<String>>,
    pub(super) active_repo: Arc<TokioMutex<Option<PathBuf>>>,
    pub(super) instance_counts: Arc<TokioMutex<HashMap<String, u32>>>,
    pub(super) parent_messages: Arc<TokioMutex<Vec<Value>>>,
}

impl AgentTool {
    /// Construct an `AgentTool` sharing the registry slot installed by overlay
    /// assembly, so every launch path observes the final registry.
    pub fn with_registry_slot(
        config: AgentToolConfig,
        parent_registry: Arc<parking_lot::RwLock<Arc<ToolRegistry>>>,
        parent_policy: Arc<ResolvedToolPolicy>,
        model: String,
        parent_session_id: String,
    ) -> Self {
        Self {
            config,
            parent_registry,
            parent_policy,
            model: Arc::new(TokioMutex::new(model)),
            parent_session_id: Arc::new(TokioMutex::new(parent_session_id)),
            active_repo: Arc::new(TokioMutex::new(None)),
            instance_counts: Arc::new(TokioMutex::new(HashMap::new())),
            parent_messages: Arc::new(TokioMutex::new(Vec::new())),
        }
    }

    /// Cheap snapshot of the registry pointer currently installed by the
    /// parent runtime.
    pub(super) fn parent_registry_snapshot(&self) -> Arc<ToolRegistry> {
        Arc::clone(&self.parent_registry.read())
    }

    pub(super) fn resolve_agent(&self, agent_id: &str) -> Result<AgentDefinition, ToolError> {
        let store = crate::definitions::definitions_store();
        resolve_definition_by_id(agent_id, Some(&store)).map_err(ToolError::InvalidParams)
    }

    pub(super) async fn resolve_repo_path(&self) -> PathBuf {
        self.active_repo
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| self.config.workspace.working_dir().to_path_buf())
    }

    pub(super) async fn build_context(&self, delegation_config: &DelegationConfig) -> String {
        let mut sections = Vec::new();
        let repo = self.resolve_repo_path().await;
        let repo_str = repo.to_string_lossy().to_string();
        let ws_str = self
            .config
            .workspace
            .working_dir()
            .to_string_lossy()
            .to_string();

        use context_builders::ids;
        for builder in &delegation_config.context_builders {
            match builder.as_str() {
                ids::CODE_ACCOUNTS => {
                    if let Some(ctx) = context_builders::build_code_accounts_context() {
                        sections.push(ctx);
                    }
                }
                ids::TEAM_MEMBERS => {
                    if let Some(members) = context_builders::build_members_context(&repo_str) {
                        sections.push(members);
                    }
                    if ws_str != repo_str {
                        if let Some(ws_members) = context_builders::build_members_context(&ws_str) {
                            let header = "## Personal Workspace Members\n";
                            let body = ws_members
                                .strip_prefix("## Team Members\n\n")
                                .unwrap_or(&ws_members);
                            sections.push(format!("{}{}", header, body));
                        }
                    }
                }
                ids::AGENT_DEFINITIONS => {
                    if let Some(ctx) = context_builders::build_agent_definitions_context() {
                        sections.push(ctx);
                    }
                }
                ids::AGENT_ORGS => {
                    if let Some(ctx) = context_builders::build_agent_orgs_context() {
                        sections.push(ctx);
                    }
                }
                ids::ENVIRONMENT => sections.push(format!(
                    "## Environment\n\n- **Active IDE repo:** {}\n- **Personal workspace:** {}",
                    repo_str, ws_str
                )),
                unknown => warn!("[agent] Unknown context builder: {}. Skipping.", unknown),
            }
        }

        sections.join("\n\n")
    }
}
