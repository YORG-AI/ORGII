//! Model/provider, registry/policy, message, and turn-config resolution.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tracing::warn;

use crate::definitions::builtin::EXPLORE_AGENT_ID;
use crate::definitions::{AgentDefinition, DelegationConfig};
use crate::providers::traits::LLMProvider;
use crate::tools::names as tool_names;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::{Tool, ToolError};
use crate::turn_executor::TurnConfig;

use super::messages;
use super::request::LaunchRequest;
use super::AgentTool;

/// Default per-turn iteration budget for definitions without an override.
const DEFAULT_SUBAGENT_MAX_ITERATIONS: u32 = 100;

pub(super) struct LaunchPlan {
    pub(super) messages: Vec<Value>,
    pub(super) turn_config: TurnConfig,
    pub(super) registry: Arc<ToolRegistry>,
    pub(super) policy: ResolvedToolPolicy,
    pub(super) model: String,
    pub(super) provider: Arc<dyn LLMProvider>,
}

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

impl AgentTool {
    pub(super) async fn build_launch_plan(
        &self,
        request: &LaunchRequest,
        agent: &AgentDefinition,
        delegation_config: &DelegationConfig,
        parent_session_id: &str,
    ) -> Result<LaunchPlan, ToolError> {
        // Subagents resolve their own model and reliability chain. Shadow
        // workers keep the parent's exact model for prompt-cache parity.
        let parent_model = self.model.lock().await.clone();
        let (model, sub_reliability_opt) = super::helpers::resolve_subagent_model(
            agent,
            request.explicit_model.as_deref(),
            &parent_model,
            request.is_shadow,
        );

        let parent_account_id_for_provider = self.config.session_account_id.clone().or_else(|| {
            crate::session::persistence::get_session(parent_session_id)
                .ok()
                .flatten()
                .and_then(|parent| parent.account_id)
        });
        let provider: Arc<dyn LLMProvider> = match sub_reliability_opt.as_ref() {
            Some(reliability) => {
                match crate::providers::factory::create_provider_with_native_harness_preflight(
                    &model,
                    parent_account_id_for_provider.as_deref(),
                    reliability,
                    self.config.native_harness_type,
                    Some(self.config.workspace.clone()),
                )
                .await
                {
                    Ok(boxed) => Arc::from(boxed),
                    Err(err) if self.config.native_harness_type.is_some() => {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Failed to build native sub-agent provider for '{}' with model '{}': {err}",
                            request.agent_id, model
                        )));
                    }
                    Err(err) => {
                        warn!(
                            "[agent] Failed to build sub-agent provider for '{}' with model \
                             '{}' (account={:?}): {}. Falling back to parent provider — \
                             the sub-agent will run on the parent's currently active model.",
                            request.agent_id, model, parent_account_id_for_provider, err
                        );
                        Arc::clone(&self.config.provider)
                    }
                }
            }
            None if self.config.native_harness_type.is_some() => {
                match crate::providers::factory::create_provider_with_native_harness_preflight(
                    &model,
                    parent_account_id_for_provider.as_deref(),
                    &crate::config::ReliabilityConfig::default(),
                    self.config.native_harness_type,
                    Some(self.config.workspace.clone()),
                )
                .await
                {
                    Ok(boxed) => Arc::from(boxed),
                    Err(err) => {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Failed to build native sub-agent provider for '{}' with model '{}': {err}",
                            request.agent_id, model
                        )));
                    }
                }
            }
            None => Arc::clone(&self.config.provider),
        };

        let has_allow_list = agent.tools.system_restrict_to_tools.is_some();
        let parent_registry = self.parent_registry_snapshot();
        let (base_registry, policy) = if request.is_shadow {
            (
                Arc::clone(&parent_registry),
                self.build_inherited_policy(agent),
            )
        } else if request.agent_id == EXPLORE_AGENT_ID || !has_allow_list {
            let policy = if request.agent_id == EXPLORE_AGENT_ID {
                self.build_explore_policy(agent)?
            } else {
                self.build_inherited_policy(agent)
            };
            (Arc::clone(&parent_registry), policy)
        } else {
            (
                Arc::new(self.build_fresh_registry(agent).await?),
                self.build_fresh_policy(agent),
            )
        };

        // Delegate/Shadow workers are not canonical Agent Org participants.
        let registry = if self.config.agent_org_context.is_some() {
            let mut overlay = ToolRegistry::with_fallback(base_registry);
            overlay.register(Box::new(DisabledOrgSendMessageTool));
            Arc::new(overlay)
        } else {
            base_registry
        };

        let full_system_prompt = self
            .build_full_system_prompt(agent, &request.agent_id, delegation_config, &model)
            .await?;
        let init_mode = if let Some(ref resume_id) = request.resume_session_id {
            messages::InitialMessageMode::Resume(resume_id.clone())
        } else if request.fork {
            messages::InitialMessageMode::Fork
        } else {
            messages::InitialMessageMode::Fresh
        };
        let messages = self
            .build_initial_messages(&full_system_prompt, &request.prompt, init_mode)
            .await?;

        let max_iterations = agent
            .session_model
            .as_ref()
            .map(|session_model| session_model.max_iterations)
            .unwrap_or(DEFAULT_SUBAGENT_MAX_ITERATIONS);
        let turn_config = TurnConfig {
            turn_intent_id: String::new(),
            projected_inbox_ids: Vec::new(),
            model: model.clone(),
            account_id: self.config.session_account_id.clone(),
            context_window_override: agent.context_window,
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
            steering_queue: None,
            auto_continue: false,
        };

        Ok(LaunchPlan {
            messages,
            turn_config,
            registry,
            policy,
            model,
            provider,
        })
    }
}
