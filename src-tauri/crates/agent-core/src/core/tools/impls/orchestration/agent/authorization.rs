//! Delegation authorization, roster separation, and instance limits.

use crate::definitions::builtin::{EXPLORE_AGENT_ID, GENERAL_AGENT_ID};
use crate::definitions::{AgentDefinition, DelegationConfig};
use crate::tools::traits::ToolError;

use super::request::LaunchRequest;
use super::{org_roster_spawn_rejection, AgentTool};

impl AgentTool {
    pub(super) async fn authorize_and_reserve_instance(
        &self,
        request: &LaunchRequest,
        agent: &AgentDefinition,
        delegation_config: &DelegationConfig,
    ) -> Result<u32, ToolError> {
        if !request.is_shadow && !agent.built_in && !delegation_config.delegatable {
            return Err(ToolError::ExecutionFailed(format!(
                "Agent '{}' is not configured for delegation",
                request.agent_id
            )));
        }

        // Keep the semantic org-roster error ahead of the generic allowlist
        // error, matching the original launch chokepoint.
        if let Some(err) = org_roster_spawn_rejection(
            request.is_shadow,
            self.config.is_org_member,
            self.config.agent_org_context.as_deref(),
            &request.agent_id,
            request.is_background,
        ) {
            return Err(err);
        }

        let target_is_org_roster_member = self
            .config
            .agent_org_context
            .as_ref()
            .map(|org_context| {
                !self.config.is_org_member
                    && org_context
                        .members
                        .iter()
                        .any(|member| member.agent_id == request.agent_id)
            })
            .unwrap_or(false);
        if !request.is_shadow
            && request.agent_id != EXPLORE_AGENT_ID
            && request.agent_id != GENERAL_AGENT_ID
            && !target_is_org_roster_member
        {
            if let Some(ref allowed) = self.config.allowed_subagents {
                if !allowed.iter().any(|id| id == &request.agent_id) {
                    return Err(ToolError::ExecutionFailed(format!(
                        "Agent '{}' is not in the allowed subagents list for this session",
                        request.agent_id
                    )));
                }
            }
        }

        self.next_instance_number(&request.agent_id).await
    }
}
