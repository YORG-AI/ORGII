//! Agent operations tool registration: session, comms, question, nodes,
//! project, agent definition.
//!
//! Note: The unified `agent` tool is registered separately in OS/SDE init
//! because it requires additional dependencies (LLM provider).

use std::collections::HashSet;
use std::sync::Arc;

use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

use crate::tools::impls::agent_def::AgentDefinitionTool;
use crate::tools::impls::comms::send_message::MessageTool;
use crate::tools::impls::nodes::manage_nodes::NodesTool;
use crate::tools::impls::orchestration::ask_user_questions::{QuestionTool, QuestionToolContext};
use crate::tools::impls::orchestration::manage_secrets::{SecretTool, SecretToolContext};
use crate::tools::impls::orchestration::manage_session::SessionTool;
use crate::tools::impls::project::manage_project::ProjectTool;
use crate::tools::impls::project::manage_work_item::WorkItemTool;
use crate::tools::registry::ToolRegistry;

use super::{register_if_enabled, ToolDeps};

fn should_register_question_tool(
    has_agent_org_context: bool,
    current_member_id: Option<&str>,
) -> bool {
    !has_agent_org_context || current_member_id == Some(COORDINATOR_MEMBER_ID)
}

/// Register all agent-operations tools that `deps` can support.
///
/// Covers: `session`, `message`, `question`, `nodes`,
/// `project`, `agent_definition`.
///
/// Note: The unified `agent` tool is registered separately in OS/SDE agent init
/// because it requires an LLM provider which is created at agent initialization time.
pub fn register(registry: &mut ToolRegistry, deps: &ToolDeps, disabled: &HashSet<String>) {
    // ── Session (SDE agent management / human proxy) ──
    if let Some(ref bridge) = deps.action_bridge {
        register_if_enabled(
            registry,
            Box::new(SessionTool::new(
                Arc::clone(bridge),
                deps.session_account_id.clone(),
                deps.agent_model.clone(),
            )),
            disabled,
        );
    }

    // ── Message ──
    if let Some(ref bus) = deps.bus {
        register_if_enabled(registry, Box::new(MessageTool::new(bus.clone())), disabled);
    }

    // ── Question ──
    if should_register_question_tool(
        deps.agent_org_context.is_some(),
        deps.agent_org_current_member_id.as_deref(),
    ) {
        if let Some(ref qm) = deps.question_manager {
            let ctx = Arc::new(QuestionToolContext::new(Arc::clone(qm)));
            register_if_enabled(registry, Box::new(QuestionTool::new(ctx)), disabled);
        }
    }

    // ── Secret capture ──
    // Same gating as the question tool: subagents and non-coordinator org
    // members cannot mint secrets — only the top-level session that the
    // user is talking to can pop the secure modal.
    if should_register_question_tool(
        deps.agent_org_context.is_some(),
        deps.agent_org_current_member_id.as_deref(),
    ) {
        if let Some(ref broker) = deps.secret_broker {
            let ctx = Arc::new(SecretToolContext::new(Arc::clone(broker)));
            register_if_enabled(registry, Box::new(SecretTool::new(ctx)), disabled);
        }
    }

    // ── Nodes ──
    if let Some(ref node_reg) = deps.node_registry {
        register_if_enabled(
            registry,
            Box::new(NodesTool::new(node_reg.clone())),
            disabled,
        );
    }

    // ── Project / work items ──
    register_if_enabled(
        registry,
        Box::new(ProjectTool::new(
            deps.app_handle.clone(),
            deps.session_account_id.clone(),
            deps.agent_model.clone(),
        )),
        disabled,
    );
    register_if_enabled(
        registry,
        Box::new(WorkItemTool::with_launch_context(
            deps.session_id.clone(),
            deps.app_handle.clone(),
            deps.session_account_id.clone(),
            deps.agent_model.clone(),
        )),
        disabled,
    );

    // ── Agent definition ──
    if let Some(ref handle) = deps.app_handle {
        register_if_enabled(
            registry,
            Box::new(AgentDefinitionTool::new(handle.clone())),
            disabled,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::should_register_question_tool;
    use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

    #[test]
    fn registers_ask_user_for_non_org_sessions() {
        assert!(should_register_question_tool(false, None));
    }

    #[test]
    fn registers_ask_user_for_agent_org_coordinator_only() {
        assert!(should_register_question_tool(
            true,
            Some(COORDINATOR_MEMBER_ID)
        ));
        assert!(!should_register_question_tool(true, Some("worker-a")));
        assert!(!should_register_question_tool(true, None));
    }
}
