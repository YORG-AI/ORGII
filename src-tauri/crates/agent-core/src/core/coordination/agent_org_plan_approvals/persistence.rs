use rusqlite::{params, Connection, OptionalExtension};

use crate::definitions::orgs::PlanApprovalPolicy;

use super::{AgentOrgPlanApproval, AgentOrgPlanApprovalStatus, AgentOrgPlanApprovalSummary};

pub(super) fn insert_record(
    conn: &Connection,
    approval: &AgentOrgPlanApproval,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_approvals (
            approval_id, plan_revision_id, request_id, org_run_id,
            source_task_id, source_member_id, source_session_id, source_turn_intent_id,
            root_session_id,
            policy, status, plan_title, plan_path, plan_content, decision_by,
            feedback, created_at, resolved_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        params![
            &approval.approval_id,
            &approval.plan_revision_id,
            &approval.request_id,
            &approval.org_run_id,
            &approval.source_task_id,
            &approval.source_member_id,
            &approval.source_session_id,
            &approval.source_turn_intent_id,
            &approval.root_session_id,
            approval.policy.as_wire(),
            approval.status.as_wire(),
            &approval.plan_title,
            &approval.plan_path,
            &approval.plan_content,
            approval.decision_by.as_deref(),
            approval.feedback.as_deref(),
            &approval.created_at,
            approval.resolved_at.as_deref(),
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn query_record<P: rusqlite::Params>(
    conn: &Connection,
    where_clause: &str,
    params: P,
) -> Result<Option<AgentOrgPlanApproval>, String> {
    let sql = format!(
        "SELECT approval_id, plan_revision_id, request_id, org_run_id,
                source_task_id, source_member_id, source_session_id, source_turn_intent_id,
                root_session_id, policy, status, plan_title, plan_path,
                plan_content, decision_by, feedback, created_at, resolved_at
         FROM agent_org_runtime_plan_approvals {where_clause} LIMIT 1"
    );
    conn.query_row(&sql, params, row_to_record)
        .optional()
        .map_err(|err| err.to_string())
}

pub(super) fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgPlanApproval> {
    let policy_raw: String = row.get(9)?;
    let status_raw: String = row.get(10)?;
    let policy = parse_policy(9, &policy_raw)?;
    let status = AgentOrgPlanApprovalStatus::from_wire(&status_raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, err.into())
    })?;
    Ok(AgentOrgPlanApproval {
        approval_id: row.get(0)?,
        plan_revision_id: row.get(1)?,
        request_id: row.get(2)?,
        org_run_id: row.get(3)?,
        source_task_id: row.get(4)?,
        source_member_id: row.get(5)?,
        source_session_id: row.get(6)?,
        source_turn_intent_id: row.get(7)?,
        root_session_id: row.get(8)?,
        policy,
        status,
        plan_title: row.get(11)?,
        plan_path: row.get(12)?,
        plan_content: row.get(13)?,
        decision_by: row.get(14)?,
        feedback: row.get(15)?,
        created_at: row.get(16)?,
        resolved_at: row.get(17)?,
    })
}

pub(super) fn row_to_summary(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<AgentOrgPlanApprovalSummary> {
    let policy_raw: String = row.get(9)?;
    let status_raw: String = row.get(10)?;
    let plan_content_bytes_raw: i64 = row.get(12)?;
    let plan_content_bytes = u64::try_from(plan_content_bytes_raw)
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(12, plan_content_bytes_raw))?;
    Ok(AgentOrgPlanApprovalSummary {
        approval_id: row.get(0)?,
        plan_revision_id: row.get(1)?,
        request_id: row.get(2)?,
        org_run_id: row.get(3)?,
        source_task_id: row.get(4)?,
        source_member_id: row.get(5)?,
        source_session_id: row.get(6)?,
        source_turn_intent_id: row.get(7)?,
        root_session_id: row.get(8)?,
        policy: parse_policy(9, &policy_raw)?,
        status: AgentOrgPlanApprovalStatus::from_wire(&status_raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, err.into())
        })?,
        plan_title: row.get(11)?,
        plan_content_bytes,
        created_at: row.get(13)?,
    })
}

fn parse_policy(column: usize, policy_raw: &str) -> rusqlite::Result<PlanApprovalPolicy> {
    Ok(match policy_raw {
        "coordinator" => PlanApprovalPolicy::Coordinator,
        "user" => PlanApprovalPolicy::User,
        "automatic" => PlanApprovalPolicy::Automatic,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                format!("unknown plan approval policy: {policy_raw}").into(),
            ))
        }
    })
}
