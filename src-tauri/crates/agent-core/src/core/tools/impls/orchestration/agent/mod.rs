//! Unified `agent` tool — single entry point for Delegate and Shadow workers.
//!
//! Replaces three older execution paths:
//! - built-in worker dispatch (explore / generalPurpose)
//! - named org-agent spawning with instance limits
//! - specialist-agent delegation with fresh registries
//!
//! Dispatch strategy: every worker inherits the parent's `ToolRegistry`
//! and applies the agent's `AgentToolSelection` as a policy overlay. The
//! hard-deny layer (`subagent_forbidden_tools`) always sits on top of the
//! agent's own selection so, e.g., `agent` / `send_message` can never be
//! exposed to a worker regardless of definition.
//!
//! `AgentToolSelection` combination rules (see design doc §4):
//! - `system_restrict_to_tools = None` → inherit everything minus
//!   `excluded_tools` (e.g. `builtin:general`). Any user additions in
//!   `user_allowed_tools` are no-ops in this mode.
//! - `system_restrict_to_tools = Some(list)` → strict allowlist
//!   (e.g. `builtin:explore`, memory workers). The resolver merges
//!   `user_allowed_tools` on top of this list (capability-gated) and
//!   honours `excluded_tools` from either source.
//!
//! `manage_project`, `manage_work_item`, and `manage_agent_def` are
//! management-capability tools for OS/coordinator-style sessions, not
//! default SDE worker tools.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use tracing::{info, warn};

use super::context_builders;
use core_types::providers::NativeHarnessType;

use crate::definitions::builtin::{EXPLORE_AGENT_ID, GENERAL_AGENT_ID};
use crate::definitions::schema::SubAgentIsolation;
use crate::definitions::{resolve_definition_by_id, AgentDefinition, DelegationConfig};
use crate::providers::traits::LLMProvider;
use crate::session::workspace::SessionWorkspace;
use crate::tools::impls::coding::exec::registry as job_registry;
use crate::tools::impls::orchestration::subagent_handler::{
    SubagentHandlerConfig, UnifiedSubagentHandler,
};
use crate::tools::names as tool_names;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registration::{self, ToolDeps};
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::{Tool, ToolError};
use crate::turn_executor::TurnConfig;

/// Default per-turn iteration budget for subagents whose definition does
/// not carry a `session_model`. Generous enough for long research /
/// implementation tasks, but bounded so a runaway loop can't burn tokens
/// for hours. Hitting the budget ends the turn normally with all progress
/// returned to the parent (not an error).
const DEFAULT_SUBAGENT_MAX_ITERATIONS: u32 = 100;

struct DisabledOrgSendMessageTool;

#[async_trait]
impl Tool for DisabledOrgSendMessageTool {
    fn name(&self) -> &str {
        tool_names::ORG_SEND_MESSAGE
    }

    fn description(&self) -> &str {
        "org_send_message is available only to canonical Agent Org participants with a member_id."
    }

    fn is_ready(&self) -> bool {
        false
    }

    fn not_ready_reason(&self) -> Option<&str> {
        Some("not a canonical Agent Org participant")
    }

    fn parameters(&self) -> Value {
        serde_json::json!({ "type": "object", "properties": {} })
    }

    async fn execute_text(
        &self,
        _params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        Err(ToolError::InvalidParams(
            "org_send_message is available only to canonical Agent Org participants with a member_id"
                .to_string(),
        ))
    }
}

// ── Configuration ───────────────────────────────────────────────────

