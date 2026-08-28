use super::{project_run_phase, AgentOrgRunPhase, AgentOrgRunTaskOverview};
use crate::coordination::agent_org_final_summary::{FinalSummaryReceipt, FinalSummaryStatus};
use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanDecisionStatus, AgentOrgPlanRevisionSummary,
};
use crate::coordination::agent_org_runs::AgentOrgRunStatus;
use crate::definitions::orgs::PlanApprovalPolicy;

fn overview(in_progress: usize, completed: usize) -> AgentOrgRunTaskOverview {
    AgentOrgRunTaskOverview {
        total: in_progress + completed,
        pending: 0,
        in_progress,
        completed,
        failed: 0,
        cancelled: 0,
        corrupt: 0,
        visible: in_progress + completed,
        truncated: false,
    }
}

#[test]
fn finalizing_requires_an_active_final_summary_receipt() {
    let completed = overview(0, 1);
    assert_eq!(
        project_run_phase(AgentOrgRunStatus::Running, &[], &completed, 0, &[], None),
        AgentOrgRunPhase::Coordinating
    );

    let summary = FinalSummaryReceipt {
        receipt_id: "summary-1".into(),
        org_run_id: "run-1".into(),
        activation_generation: 1,
        certificate_id: "certificate-1".into(),
        evidence_digest: "a".repeat(64),
        attempt: 1,
        status: FinalSummaryStatus::Pending,
        coordinator_session_id: "root-session".into(),
        turn_intent_id: None,
        started_at: None,
        terminal_at: None,
        event_id: None,
        typed_error: None,
        can_retry: false,
        created_at: "2026-05-28T00:00:00Z".into(),
        updated_at: "2026-05-28T00:00:00Z".into(),
    };
    assert_eq!(
        project_run_phase(
            AgentOrgRunStatus::Running,
            &[],
            &completed,
            0,
            &[],
            Some(&summary),
        ),
        AgentOrgRunPhase::Finalizing
    );
    assert_eq!(
        project_run_phase(AgentOrgRunStatus::Idle, &[], &overview(0, 0), 0, &[], None,),
        AgentOrgRunPhase::Idle
    );
}

#[test]
fn a_pending_user_plan_projects_awaiting_approval() {
    let revision = AgentOrgPlanRevisionSummary {
        approval_id: "approval-1".to_string(),
        plan_revision_id: "revision-1".to_string(),
        revision_number: 1,
        previous_plan_revision_id: None,
        request_id: "request-1".to_string(),
        org_run_id: "run-1".to_string(),
        source_task_id: "plan-task".to_string(),
        source_member_id: "member-planner".to_string(),
        source_session_id: "planner-session".to_string(),
        source_turn_intent_id: "planner-turn".to_string(),
        root_session_id: "root-session".to_string(),
        policy: PlanApprovalPolicy::User,
        status: AgentOrgPlanDecisionStatus::Pending,
        plan_title: "Plan".to_string(),
        plan_content_bytes: 6,
        content_digest: "a".repeat(64),
        decision_by: None,
        feedback: None,
        task_output: None,
        created_at: "2026-05-28T00:00:00Z".to_string(),
        resolved_at: None,
    };

    assert_eq!(
        project_run_phase(
            AgentOrgRunStatus::Running,
            &[],
            &overview(1, 0),
            0,
            &[revision],
            None,
        ),
        AgentOrgRunPhase::AwaitingPlanApproval
    );
}
