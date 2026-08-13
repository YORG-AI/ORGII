use crate::projects::types::{
    WorkItemData, WorkItemHandoff, WorkItemHandoffAction, WorkItemHandoffStatus,
    WorkItemHandoffTransition,
};

use super::{
    atomic::update_standalone_work_item_atomic_as,
    crud::{read_standalone_work_item, read_work_item},
    update_work_item_atomic_as,
};

const MAX_HANDOFF_RESPONSE_NOTE_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
enum AssigneeEffect {
    Keep,
    ReassignToSender(String),
}

fn normalized_required(value: &str, field: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("{field} is required"));
    }
    Ok(normalized.to_string())
}

fn normalized_response_note(
    action: &WorkItemHandoffAction,
    note: Option<&str>,
) -> Result<Option<String>, String> {
    let normalized = note.map(str::trim).filter(|value| !value.is_empty());
    if matches!(action, WorkItemHandoffAction::Return) && normalized.is_none() {
        return Err("A return reason is required".to_string());
    }
    if normalized
        .map(|value| value.chars().count())
        .unwrap_or_default()
        > MAX_HANDOFF_RESPONSE_NOTE_CHARS
    {
        return Err(format!(
            "Handoff response note must be at most {MAX_HANDOFF_RESPONSE_NOTE_CHARS} characters"
        ));
    }
    Ok(normalized.map(str::to_string))
}

fn apply_handoff_transition(
    handoff: &mut WorkItemHandoff,
    transition: &WorkItemHandoffTransition,
    responded_at: &str,
) -> Result<AssigneeEffect, String> {
    let expected_id = normalized_required(&transition.handoff_id, "handoffId")?;
    if handoff.id != expected_id {
        return Err("This handoff has been superseded".to_string());
    }

    let actor_id = normalized_required(&transition.actor.id, "actor.id")?;
    if handoff.recipient_member_id != actor_id {
        return Err("Only the handoff recipient can respond".to_string());
    }

    let target_status = match transition.action {
        WorkItemHandoffAction::Accept => WorkItemHandoffStatus::Accepted,
        WorkItemHandoffAction::Return => WorkItemHandoffStatus::Returned,
    };
    if handoff.status == target_status {
        return Ok(AssigneeEffect::Keep);
    }
    if handoff.status != WorkItemHandoffStatus::Pending {
        return Err("This handoff has already been resolved".to_string());
    }

    let response_note = normalized_response_note(&transition.action, transition.note.as_deref())?;
    handoff.status = target_status;
    handoff.responded_at = Some(responded_at.to_string());
    handoff.response_note = response_note;

    match transition.action {
        WorkItemHandoffAction::Accept => Ok(AssigneeEffect::Keep),
        WorkItemHandoffAction::Return => Ok(AssigneeEffect::ReassignToSender(normalized_required(
            &handoff.sender_member_id,
            "senderMemberId",
        )?)),
    }
}

/// Atomically accepts or returns a pending human handoff.
///
/// The transition, optional reassignment, assignment-receipt reset, history
/// event, local version bump, and collaboration outbox record share the
/// existing Work Item atomic mutation boundary.
pub fn transition_work_item_handoff(
    project_slug: &str,
    short_id: &str,
    transition: &WorkItemHandoffTransition,
) -> Result<WorkItemData, String> {
    let responded_at = chrono::Utc::now().to_rfc3339();
    update_work_item_atomic_as(
        project_slug,
        short_id,
        Some(&transition.actor),
        |frontmatter, _body| {
            let handoff = frontmatter
                .handoff
                .as_mut()
                .ok_or_else(|| "This Work Item has no active handoff".to_string())?;
            match apply_handoff_transition(handoff, transition, &responded_at)? {
                AssigneeEffect::Keep => {}
                AssigneeEffect::ReassignToSender(sender_id) => {
                    frontmatter.assignee = Some(sender_id);
                    frontmatter.assignee_type = Some("member".to_string());
                }
            }
            Ok(())
        },
    )?;
    read_work_item(project_slug, short_id)
}

