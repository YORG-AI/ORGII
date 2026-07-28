//! The pending-plan snapshot type and the small id / auto-approve-deadline
//! helpers derived from it.

use std::path::Path;

use super::persistence::PendingPlanRow;

/// Read-only snapshot of the current pending plan. Broadcast on creation and
/// queryable via debug endpoints / FE re-mount.
#[derive(Debug, Clone)]
pub struct PendingPlanApproval {
    pub session_id: String,
    pub tool_call_id: Option<String>,
    pub plan_id: String,
    pub plan_revision_id: String,
    pub origin_tool_call_id: Option<String>,
    pub plan_path: String,
    pub plan_title: String,
    pub plan_content: String,
    pub created_at_ms: i64,
}

impl PendingPlanApproval {
    pub(super) fn to_row(&self) -> PendingPlanRow {
        PendingPlanRow {
            session_id: self.session_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            plan_id: self.plan_id.clone(),
            plan_revision_id: self.plan_revision_id.clone(),
            origin_tool_call_id: self.origin_tool_call_id.clone(),
            plan_path: self.plan_path.clone(),
            plan_title: self.plan_title.clone(),
            plan_content: self.plan_content.clone(),
            created_at_ms: self.created_at_ms,
        }
    }

    pub(super) fn from_row(row: PendingPlanRow) -> Self {
        Self {
            session_id: row.session_id,
            tool_call_id: row.tool_call_id,
            plan_id: row.plan_id,
            plan_revision_id: row.plan_revision_id,
            origin_tool_call_id: row.origin_tool_call_id,
            plan_path: row.plan_path,
            plan_title: row.plan_title,
            plan_content: row.plan_content,
            created_at_ms: row.created_at_ms,
        }
    }
}

pub(super) fn plan_id_for(session_id: &str, plan_path: &str) -> String {
    let suffix = Path::new(plan_path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("plan")
        .replace(|character: char| !character.is_ascii_alphanumeric(), "-");
    format!("plan-{session_id}-{suffix}")
}

pub(super) fn revision_id_for(tool_call_id: Option<&str>, fallback: &str) -> String {
    tool_call_id.unwrap_or(fallback).to_string()
}

pub(super) fn auto_approve_deadline_ms(created_at_ms: i64) -> Option<i64> {
    match super::super::presence_state::global_policy().plan_auto_approve {
        super::super::presence_policy::AutoResolve::Off => None,
        super::super::presence_policy::AutoResolve::After(window) => {
            Some(created_at_ms + window.as_millis() as i64)
        }
    }
}

pub fn auto_approve_deadline_for_snapshot(snapshot: &PendingPlanApproval) -> Option<i64> {
    auto_approve_deadline_ms(snapshot.created_at_ms)
}
