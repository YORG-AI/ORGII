//! Stable Tool facade and foreground/background launch dispatch.

use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, warn};

use crate::tools::impls::coding::exec::registry as job_registry;
use crate::tools::impls::orchestration::subagent_handler::{
    SubagentHandlerConfig, UnifiedSubagentHandler,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

use super::background;
use super::foreground;
use super::request::{self, LaunchRequest};
use super::{helpers, subagent_of_subagent_rejection, subagent_type_label, AgentTool};

#[async_trait]
impl Tool for AgentTool {
    fn name(&self) -> &str {
        tool_names::AGENT
    }

    fn description(&self) -> &str {
        super::schema::DESCRIPTION
    }

    fn llm_description(&self) -> Option<String> {
        super::schema::llm_description(self.config.allowed_subagents.as_ref())
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn is_concurrency_safe(&self) -> bool {
        true
    }

    fn schema_priority(&self) -> i8 {
        -10
    }

    fn allow_persisted_output(&self) -> bool {
        false
    }

    fn output_budget(&self) -> usize {
        100_000
    }

    fn parameters(&self) -> Value {
        super::schema::parameters()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let parent_call_id = (!ctx.call_id.is_empty()).then(|| ctx.call_id.clone());

        // Kill remains the first command branch, ahead of every launch guard.
        if let Some(handle) = request::kill_handle(&params)? {
            return kill_subagent(handle);
        }

        if let Some(err) = subagent_of_subagent_rejection(&self.config.delegation_chain) {
            return Err(err);
        }

        let request = LaunchRequest::parse(&params)?;
        self.execute_launch(request, parent_call_id).await
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

fn kill_subagent(handle: &str) -> Result<String, ToolError> {
    match job_registry::kill_subagent(handle) {
        Ok(()) => {
            let partial = {
                let session_id = handle.to_string();
                tokio::task::block_in_place(|| {
                    crate::session::persistence::load_llm_history(&session_id)
                        .ok()
                        .and_then(|messages| crate::turn_executor::last_assistant_text(&messages))
                })
            };
            Ok(match partial {
                Some(text) if !text.trim().is_empty() => format!(
                    "Worker '{handle}' killed.\n\n[partial progress before kill]\n{}",
                    crate::utils::safe_truncate_chars_to_string(&text, 4000)
                ),
                _ => format!("Worker '{handle}' killed."),
            })
        }
        Err(message) => Err(ToolError::ExecutionFailed(message)),
    }
}

impl AgentTool {
    async fn execute_launch(
        &self,
        request: LaunchRequest,
        parent_call_id: Option<String>,
    ) -> Result<String, ToolError> {
        if request.used_agent_fallback {
            warn!(
                "[agent] delegate mode called without 'agent_id'; falling back to '{}'. \
                 Consider supplying an explicit agent_id (e.g. 'builtin:explore') for better routing.",
                crate::definitions::builtin::GENERAL_AGENT_ID
            );
        }
        let effective_isolation = self.effective_isolation(&request);
        if let Some(ref resume_id) = request.resume_session_id {
            info!(
                "[agent] Resuming session '{}' with agent '{}' (mode={})",
                resume_id, request.agent_id, request.mode
            );
        } else {
            info!(
                "[agent] Invoking '{}': {} (mode={}, background={})",
                request.agent_id, request.description, request.mode, request.is_background
            );
        }

        let agent = self.resolve_agent(&request.agent_id)?;
        let delegation_config = agent.delegation_config.clone().unwrap_or_default();
        let instance_number = self
            .authorize_and_reserve_instance(&request, &agent, &delegation_config)
            .await?;

        // Announce a provisional job before provider/registry/worktree setup.
        use crate::definitions::prefix_lookup::{
            SHADOW_SUBAGENT_SESSION_PREFIX, SUBAGENT_SESSION_PREFIX,
        };
        let id_prefix = if request.is_shadow {
            SHADOW_SUBAGENT_SESSION_PREFIX
        } else {
            SUBAGENT_SESSION_PREFIX
        };
        let subagent_session_id = request.resume_session_id.clone().unwrap_or_else(|| {
            format!("{}{}-{}", id_prefix, request.agent_id, uuid::Uuid::new_v4())
        });
        let subagent_type_wire = if request.is_shadow {
            helpers::subagent_type::SHADOW.to_string()
        } else {
            subagent_type_label(&request.agent_id)
        };
        let parent_session_id = self.parent_session_id.lock().await.clone();
        let mut provisional_guard = helpers::ProvisionalJobGuard::announce(
            &parent_session_id,
            &subagent_session_id,
            &agent.name,
            &subagent_type_wire,
        );

        let mut plan = self
            .build_launch_plan(&request, &agent, &delegation_config, &parent_session_id)
            .await?;
        let handler = UnifiedSubagentHandler::new(SubagentHandlerConfig {
            parent_session_id: parent_session_id.clone(),
            subagent_session_id: subagent_session_id.clone(),
            description: request.description.clone(),
            subagent_type: subagent_type_wire.clone(),
            agent_name: Some(agent.name.clone()),
            instance_number: Some(instance_number),
            parent_call_id,
        });
        let handler = if let Some(ref app_handle) = self.config.app_handle {
            handler.with_app_handle(app_handle.clone())
        } else {
            handler
        };

        let inheritance = self.read_parent_inheritance(&parent_session_id);
        plan.policy = Self::overlay_parent_modes(
            plan.policy,
            inheritance
                .agent_exec_mode
                .as_deref()
                .and_then(crate::session::AgentExecMode::parse),
        );
        self.persist_child_session(
            &request,
            &agent,
            &subagent_session_id,
            &parent_session_id,
            &plan.model,
            inheritance,
        );
        self.write_linked_session(
            &subagent_session_id,
            &parent_session_id,
            &agent.name,
            instance_number,
        )
        .await;

        let prepared = self
            .prepare_workspace(effective_isolation, plan.registry, &subagent_session_id)
            .await?;

        provisional_guard.disarm();
        if request.is_background {
            return Ok(Self::spawn_background_subagent(
                background::BackgroundSpawnArgs {
                    agent: &agent,
                    messages: plan.messages,
                    turn_config: plan.turn_config,
                    effective_policy: plan.policy,
                    fresh_registry: None,
                    parent_registry: Arc::clone(&prepared.registry),
                    subagent_session_id,
                    parent_session_id,
                    subagent_type_label: subagent_type_wire,
                    model: plan.model,
                    provider: Arc::clone(&plan.provider),
                    work_item_id: self.config.work_item_id.clone(),
                    parent_cancel_flag: self.config.parent_cancel_flag.clone(),
                    handler,
                    worktree_workspace_root: prepared.worktree_workspace_root,
                },
            ));
        }

        self.run_foreground_subagent(foreground::ForegroundRunArgs {
            agent,
            messages: plan.messages,
            turn_config: plan.turn_config,
            effective_registry: prepared.registry,
            effective_policy: plan.policy,
            subagent_session_id,
            parent_session_id,
            subagent_type_label: subagent_type_wire,
            handler,
            instance_number,
            model: plan.model,
            provider: plan.provider,
            worktree_workspace_root: prepared.worktree_workspace_root,
        })
        .await
    }
}