/// Everything the `AgentTool` needs from its parent session.
#[derive(Clone)]
pub struct AgentToolConfig {
    /// Parent session workspace (cc-aligned three-concept model). Call sites
    /// that need a `PathBuf` use `workspace.working_dir().to_path_buf()`.
    pub workspace: SessionWorkspace,
    pub app_handle: Option<tauri::AppHandle>,
    /// The parent session's own account id, snapshotted at runtime build
    /// time. An account switch invalidates + rebuilds the parent runtime
    /// (and with it this config), so it is always current for the
    /// runtime's lifetime. Sub-agents inherit this — never a global.
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
    /// Delegatable agent IDs from the parent's `sub_agents` definition.
    /// `None` = unrestricted (all delegatable agents visible).
    /// `Some(list)` = only agents in the list can be delegated to.
    pub allowed_subagents: Option<Vec<String>>,
    /// Full parent delegation refs, retained so runtime can read per-ref settings
    /// such as `isolation: "worktree"` after allowlist filtering.
    pub configured_subagents: Vec<crate::definitions::SubAgentRef>,
    /// Ancestor agent IDs. Empty at the root session; a non-empty chain
    /// signals "this invocation is running inside a worker", which
    /// `subagent_of_subagent_rejection` uses to block nested `agent` tool
    /// calls. (We do NOT use this for same-id cycle detection — see the
    /// comment in `execute()` and the note next to the helper.)
    pub delegation_chain: Vec<String>,
    /// Parent session's cancel flag. Propagated into the worker's
    /// `turn_executor::execute_turn` so that Stop on the parent aborts any
    /// in-flight worker LLM stream / tool loop in addition to the parent
    /// itself. `None` means "no cancel wiring" (e.g. construction paths
    /// that don't have a session yet — cancellation simply won't reach
    /// the worker in that case, which matches pre-wire behavior).
    pub parent_cancel_flag: Option<Arc<AtomicBool>>,
    /// Parent session's scratchpad directory. Shared with workers so they
    /// can use the same temp space for cross-worker knowledge. `None` when
    /// scratchpad creation failed or was not applicable.
    pub scratchpad_dir: Option<PathBuf>,
    /// Coding-tool dependencies needed to rebind file/edit/search/shell tools
    /// when a worker requests `isolation: "worktree"`.
    pub exec_timeout: u64,
    pub restrict_to_workspace: bool,
    pub pty_sessions: Option<registration::PtySessions>,
    pub security_policy: Option<Arc<crate::security::SecurityPolicy>>,
    pub action_bridge: Option<Arc<crate::tools::impls::web::control_orgii::ActionBridge>>,
    pub execution_mode: crate::integrations::config::ExecutionMode,
    /// Parent session's resolved Agent Org context, when the parent
    /// participates in an org run. Inherited verbatim by every Delegate/Shadow
    /// worker the parent launches so the worker's system prompt can include
    /// the Agent Org section that teaches the model how to use
    /// `org_send_message` (without the section, the model has no idea
    /// who the org participants are or how to address them).
    ///
    /// `None` for non-org sessions; `Some` for coordinator and member
    /// sessions of an org run. The `org_send_message` tool itself is
    /// gated on the session's own registry — this field only drives
    /// the prompt-side teaching for workers.
    pub agent_org_context: Option<Arc<crate::coordination::agent_org_runs::AgentOrgRunContext>>,
    /// True when the parent session participates in an Agent Org run
    /// **as a member** (i.e. `agent_org_context.is_some()` AND the
    /// parent's `agent_id` is NOT the coordinator's). Non-coordinator
    /// members additionally cannot launch background workers because
    /// their lifecycle is tied to the org run. All org participants —
    /// including the coordinator — are prevented from launching roster
    /// participants via the `agent` tool; they must use `org_send_message`.
    pub is_org_member: bool,
}

/// The unified agent tool.
pub struct AgentTool {
    config: AgentToolConfig,
    /// Parent's full tool registry (used for Path A).
    ///
    /// Wrapped in `RwLock<Arc<…>>` so the registry pointer can be swapped
    /// once at the end of `init::tool_assembly::assemble_overlay`. The
    /// chicken-and-egg is: `AgentTool` is itself one of the overlay tools,
    /// so at construction time the only registry that exists is the
    /// `base_registry` (without overlay tools like `org_send_message`).
    /// Without the swap, workers launched via Path A / shadow would
    /// inherit a stripped-down registry that lacks every overlay tool —
    /// for example, `org_send_message` would be invisible to a
    /// worker that needs to report back to its coordinator.
    parent_registry: Arc<parking_lot::RwLock<Arc<ToolRegistry>>>,
    /// Parent's resolved policy (used for Path A).
    parent_policy: Arc<ResolvedToolPolicy>,
    /// Current LLM model (may be updated at runtime).
    model: Arc<TokioMutex<String>>,
    /// Parent session ID for event correlation.
    parent_session_id: Arc<TokioMutex<String>>,
    /// Active IDE repo path (overrides config.workspace when set).
    active_repo: Arc<TokioMutex<Option<PathBuf>>>,
    /// Monotonic worker launch counts per agent_id for linked-session labels.
    instance_counts: Arc<TokioMutex<HashMap<String, u32>>>,
    /// Snapshot of parent's conversation messages for Shadow workers.
    /// Updated before each turn by the processor via `set_parent_messages()`.
    parent_messages: Arc<TokioMutex<Vec<Value>>>,
}

// ── Submodules ──────────────────────────────────────────────────────

mod background;
mod foreground;
/// `pub mod` only to expose helpers to `app::api::agent::test::core`
/// debug routes via `agent_core::debug::*`. `#[doc(hidden)]` keeps
/// the surface out of rustdoc; the underlying items are otherwise
/// internal to `agent_core`.
#[doc(hidden)]
pub mod helpers;
mod linked_session;
mod messages;
mod policy;
mod schema;
mod system_prompt;

