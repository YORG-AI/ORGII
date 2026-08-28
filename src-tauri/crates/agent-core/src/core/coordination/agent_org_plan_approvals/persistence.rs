use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_org_tasks::TaskOutput;
use crate::definitions::orgs::PlanApprovalPolicy;

use super::{
    AgentOrgPlanDecisionStatus, AgentOrgPlanRevision, AgentOrgPlanRevisionSummary,
    AgentOrgPlanTaskOutputRef,
};

pub(super) const RECORD_SELECT: &str =
    "decision.approval_id, revision.plan_revision_id, revision.revision_number,
     revision.previous_plan_revision_id, decision.request_id, revision.org_run_id,
     revision.source_task_id, revision.source_member_id, revision.source_session_id,
     revision.source_turn_intent_id, revision.root_session_id, decision.policy,
     decision.status, revision.plan_title, revision.plan_path, revision.plan_content,
     revision.content_digest, decision.decision_by, decision.feedback,
     revision.created_at, decision.resolved_at, task.output_json";

pub(super) fn insert_record(
    conn: &Connection,
    revision: &AgentOrgPlanRevision,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_revisions (
            plan_revision_id,org_run_id,source_task_id,source_member_id,
            source_session_id,source_turn_intent_id,root_session_id,
            revision_number,previous_plan_revision_id,plan_title,plan_path,
            plan_content,content_digest,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            &revision.plan_revision_id,
            &revision.org_run_id,
            &revision.source_task_id,
            &revision.source_member_id,
            &revision.source_session_id,
            &revision.source_turn_intent_id,
            &revision.root_session_id,
            revision.revision_number,
            revision.previous_plan_revision_id.as_deref(),
            &revision.plan_title,
            &revision.plan_path,
            &revision.plan_content,
            &revision.content_digest,
            &revision.created_at,
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_decisions (
            approval_id,plan_revision_id,request_id,policy,status,decision_by,
            feedback,created_at,resolved_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            &revision.approval_id,
            &revision.plan_revision_id,
            &revision.request_id,
            revision.policy.as_wire(),
            revision.status.as_wire(),
            revision.decision_by.as_deref(),
            revision.feedback.as_deref(),
            &revision.created_at,
            revision.resolved_at.as_deref(),
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn query_record<P: rusqlite::Params>(
    conn: &Connection,
    where_clause: &str,
    params: P,
) -> Result<Option<AgentOrgPlanRevision>, String> {
    let sql = format!(
        "SELECT {RECORD_SELECT}
         FROM agent_org_runtime_plan_revisions revision
         JOIN agent_org_runtime_plan_decisions decision
           ON decision.plan_revision_id=revision.plan_revision_id
         LEFT JOIN agent_org_runtime_tasks task
           ON task.org_run_id=revision.org_run_id AND task.id=revision.source_task_id
         {where_clause} LIMIT 1"
    );
    conn.query_row(&sql, params, row_to_record)
        .optional()
        .map_err(|err| err.to_string())
}

pub(super) fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgPlanRevision> {
    let revision_number_raw: i64 = row.get(2)?;
    let policy_raw: String = row.get(11)?;
    let status_raw: String = row.get(12)?;
    let plan_revision_id: String = row.get(1)?;
    let source_task_id: String = row.get(6)?;
    Ok(AgentOrgPlanRevision {
        approval_id: row.get(0)?,
        plan_revision_id: plan_revision_id.clone(),
        revision_number: parse_non_negative_u64(2, revision_number_raw)?,
        previous_plan_revision_id: row.get(3)?,
        request_id: row.get(4)?,
        org_run_id: row.get(5)?,
        source_task_id: source_task_id.clone(),
        source_member_id: row.get(7)?,
        source_session_id: row.get(8)?,
        source_turn_intent_id: row.get(9)?,
        root_session_id: row.get(10)?,
        policy: parse_policy(11, &policy_raw)?,
        status: parse_status(12, &status_raw)?,
        plan_title: row.get(13)?,
        plan_path: row.get(14)?,
        plan_content: row.get(15)?,
        content_digest: row.get(16)?,
        decision_by: parse_decision_by(17, row.get(17)?)?,
        feedback: row.get(18)?,
        task_output: parse_task_output_ref(21, row.get(21)?, &source_task_id, &plan_revision_id)?,
        created_at: row.get(19)?,
        resolved_at: row.get(20)?,
    })
}

pub(super) fn row_to_summary(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<AgentOrgPlanRevisionSummary> {
    let revision_number_raw: i64 = row.get(2)?;
    let policy_raw: String = row.get(11)?;
    let status_raw: String = row.get(12)?;
    let plan_content_bytes_raw: i64 = row.get(14)?;
    let plan_revision_id: String = row.get(1)?;
    let source_task_id: String = row.get(6)?;
    Ok(AgentOrgPlanRevisionSummary {
        approval_id: row.get(0)?,
        plan_revision_id: plan_revision_id.clone(),
        revision_number: parse_non_negative_u64(2, revision_number_raw)?,
        previous_plan_revision_id: row.get(3)?,
        request_id: row.get(4)?,
        org_run_id: row.get(5)?,
        source_task_id: source_task_id.clone(),
        source_member_id: row.get(7)?,
        source_session_id: row.get(8)?,
        source_turn_intent_id: row.get(9)?,
        root_session_id: row.get(10)?,
        policy: parse_policy(11, &policy_raw)?,
        status: parse_status(12, &status_raw)?,
        plan_title: row.get(13)?,
        plan_content_bytes: parse_non_negative_u64(14, plan_content_bytes_raw)?,
        content_digest: row.get(15)?,
        decision_by: parse_decision_by(16, row.get(16)?)?,
        feedback: row.get(17)?,
        task_output: parse_task_output_ref(20, row.get(20)?, &source_task_id, &plan_revision_id)?,
        created_at: row.get(18)?,
        resolved_at: row.get(19)?,
    })
}

fn parse_non_negative_u64(column: usize, raw: i64) -> rusqlite::Result<u64> {
    u64::try_from(raw).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, raw))
}

pub(super) fn parse_decision_by(
    column: usize,
    raw: Option<String>,
) -> rusqlite::Result<Option<String>> {
    match raw.as_deref() {
        None | Some("user" | "coordinator" | "automatic" | "system") => Ok(raw),
        Some(other) => Err(rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            format!("unknown Agent Org plan decision actor: {other}").into(),
        )),
    }
}

fn parse_status(column: usize, raw: &str) -> rusqlite::Result<AgentOrgPlanDecisionStatus> {
    AgentOrgPlanDecisionStatus::from_wire(raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, err.into())
    })
}

fn parse_policy(column: usize, policy_raw: &str) -> rusqlite::Result<PlanApprovalPolicy> {
    match policy_raw {
        "coordinator" => Ok(PlanApprovalPolicy::Coordinator),
        "user" => Ok(PlanApprovalPolicy::User),
        "automatic" => Ok(PlanApprovalPolicy::Automatic),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            format!("unknown plan approval policy: {policy_raw}").into(),
        )),
    }
}

fn parse_task_output_ref(
    column: usize,
    raw: Option<String>,
    task_id: &str,
    plan_revision_id: &str,
) -> rusqlite::Result<Option<AgentOrgPlanTaskOutputRef>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let output: TaskOutput = serde_json::from_str(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, err.into())
    })?;
    Ok(
        (output.plan_revision_id.as_deref() == Some(plan_revision_id)).then(|| {
            AgentOrgPlanTaskOutputRef {
                task_id: task_id.to_string(),
                plan_revision_id: plan_revision_id.to_string(),
                produced_by_member_id: output.produced_by_member_id,
                produced_at: output.produced_at,
            }
        }),
    )
}
