//! Transcript-event construction for the plan-approval card, and the small
//! status enum that drives its wire `status` field.

use chrono::TimeZone;

use core_types::session_event::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};
use core_types::tool_names;

use super::snapshot::PendingPlanApproval;

#[derive(Clone, Copy)]
pub(super) enum PlanApprovalCardStatus {
    Pending,
    Archived,
    Approved,
    Cancelled,
}

impl PlanApprovalCardStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Archived => "archived",
            Self::Approved => "approved",
            Self::Cancelled => "cancelled",
        }
    }

    fn display_status(self) -> EventDisplayStatus {
        match self {
            Self::Pending => EventDisplayStatus::AwaitingUser,
            Self::Archived | Self::Approved | Self::Cancelled => EventDisplayStatus::Completed,
        }
    }
}

fn plan_created_at_iso(snapshot: &PendingPlanApproval) -> String {
    chrono::Utc
        .timestamp_millis_opt(snapshot.created_at_ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

pub(super) fn build_plan_approval_event(
    snapshot: &PendingPlanApproval,
    source: &str,
    status: PlanApprovalCardStatus,
) -> SessionEvent {
    let args = serde_json::json!({
        "title": &snapshot.plan_title,
        "content": &snapshot.plan_content,
        "planPath": &snapshot.plan_path,
        "planId": &snapshot.plan_id,
        "planRevisionId": &snapshot.plan_revision_id,
        "originToolCallId": &snapshot.origin_tool_call_id,
        "planEventSource": source,
    });
    let result = serde_json::json!({
        "status": status.as_str(),
        "planId": &snapshot.plan_id,
        "planRevisionId": &snapshot.plan_revision_id,
        "planPath": &snapshot.plan_path,
    });
    let event_id = match status {
        PlanApprovalCardStatus::Pending => snapshot.plan_revision_id.clone(),
        PlanApprovalCardStatus::Archived => format!("{}-archived", snapshot.plan_revision_id),
        PlanApprovalCardStatus::Approved => format!("{}-approved", snapshot.plan_revision_id),
        PlanApprovalCardStatus::Cancelled => format!("{}-cancelled", snapshot.plan_revision_id),
    };
    SessionEvent {
        id: event_id,
        chunk_id: None,
        session_id: snapshot.session_id.clone(),
        created_at: plan_created_at_iso(snapshot),
        function_name: tool_names::PLAN_APPROVAL.to_string(),
        ui_canonical: tool_names::PLAN_APPROVAL.to_string(),
        action_type: tool_names::PLAN_APPROVAL.to_string(),
        args,
        result,
        source: EventSource::Assistant,
        display_text: snapshot.plan_title.clone(),
        display_status: status.display_status(),
        display_variant: EventDisplayVariant::ToolCall,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: Some(snapshot.plan_revision_id.clone()),
        file_path: Some(snapshot.plan_path.clone()),
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    }
}