/// Standalone-org variant of [`transition_work_item_handoff`].
///
/// Cloud Team Inbox handoffs intentionally have no project row. They still
/// use the same atomic transition invariant and emit one org-scoped
/// collaboration write after the transaction commits.
pub fn transition_standalone_work_item_handoff(
    org_id: Option<&str>,
    short_id: &str,
    transition: &WorkItemHandoffTransition,
) -> Result<WorkItemData, String> {
    let org_id = org_id.unwrap_or("personal-org");
    let responded_at = chrono::Utc::now().to_rfc3339();
    let (_, changed_fields, payload_tail_changed) = update_standalone_work_item_atomic_as(
        org_id,
        short_id,
        Some(&transition.actor),
        crate::projects::io::work_items::atomic::AtomicServiceOptions::default(),
        |frontmatter, _body| {
            let handoff = frontmatter
                .handoff
                .as_mut()
                .ok_or_else(|| "This Work Item has no active handoff".to_string())?;
            match apply_handoff_transition(handoff, transition, &responded_at)? {
                AssigneeEffect::Keep => {}
                AssigneeEffect::ReassignToSender(sender_id) => {
                    frontmatter.assignee = Some(sender_id);
                    frontmatter.assignee_type = Some("member".to_string());
                }
            }
            Ok(())
        },
    )?;
    let data = read_standalone_work_item(Some(org_id), short_id)?;
    if !changed_fields.is_empty() || payload_tail_changed {
        crate::sync::collab_bridge::record_work_item_write(
            org_id,
            None,
            &data.frontmatter.id,
            false,
        )?;
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::types::WorkItemMutationActor;

    fn pending_handoff() -> WorkItemHandoff {
        WorkItemHandoff {
            id: "handoff-1".to_string(),
            status: WorkItemHandoffStatus::Pending,
            sender_member_id: "sender-1".to_string(),
            sender_name: "Ada".to_string(),
            recipient_member_id: "recipient-1".to_string(),
            recipient_name: "Lin".to_string(),
            note: Some("Please continue the investigation".to_string()),
            requested_at: "2026-07-28T10:00:00Z".to_string(),
            responded_at: None,
            response_note: None,
        }
    }

    fn transition(action: WorkItemHandoffAction) -> WorkItemHandoffTransition {
        WorkItemHandoffTransition {
            handoff_id: "handoff-1".to_string(),
            action,
            actor: WorkItemMutationActor {
                id: "recipient-1".to_string(),
                name: "Lin".to_string(),
            },
            note: None,
        }
    }

    #[test]
    fn recipient_accepts_pending_handoff() {
        let mut handoff = pending_handoff();
        let effect = apply_handoff_transition(
            &mut handoff,
            &transition(WorkItemHandoffAction::Accept),
            "2026-07-28T11:00:00Z",
        )
        .expect("accept");

        assert_eq!(effect, AssigneeEffect::Keep);
        assert_eq!(handoff.status, WorkItemHandoffStatus::Accepted);
        assert_eq!(
            handoff.responded_at.as_deref(),
            Some("2026-07-28T11:00:00Z")
        );
    }

    #[test]
    fn return_requires_reason_and_reassigns_to_sender() {
        let mut handoff = pending_handoff();
        let error = apply_handoff_transition(
            &mut handoff,
            &transition(WorkItemHandoffAction::Return),
            "2026-07-28T11:00:00Z",
        )
        .expect_err("return without reason");
        assert_eq!(error, "A return reason is required");
        assert_eq!(handoff.status, WorkItemHandoffStatus::Pending);

        let mut request = transition(WorkItemHandoffAction::Return);
        request.note = Some("Please add reproduction steps".to_string());
        let effect = apply_handoff_transition(&mut handoff, &request, "2026-07-28T11:00:00Z")
            .expect("return");
        assert_eq!(
            effect,
            AssigneeEffect::ReassignToSender("sender-1".to_string())
        );
        assert_eq!(handoff.status, WorkItemHandoffStatus::Returned);
        assert_eq!(
            handoff.response_note.as_deref(),
            Some("Please add reproduction steps")
        );
    }

    #[test]
    fn rejects_non_recipient_and_opposite_resolved_transition() {
        let mut handoff = pending_handoff();
        let mut request = transition(WorkItemHandoffAction::Accept);
        request.actor.id = "other-member".to_string();
        assert_eq!(
            apply_handoff_transition(&mut handoff, &request, "now").expect_err("wrong actor"),
            "Only the handoff recipient can respond"
        );

        handoff.status = WorkItemHandoffStatus::Accepted;
        let mut return_request = transition(WorkItemHandoffAction::Return);
        return_request.note = Some("Changed my mind".to_string());
        assert_eq!(
            apply_handoff_transition(&mut handoff, &return_request, "later")
                .expect_err("already accepted"),
            "This handoff has already been resolved"
        );
    }

    #[test]
    fn repeated_same_transition_is_idempotent() {
        let mut handoff = pending_handoff();
        handoff.status = WorkItemHandoffStatus::Accepted;
        handoff.responded_at = Some("original".to_string());
        let effect = apply_handoff_transition(
            &mut handoff,
            &transition(WorkItemHandoffAction::Accept),
            "retry",
        )
        .expect("idempotent retry");
        assert_eq!(effect, AssigneeEffect::Keep);
        assert_eq!(handoff.responded_at.as_deref(), Some("original"));
    }
}
