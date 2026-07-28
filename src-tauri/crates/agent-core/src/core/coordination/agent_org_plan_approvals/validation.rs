use crate::coordination::agent_org_payload_limits::{
    validate_required_text, PLAN_CONTENT_MAX_BYTES, PLAN_CONTENT_MAX_CHARS, PLAN_PATH_MAX_BYTES,
    PLAN_PATH_MAX_CHARS, PLAN_TITLE_MAX_BYTES, PLAN_TITLE_MAX_CHARS,
};
use crate::definitions::orgs::PlanApprovalPolicy;

use super::{AgentOrgPlanDecisionBy, AgentOrgPlanInboxDelivery, CreateAgentOrgPlanApprovalParams};

pub(super) fn validate_delivery(delivery: &AgentOrgPlanInboxDelivery) -> Result<(), String> {
    if delivery.recipient_agent_id.trim().is_empty() || delivery.sender_agent_id.trim().is_empty() {
        Err("plan approval delivery requires non-empty agent ids".to_string())
    } else {
        Ok(())
    }
}

pub(super) fn validate_create_params(
    params: &CreateAgentOrgPlanApprovalParams,
) -> Result<(), String> {
    if params.request_id.trim().is_empty()
        || params.org_run_id.trim().is_empty()
        || params.source_task_id.trim().is_empty()
        || params.source_member_id.trim().is_empty()
        || params.source_session_id.trim().is_empty()
        || params.root_session_id.trim().is_empty()
    {
        return Err("plan approval identifiers must not be empty".to_string());
    }
    validate_required_text(
        "plan approval title",
        &params.plan_title,
        PLAN_TITLE_MAX_CHARS,
        PLAN_TITLE_MAX_BYTES,
    )?;
    validate_required_text(
        "plan approval path",
        &params.plan_path,
        PLAN_PATH_MAX_CHARS,
        PLAN_PATH_MAX_BYTES,
    )?;
    validate_required_text(
        "plan approval content",
        &params.plan_content,
        PLAN_CONTENT_MAX_CHARS,
        PLAN_CONTENT_MAX_BYTES,
    )
}

pub(super) fn authorize_decision(
    policy: PlanApprovalPolicy,
    decision_by: AgentOrgPlanDecisionBy,
) -> Result<(), String> {
    let authorized = matches!(
        (policy, decision_by),
        (PlanApprovalPolicy::User, AgentOrgPlanDecisionBy::User)
            | (
                PlanApprovalPolicy::Coordinator,
                AgentOrgPlanDecisionBy::Coordinator
            )
            | (
                PlanApprovalPolicy::Automatic,
                AgentOrgPlanDecisionBy::System
            )
    );
    if authorized {
        Ok(())
    } else {
        Err(format!(
            "agent_org_plan_approval_unauthorized: policy={} decision_by={}",
            policy.as_wire(),
            decision_by.as_wire()
        ))
    }
}