#[cfg(test)]
mod tests;

// Re-exported with `#[doc(hidden)]` so the `app` crate's debug routes
// can reach them via `agent_core::debug::*`. Not part of agent_core's
// documented public API.
#[doc(hidden)]
pub use helpers::{
    background_launch_message, looks_like_valid_subagent_session_id, org_roster_spawn_rejection,
    resolve_agent_id_for_execute, subagent_of_subagent_rejection, subagent_type_label,
    ResolvedAgentId,
};

#[doc(hidden)]
pub use schema::llm_visible_agent_ids;

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
    /// Construct an `AgentTool` that shares an externally-owned registry
    /// slot. Used by `init::tool_assembly::assemble_overlay`, which keeps
    /// a writer handle so it can swap in the final overlay-aware registry
    /// after construction. This closes the chicken-and-egg between
    /// "AgentTool is itself an overlay tool" and "workers need to
    /// inherit the overlay so they can see tools like `org_send_message`".
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

    /// Snapshot the current parent-registry pointer.
    ///
    /// Cheap clone of the inner `Arc`. Used by all sub-agent launch paths
    /// (Path A / shadow / fresh-registry-fallback) so they observe whatever
    /// registry the slot owner has last installed.
    pub(super) fn parent_registry_snapshot(&self) -> Arc<ToolRegistry> {
        Arc::clone(&self.parent_registry.read())
    }

    // ── Agent resolution ────────────────────────────────────────────

    fn resolve_agent(&self, agent_id: &str) -> Result<AgentDefinition, ToolError> {
        let store = crate::definitions::definitions_store();
        resolve_definition_by_id(agent_id, Some(&store)).map_err(ToolError::InvalidParams)
    }

    // ── Path helpers ────────────────────────────────────────────────

    async fn resolve_repo_path(&self) -> PathBuf {
        self.active_repo
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| self.config.workspace.working_dir().to_path_buf())
    }

    fn configured_isolation_for(&self, agent_id: &str) -> Option<SubAgentIsolation> {
        self.config
            .configured_subagents
            .iter()
            .find(|sub_agent| sub_agent.agent_id == agent_id)
            .and_then(|sub_agent| sub_agent.isolation)
    }

    fn requested_isolation(
        &self,
        params: &Value,
        agent_id: &str,
    ) -> Result<Option<SubAgentIsolation>, ToolError> {
        match params.get("isolation") {
            None | Some(Value::Null) => Ok(self.configured_isolation_for(agent_id)),
            Some(Value::String(value)) if value == "worktree" => {
                Ok(Some(SubAgentIsolation::Worktree))
            }
            Some(Value::String(value)) => Err(ToolError::InvalidParams(format!(
                "unknown isolation mode '{value}'; supported value is 'worktree'"
            ))),
            Some(_) => Err(ToolError::InvalidParams(
                "isolation must be the string 'worktree' when provided".to_string(),
            )),
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

    // ── Context injection ───────────────────────────────────────────

    async fn build_context(&self, delegation_config: &DelegationConfig) -> String {
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
                ids::ENVIRONMENT => {
                    sections.push(format!(
                        "## Environment\n\n- **Active IDE repo:** {}\n- **Personal workspace:** {}",
                        repo_str, ws_str
                    ));
                }
                unknown => {
                    warn!("[agent] Unknown context builder: {}. Skipping.", unknown);
                }
            }
        }

        sections.join("\n\n")
    }
}

// ── Tool implementation ─────────────────────────────────────────────

#[async_trait]
impl Tool for AgentTool {
    fn name(&self) -> &str {
        tool_names::AGENT
    }

    fn description(&self) -> &str {
        schema::DESCRIPTION
    }

    fn llm_description(&self) -> Option<String> {
        schema::llm_description(self.config.allowed_subagents.as_ref())
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn persist_threshold(&self) -> usize {
        100_000
    }

    fn parameters(&self) -> Value {
        schema::parameters()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let parent_call_id = if ctx.call_id.is_empty() {
            None
        } else {
            Some(ctx.call_id.clone())
        };

        // Handle kill subcommand before regular launch logic
        if params.get("command").and_then(|v| v.as_str()) == Some("kill") {
            let handle = params
                .get("handle")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    ToolError::InvalidParams("kill requires 'handle' (worker session ID)".into())
                })?;
            return match job_registry::kill_subagent(handle) {
                Ok(()) => Ok(format!("Worker '{handle}' killed.")),
                Err(msg) => Err(ToolError::ExecutionFailed(msg)),
            };
        }

        // Nested-worker guard: single chokepoint so a custom `AgentDefinition`
        // with `system_restrict_to_tools = None` and empty `excluded_tools`
        // can't inherit `agent` and recurse. See the helper's doc comment for
        // the invariant.
        if let Some(err) = subagent_of_subagent_rejection(&self.config.delegation_chain) {
            return Err(err);
        }

        let mode = params
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("delegate");

        let is_shadow = mode == "shadow";
        let is_background = params
            .get("background")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("missing 'prompt'".into()))?;

        let description = params
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("subagent task");

        let resume_session_id =
            helpers::optional_nonempty_string_param(&params, "resume_session_id");

        // Shape-check the handle before `load_llm_history` so we give a
        // clear "wrong shape" error instead of downstream's cryptic
        // "No persisted history found". See `looks_like_valid_subagent_session_id`.
        if let Some(ref rid) = resume_session_id {
            if !looks_like_valid_subagent_session_id(rid) {
                return Err(ToolError::InvalidParams(format!(
                    "resume_session_id '{rid}' does not match the expected shape \
                     '<prefix>-<agent_id>-<uuid>'. Only pass a handle previously \
                     returned by an `agent(..., background: true)` invocation — \
                     omit this field for fresh subagents."
                )));
            }
        }

        // Resolve agent_id via the shared helper so tests exercise the same
        // logic as production. Delegate-without-id logs a warn so missed
        // explicit routing stays visible for offline review.
        let ResolvedAgentId { agent_id, fallback } = resolve_agent_id_for_execute(&params);
        if fallback {
            warn!(
                "[agent] delegate mode called without 'agent_id'; falling back to '{}'. \
                 Consider supplying an explicit agent_id (e.g. 'builtin:explore') for better routing.",
                GENERAL_AGENT_ID
            );
        }

        let requested_isolation = self.requested_isolation(&params, &agent_id)?;
        if resume_session_id.is_some() && params.get("isolation").is_some() {
            return Err(ToolError::InvalidParams(
                "isolation cannot be changed when resuming a background subagent".to_string(),
            ));
        }
        let effective_isolation = if resume_session_id.is_some() {
            None
        } else {
            requested_isolation
        };

        if let Some(ref resume_id) = resume_session_id {
            info!(
                "[agent] Resuming session '{}' with agent '{}' (mode={})",
                resume_id, agent_id, mode
            );
        } else {
            info!(
                "[agent] Invoking '{}': {} (mode={}, background={})",
                agent_id, description, mode, is_background
            );
        }

        // 1. Resolve agent definition (used for config even in shadow mode)
        let agent = self.resolve_agent(&agent_id)?;

        // 2. Check delegatability for non-builtin agents (skip for shadow mode)
        let delegation_config = agent.delegation_config.clone().unwrap_or_default();

        if !is_shadow && !agent.built_in && !delegation_config.delegatable {
            return Err(ToolError::ExecutionFailed(format!(
                "Agent '{}' is not configured for delegation",
                agent_id
            )));
        }

        // 2b. Org roster/sub-agent separation gate.
        //
        // Run this before allowlist enforcement so an org participant target
        // gets the semantic recovery hint (`org_send_message`) instead of a
        // generic "not in allowed workers" error.
        if let Some(err) = org_roster_spawn_rejection(
            is_shadow,
            self.config.is_org_member,
            self.config.agent_org_context.as_deref(),
            &agent_id,
            is_background,
        ) {
            return Err(err);
        }

        // 2c. Allowlist enforcement (skip for shadow mode, runtime primitives,
        // and coordinator-started roster workers).
        //
        // `builtin:explore` / `builtin:general` mirror Claude Code's private
        // task-agent primitives: the frontend does not expose them as
        // user-configurable sub-agent picks, so runtime must not make their
        // availability depend on that UI-owned allowlist.
        //
        // Agent Org roster members are not ordinary private subagents. The
        // coordinator must be able to start each member's concrete worker
        // session even though `tool_assembly` removes roster ids from the
        // ordinary allowlist. Otherwise `org_send_message` can only enqueue
        // unread inbox rows and has no worker session to wake.
        let target_is_org_roster_member = self
            .config
            .agent_org_context
            .as_ref()
            .map(|org_context| {
                !self.config.is_org_member
                    && org_context
                        .members
                        .iter()
                        .any(|member| member.agent_id == agent_id)
            })
            .unwrap_or(false);
        if !is_shadow
            && agent_id != EXPLORE_AGENT_ID
            && agent_id != GENERAL_AGENT_ID
            && !target_is_org_roster_member
        {
            if let Some(ref allowed) = self.config.allowed_subagents {
                if !allowed.iter().any(|id| id == &agent_id) {
                    return Err(ToolError::ExecutionFailed(format!(
                        "Agent '{}' is not in the allowed subagents list for this session",
                        agent_id
                    )));
                }
            }
        }

        // 3. Instance numbering — also enforces the max-instances cap.
        let instance_number = self.next_instance_number(&agent_id).await?;

        // 4. Resolve model + reliability for THIS sub-agent.
        //
        // Sub-agents do not inherit the parent's model or fallback chain
        // — they resolve from their own definition (see
        // `helpers::resolve_subagent_model` for the full precedence
        // ladder, mirrored in the model-priority editor's
        // `subagentOnlyNote` i18n string and
        // `docs/agent/claude-code-learnings/08-subagent.md`).
        //
        // We then build a fresh provider bound to the sub-agent's
        // primary model + chain. The sub-agent's account follows the
        // parent's (read at step 9b for the DB row, repeated here so we
        // can construct the provider before the persistence step).
        let parent_model = self.model.lock().await.clone();
        let explicit_param_model = params.get("model").and_then(|v| v.as_str());
        let (model, sub_reliability_opt) =
            helpers::resolve_subagent_model(&agent, explicit_param_model, &parent_model);

        let parent_session_id = self.parent_session_id.lock().await.clone();
        let parent_account_id_for_provider: Option<String> =
            self.config.session_account_id.clone().or_else(|| {
                crate::session::persistence::get_session(&parent_session_id)
                    .ok()
                    .flatten()
                    .and_then(|parent| parent.account_id)
            });

        let subagent_provider: Arc<dyn LLMProvider> = match sub_reliability_opt.as_ref() {
            Some(reliability) => {
                let subagent_session_id = format!("{parent_session_id}:subagent:{agent_id}");
                match crate::providers::factory::create_provider_with_native_harness_preflight(
                    &model,
                    parent_account_id_for_provider.as_deref(),
                    reliability,
                    self.config.native_harness_type,
                    Some(self.config.workspace.clone()),
                    Some(&subagent_session_id),
                )
                .await
                {
                    Ok(boxed) => Arc::from(boxed),
                    Err(err) if self.config.native_harness_type.is_some() => {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Failed to build native sub-agent provider for '{agent_id}' with model '{model}': {err}"
                        )));
                    }
                    Err(err) => {
                        warn!(
                            "[agent] Failed to build sub-agent provider for '{}' with model \
                             '{}' (account={:?}): {}. Falling back to parent provider — \
                             the sub-agent will run on the parent's currently active model.",
                            agent_id, model, parent_account_id_for_provider, err
                        );
                        Arc::clone(&self.config.provider)
                    }
                }
            }
            None if self.config.native_harness_type.is_some() => {
                let subagent_session_id = format!("{parent_session_id}:subagent:{agent_id}");
                match crate::providers::factory::create_provider_with_native_harness_preflight(
                    &model,
                    parent_account_id_for_provider.as_deref(),
                    &crate::config::ReliabilityConfig::default(),
                    self.config.native_harness_type,
                    Some(self.config.workspace.clone()),
                    Some(&subagent_session_id),
                )
                .await
                {
                    Ok(boxed) => Arc::from(boxed),
                    Err(err) => {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Failed to build native sub-agent provider for '{agent_id}' with model '{model}': {err}"
                        )));
                    }
                }
            }
            None => Arc::clone(&self.config.provider),
        };

        // 5. Build registry and policy (see module docstring for Path A vs B).
        // Owned-Arc pipeline: every branch produces an
        // `Arc<ToolRegistry>` so the post-step org-aware overlay can
        // chain via `with_fallback(Arc::clone(...))` without needing a
        // shallow_clone / lifetime gymnastics on the underlying registry.
        let has_allow_list = agent.tools.system_restrict_to_tools.is_some();
        let parent_registry_snap = self.parent_registry_snapshot();
        let base_registry_arc: Arc<ToolRegistry>;
        let effective_policy: ResolvedToolPolicy;

        if is_shadow {
            base_registry_arc = Arc::clone(&parent_registry_snap);
            effective_policy = self.build_inherited_policy(&agent);
        } else if agent_id == EXPLORE_AGENT_ID || !has_allow_list {
            base_registry_arc = Arc::clone(&parent_registry_snap);
            effective_policy = if agent_id == EXPLORE_AGENT_ID {
                self.build_explore_policy(&agent)?
            } else {
                self.build_inherited_policy(&agent)
            };
        } else {
            let built = self.build_fresh_registry(&agent).await?;
            base_registry_arc = Arc::new(built);
            effective_policy = self.build_fresh_policy(&agent);
        }

        // Delegate/Shadow workers are not canonical Agent Org participants:
        // they do not have an org `member_id`, are not part of the org graph,
        // and cannot be addressed by peers. If they inherit a parent registry
        // that contains `org_send_message`, shadow it with a disabled local
        // tool instead of spoofing coordinator/member identity.
        let effective_registry_arc: Arc<ToolRegistry> = if self.config.agent_org_context.is_some() {
            let mut overlay = ToolRegistry::with_fallback(Arc::clone(&base_registry_arc));
            overlay.register(Box::new(DisabledOrgSendMessageTool));
            Arc::new(overlay)
        } else {
            Arc::clone(&base_registry_arc)
        };
        // Workers always run in Build mode (no exec-mode overlay). Plan mode is
        // reserved for the parent↔user interaction; a worker calling
        // `create_plan` would submit against the parent's PlanApprovalManager on
        // the parent's behalf. Read-only exploration uses `builtin:explore`
        // (allow-policy path) or Shadow mode, neither of which needs Plan.

        // 6. Build system prompt (base soul + context + learnings + scratchpad)
        let full_system_prompt = self
            .build_full_system_prompt(&agent, &agent_id, &delegation_config, prompt)
            .await?;

        // 7. Build initial messages (resume / fork / fresh)
        let is_fork = params
            .get("fork")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let init_mode = if let Some(ref resume_id) = resume_session_id {
            messages::InitialMessageMode::Resume(resume_id.clone())
        } else if is_fork {
            messages::InitialMessageMode::Fork
        } else {
            messages::InitialMessageMode::Fresh
        };
        let messages: Vec<Value> = self
            .build_initial_messages(&full_system_prompt, prompt, init_mode)
            .await?;

        // 8. Build turn config — subagents get a default iteration budget.
        // Hitting the budget is NOT a failure: `execute_turn` exits the
        // loop normally and the parent still receives everything produced
        // so far (claude_code `max_turns_reached` semantics). Per-agent
        // overrides come from the definition's `session_model.max_iterations`.
        let max_iterations = agent
            .session_model
            .as_ref()
            .map(|sm| sm.max_iterations)
            .unwrap_or(DEFAULT_SUBAGENT_MAX_ITERATIONS);
        let turn_config = TurnConfig {
            model: model.clone(),
            max_iterations: Some(max_iterations),
            max_tokens: agent.max_tokens.unwrap_or(self.config.max_tokens as u64) as u32,
            temperature: agent.temperature.unwrap_or(self.config.temperature as f64) as f32,
            max_tool_use_concurrency: agent
                .max_tool_use_concurrency
                .unwrap_or(crate::core::definitions::schema::DEFAULT_MAX_TOOL_USE_CONCURRENCY)
                as usize,
            screenshot_store: None,
            iteration_hook: None,
            persist_cancel_marker: false,
        };

        // 9. Create subagent session ID (reuse for resume, new for fresh).
        // Prefix constants live in `agent_core::core::definitions::prefix_lookup`
        // (re-exported as `crate::definitions::prefix_lookup` here) so the
        // session-id parser (`looks_like_valid_subagent_session_id`) and any
        // future routing logic share a single source of truth.
        use crate::definitions::prefix_lookup::{
            SHADOW_SUBAGENT_SESSION_PREFIX, SUBAGENT_SESSION_PREFIX,
        };
        let id_prefix = if is_shadow {
            SHADOW_SUBAGENT_SESSION_PREFIX
        } else {
            SUBAGENT_SESSION_PREFIX
        };
        let subagent_session_id = resume_session_id.unwrap_or_else(|| {
            // `id_prefix` already ends with `-` (constant); avoid double-dash.
            format!("{}{}-{}", id_prefix, agent_id, uuid::Uuid::new_v4())
        });

        let subagent_type_wire = if is_shadow {
            helpers::subagent_type::SHADOW.to_string()
        } else {
            subagent_type_label(&agent_id)
        };

        // The parent↔child linkage — stamping `subagentSessionId` + `action: "delegate"`
        // onto the parent's still-running `agent` tool_call event — happens inside
        // `UnifiedSubagentHandler::with_app_handle`
        // (→ `stamp_subagent_session_id_on_parent`, write-through to SQLite).
        // This lives on the handler, not here, because the handler is the single
        // object guaranteed to exist at subagent-start time across all launch
        // paths (processor-level dispatch, auto-explore, etc.).
        let handler = UnifiedSubagentHandler::new(SubagentHandlerConfig {
            parent_session_id: parent_session_id.clone(),
            subagent_session_id: subagent_session_id.clone(),
            description: description.to_string(),
            subagent_type: subagent_type_wire.clone(),
            agent_name: Some(agent.name.clone()),
            instance_number: Some(instance_number),
            parent_call_id: parent_call_id.clone(),
        });
        let handler = if let Some(ref handle) = self.config.app_handle {
            handler.with_app_handle(handle.clone())
        } else {
            handler
        };

        // 9b. Persist child session as a proper agent_sessions row.
        //
        // Identity inheritance: the child must inherit the parent's
        // `account_id` and `key_source` so the wallet that pays for the
        // parent's turn also pays for the subagent's turn. Skipping these
        // (the previous `..Default::default()` shape) silently downgraded
        // every subagent of a hosted_key parent to `OwnKey`, mis-billing
        // the ORGII-provided credits to the user's BYOK wallet — same
        // family of split-brain as the compaction-fork bug.
        //
        // Mode inheritance: the child must also inherit
        // `agent_exec_mode`. A parent in `Plan` mode that spawns an
        // explore subagent expects the subagent to honour Plan-mode
        // policy (read-only). Falling through `..Default::default()` to
        // `None` silently lets the child default-Build a plan-restricted
        // turn — same class of split-brain as the billing case above.
        //
        // We read the parent row synchronously here because the surrounding
        // `upsert_session` call below is also sync — both share the
        // single-process SQLite connection pool and we're already on a
        // tokio task that hosts the agent loop's blocking IO. If reading
        // the parent fails (e.g. the parent row hasn't been persisted yet
        // for some odd lifecycle ordering), fall back to logging-and-
        // defaults rather than erroring out the subagent spawn — the same
        // best-effort posture the persistence step itself uses.
        let (
            parent_account_id,
            parent_key_source,
            parent_agent_exec_mode,
            parent_native_harness_type,
        ) = match crate::session::persistence::get_session(&parent_session_id) {
            Ok(Some(parent)) => (
                parent.account_id,
                parent.key_source,
                parent.agent_exec_mode,
                parent.native_harness_type,
            ),
            Ok(None) => {
                warn!(
                    "[agent] Worker spawn: parent session {} has no agent_sessions row \
                         yet — defaulting child account_id=None, key_source=OwnKey, \
                         agent_exec_mode=None. This is expected only when the parent is \
                         itself mid-creation; otherwise it indicates a lifecycle ordering bug.",
                    parent_session_id
                );
                (
                    None,
                    core_types::key_source::KeySource::default(),
                    None,
                    None,
                )
            }
            Err(err) => {
                warn!(
                    "[agent] Worker spawn: failed to read parent session {} for \
                         identity inheritance: {} — defaulting child account_id=None, \
                         key_source=OwnKey, agent_exec_mode=None, native_harness_type=None",
                    parent_session_id, err
                );
                (
                    None,
                    core_types::key_source::KeySource::default(),
                    None,
                    None,
                )
            }
        };

        {
            let record = crate::session::persistence::UnifiedSessionRecord {
                session_id: subagent_session_id.clone(),
                name: format!(
                    "{} ({})",
                    agent.name,
                    crate::utils::safe_truncate_chars_to_string(&description, 60)
                ),
                status: crate::session::SessionStatus::Running.as_str().to_string(),
                model: Some(model.clone()),
                account_id: parent_account_id,
                key_source: parent_key_source,
                session_type: crate::session::persistence::session_type::SUBAGENT.to_string(),
                parent_session_id: Some(parent_session_id.clone()),
                parent_event_id: None,
                agent_definition_id: Some(agent_id.clone()),
                // Inherit workspace_path from parent so tools like create_plan can
                // resolve the correct on-disk location (e.g. {project}/.orgii/plans/).
                // Without this the DB record has workspace_path=NULL and the
                // fallback writes to ~/.orgii/plans/{agent_id}/ instead.
                workspace_path: self.config.workspace_path.clone(),
                agent_exec_mode: parent_agent_exec_mode,
                native_harness_type: parent_native_harness_type,
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                ..Default::default()
            };
            if let Err(err) = crate::session::persistence::upsert_session(&record) {
                warn!(
                    "[agent] Failed to persist child session {}: {}",
                    subagent_session_id, err
                );
            }
        }

        // 10. Write LinkedSession entry (if tracking is enabled)
        self.write_linked_session(
            &subagent_session_id,
            &parent_session_id,
            &agent.name,
            instance_number,
        )
        .await;

        let workspace = self.resolve_repo_path().await;
        let (run_workspace, final_registry_arc, isolation_workspace_root) =
            match effective_isolation {
                Some(SubAgentIsolation::Worktree) => {
                    let (isolated_workspace, worktree_info) = match self
                        .create_worktree_workspace(&subagent_session_id, workspace.clone())
                        .await
                    {
                        Ok(result) => result,
                        Err(err) => {
                            let _ = crate::session::persistence::update_status(
                                &subagent_session_id,
                                crate::session::SessionStatus::Failed,
                            );
                            return Err(err);
                        }
                    };
                    if let Err(err) = crate::session::persistence::save_workspace(
                        &subagent_session_id,
                        &isolated_workspace,
                    ) {
                        let workspace_root = isolated_workspace.workspace_root.clone();
                        let session_id = subagent_session_id.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            git::worktree::remove_session_worktree(
                                &workspace_root,
                                &session_id,
                                true,
                            )
                        })
                        .await;
                        let _ = crate::session::persistence::update_status(
                            &subagent_session_id,
                            crate::session::SessionStatus::Failed,
                        );
                        return Err(ToolError::ExecutionFailed(format!(
                            "failed to persist subagent worktree workspace: {err}"
                        )));
                    }
                    if let Some(base_branch) = worktree_info.base_branch.as_deref() {
                        if let Err(err) = crate::session::persistence::save_worktree_metadata(
                            &subagent_session_id,
                            &worktree_info.branch,
                            base_branch,
                            git::worktree::WorktreeMergeStatus::Pending,
                        ) {
                            let workspace_root = isolated_workspace.workspace_root.clone();
                            let session_id = subagent_session_id.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                git::worktree::remove_session_worktree(
                                    &workspace_root,
                                    &session_id,
                                    true,
                                )
                            })
                            .await;
                            let _ = crate::session::persistence::clear_worktree_metadata(
                                &subagent_session_id,
                            );
                            let _ = crate::session::persistence::update_status(
                                &subagent_session_id,
                                crate::session::SessionStatus::Failed,
                            );
                            return Err(ToolError::ExecutionFailed(format!(
                                "failed to persist subagent worktree metadata: {err}"
                            )));
                        }
                    }
                    let workspace_root = isolated_workspace.workspace_root.clone();
                    let registry = self.with_workspace_coding_overlay(
                        Arc::clone(&effective_registry_arc),
                        isolated_workspace.clone(),
                        &subagent_session_id,
                    );
                    (
                        isolated_workspace.working_dir().to_path_buf(),
                        registry,
                        Some(workspace_root),
                    )
                }
                None => (workspace, Arc::clone(&effective_registry_arc), None),
            };
        let final_registry = final_registry_arc.as_ref();

        // ── Background mode: spawn and return handle immediately ─────
        if is_background {
            return Ok(Self::spawn_background_subagent(
                background::BackgroundSpawnArgs {
                    agent: &agent,
                    messages,
                    turn_config,
                    effective_policy,
                    fresh_registry: None,
                    parent_registry: Arc::clone(&final_registry_arc),
                    workspace: run_workspace,
                    subagent_session_id,
                    parent_session_id,
                    subagent_type_label: subagent_type_wire,
                    model,
                    provider: Arc::clone(&subagent_provider),
                    work_item_id: self.config.work_item_id.clone(),
                    parent_cancel_flag: self.config.parent_cancel_flag.clone(),
                    handler,
                    worktree_workspace_root: isolation_workspace_root,
                },
            ));
        }

        // ── Foreground mode: block until subagent completes ──────────
        let fg_session_id = subagent_session_id.clone();
        let result = self
            .run_foreground_subagent(foreground::ForegroundRunArgs {
                agent: &agent,
                messages,
                turn_config,
                effective_registry: final_registry,
                effective_policy,
                workspace: run_workspace.as_path(),
                subagent_session_id,
                parent_session_id,
                subagent_type_label: subagent_type_wire,
                handler,
                instance_number,
                model,
                provider: subagent_provider,
            })
            .await;

        // Clean up the isolation worktree after foreground subagent exits
        // (success or failure). Best-effort: a failed cleanup is logged and
        // the startup pruner will handle the orphan on next launch.
        if let Some(workspace_root) = isolation_workspace_root {
            let session_id_for_log = fg_session_id.clone();
            let wt_result = tokio::task::spawn_blocking(move || {
                git::worktree::remove_session_worktree(&workspace_root, &fg_session_id, true)
            })
            .await;
            if let Ok(Err(err)) = wt_result {
                warn!(
                    "[agent] failed to remove isolation worktree for '{}' after foreground completion: {}",
                    session_id_for_log, err
                );
            }
        }

        result
    }

    async fn set_active_repo(&self, repo_path: &str) {
        let path = PathBuf::from(repo_path);
        if path.exists() {
            *self.active_repo.lock().await = Some(path);
        }
    }

    async fn set_context(&self, _channel: &str, _chat_id: &str, _sender_id: &str) {}

    async fn set_parent_messages(&self, messages: &[Value]) {
        *self.parent_messages.lock().await = messages.to_vec();
    }
}
