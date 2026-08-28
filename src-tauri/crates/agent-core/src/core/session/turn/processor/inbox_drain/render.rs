//! Inbox attachment XML renderer.
//!
//! `render_inbox_attachment`, `render_one_row`, `render_payload`, and the
//! XML escaper live here so the main drain logic stays focused on flow
//! control and persistence.

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentMessage, MemberIdleReason, MemberTerminationReason, USER_SENDER_ID,
};
use crate::coordination::agent_org_runs::AgentOrgRunContext;

const BUILD_TASK_LIFECYCLE_INSTRUCTIONS: &str = "Before doing this task, call task_update for this exact task_id with operation=\"start\". Only you, the owning member, may record this task's lifecycle or output. When finished, call task_update with operation=\"complete\" and output={summary, content?, artifact_ids?}; summary is required. If execution fails, use operation=\"fail\" with a bounded reason.";
const PLAN_TASK_LIFECYCLE_INSTRUCTIONS: &str = "Before planning, call task_update for this exact task_id with operation=\"start\". When the plan is ready, call create_plan to submit the formal plan revision. Do not call task_update operation=\"complete\" for a planning task: the formal plan decision owns completion. If planning fails before submission, use operation=\"fail\" with a bounded reason.";

fn task_lifecycle_instructions(
    execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode,
) -> &'static str {
    match execution_mode {
        crate::coordination::agent_org_tasks::TaskExecutionMode::Build => {
            BUILD_TASK_LIFECYCLE_INSTRUCTIONS
        }
        crate::coordination::agent_org_tasks::TaskExecutionMode::Plan => {
            PLAN_TASK_LIFECYCLE_INSTRUCTIONS
        }
    }
}

pub(super) fn render_inbox_attachment(
    rows: &[AgentInboxRecord],
    ctx: &AgentOrgRunContext,
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<inbox-batch run_id=\"{}\" org=\"{}\">\n",
        xml_escape(&ctx.run_id),
        xml_escape(&ctx.org_name),
    ));
    if rows.iter().any(|row| row.sender_agent_id == USER_SENDER_ID) {
        out.push_str("  <inbox-priority>Messages from from_member_id=\"user\" are high-priority group chat input. Answer the user first, then continue with the remaining inbox messages.</inbox-priority>\n");
    }
    for row in rows {
        out.push_str(&render_one_row(row));
        out.push('\n');
    }
    out.push_str("</inbox-batch>");
    out
}

pub(super) fn render_inbox_transcript(rows: &[AgentInboxRecord]) -> String {
    rows.iter()
        .map(|row| match row.decode_payload() {
            Ok(message) => {
                let body = render_payload_for_transcript(&message);
                let trimmed = body.trim();
                if trimmed.is_empty() {
                    render_transcript_fallback(row, "decoded payload rendered empty")
                } else {
                    render_transcript_entry(row, trimmed)
                }
            }
            Err(err) => render_transcript_fallback(row, &err),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Every Inbox source row needs a durable transcript representation before
/// it can ever be acknowledged. Historical/manual DB corruption therefore
/// degrades to a bounded diagnostic instead of being filtered out (which
/// would leave an unread row spinning forever without a receipt).
fn render_transcript_fallback(row: &AgentInboxRecord, reason: &str) -> String {
    const MAX_RAW_PREVIEW_CHARS: usize = 4_096;
    let raw = crate::utils::safe_truncate_chars_to_string(&row.payload_json, MAX_RAW_PREVIEW_CHARS);
    render_transcript_entry(
        row,
        &format!("Undecodable payload: {reason}\nRaw payload: {raw}"),
    )
}

fn render_transcript_entry(row: &AgentInboxRecord, body: &str) -> String {
    let sender = row.sender_member_id.as_deref().unwrap_or_else(|| {
        if row.sender_agent_id == USER_SENDER_ID {
            "user"
        } else {
            "system"
        }
    });
    let request_id = row.request_id.as_deref().unwrap_or("none");
    format!(
        "[Agent Org inbox message id={} from_member_id={} kind={} request_id={} created_at={}]\n{}",
        row.id, sender, row.payload_kind, request_id, row.created_at, body
    )
}

fn render_one_row(row: &AgentInboxRecord) -> String {
    let request_id_attr = match &row.request_id {
        Some(rid) => format!(" request_id=\"{}\"", xml_escape(rid)),
        None => String::new(),
    };

    let body = match row.decode_payload() {
        Ok(msg) => render_payload(&msg),
        Err(err) => {
            const MAX_RAW_PREVIEW_CHARS: usize = 4_096;
            let raw = crate::utils::safe_truncate_chars_to_string(
                &row.payload_json,
                MAX_RAW_PREVIEW_CHARS,
            );
            let truncated = raw.len() < row.payload_json.len();
            format!(
                "<raw decode_error=\"{}\" truncated=\"{}\">{}</raw>",
                xml_escape(&err),
                truncated,
                xml_escape(&raw)
            )
        }
    };

    let sender_label = row.sender_member_id.as_deref().unwrap_or_else(|| {
        if row.sender_agent_id == USER_SENDER_ID {
            "user"
        } else {
            "system"
        }
    });

    format!(
        "  <inbox-message id=\"{}\" from_member_id=\"{}\" kind=\"{}\" created_at=\"{}\"{}>{}</inbox-message>",
        row.id,
        xml_escape(sender_label),
        xml_escape(&row.payload_kind),
        xml_escape(&row.created_at),
        request_id_attr,
        body,
    )
}

fn render_payload_for_transcript(msg: &AgentMessage) -> String {
    match msg {
        AgentMessage::Plain { text, .. } => text.trim().to_string(),
        AgentMessage::ShutdownRequest { reason, .. } => reason
            .as_ref()
            .map(|value| format!("Shutdown requested\n{value}"))
            .unwrap_or_else(|| "Shutdown requested".to_string()),
        AgentMessage::ShutdownResponse { accepted, note, .. } => {
            let status = if *accepted { "accepted" } else { "rejected" };
            join_non_empty([
                format!("Shutdown response: {status}"),
                note.clone().unwrap_or_default(),
            ])
        }
        AgentMessage::PlanApprovalRequest {
            source_task_id,
            plan_title,
            plan_path,
            plan_content,
            ..
        } => join_non_empty([
            format!("Plan approval requested: {plan_title}"),
            format!("Source task: {source_task_id}"),
            plan_path.clone(),
            plan_content.clone(),
        ]),
        AgentMessage::PlanApprovalResponse {
            accepted,
            feedback,
            next_mode,
            ..
        } => {
            let status = if *accepted { "approved" } else { "rejected" };
            let mode = next_mode
                .map(|mode| format!("Next mode: {}", mode.as_str()))
                .unwrap_or_else(|| "Next mode: unchanged".to_string());
            join_non_empty([
                format!("Plan {status}"),
                mode,
                feedback.clone().unwrap_or_default(),
            ])
        }
        AgentMessage::PlanDecisionCommitted {
            plan_revision_id,
            source_task_id,
            outcome,
            decided_by,
            feedback,
            task_output_digest,
            remaining_open_task_count,
            ..
        } => join_non_empty([
            format!(
                "Plan revision {plan_revision_id} was {} by {}.",
                match outcome {
                    crate::coordination::agent_inbox::PlanDecisionOutcome::Approved => "approved",
                    crate::coordination::agent_inbox::PlanDecisionOutcome::ChangesRequested =>
                        "sent back for changes",
                },
                match decided_by {
                    crate::coordination::agent_inbox::PlanDecisionActor::User => "the user",
                    crate::coordination::agent_inbox::PlanDecisionActor::Coordinator =>
                        "the Coordinator",
                    crate::coordination::agent_inbox::PlanDecisionActor::Automatic =>
                        "automatic policy",
                }
            ),
            format!("Planning Task ID: {source_task_id}"),
            feedback.clone().unwrap_or_default(),
            task_output_digest
                .as_ref()
                .map(|digest| format!("TaskOutput digest: {digest}"))
                .unwrap_or_default(),
            format!("Remaining open tasks: {remaining_open_task_count}"),
        ]),
        AgentMessage::MemberTerminated { member_name, .. } => {
            format!("{member_name} shut down.")
        }
        AgentMessage::MemberIdle {
            member_name,
            reason,
            summary,
            failure_reason,
            unfinished_task_ids,
            ..
        } => {
            let status = match reason {
                MemberIdleReason::Available => "available",
                MemberIdleReason::Interrupted => "interrupted",
                MemberIdleReason::Failed => "failed",
            };
            join_non_empty([
                format!("{member_name} is {status}."),
                summary.clone().unwrap_or_default(),
                failure_reason.clone().unwrap_or_default(),
                if unfinished_task_ids.is_empty() {
                    String::new()
                } else {
                    format!(
                        "Lifecycle incomplete for task(s): {}. The member is idle; do not wait silently. Ask it to finish the lifecycle or reassign explicitly.",
                        unfinished_task_ids.join(", ")
                    )
                },
            ])
        }
        AgentMessage::TaskAssigned {
            task_id,
            subject,
            description,
            assigned_by,
            execution_mode,
            dependency_outputs,
        } => {
            let handoffs = dependency_outputs
                .iter()
                .map(|output| {
                    join_non_empty([
                        format!("Upstream result — {}: {}", output.subject, output.summary),
                        output.content.clone().unwrap_or_default(),
                        if output.artifact_ids.is_empty() {
                            String::new()
                        } else {
                            format!("Artifacts: {}", output.artifact_ids.join(", "))
                        },
                    ])
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            join_non_empty([
                format!("Task assigned by {assigned_by}: {subject}"),
                format!("Task ID: {task_id}"),
                format!("Execution mode: {}", execution_mode.as_wire()),
                description.clone(),
                handoffs,
                task_lifecycle_instructions(*execution_mode).to_string(),
            ])
        }
        AgentMessage::TaskAssignmentCommitted {
            task_id,
            owner_member_id,
            subject,
            assigned_by,
        } => join_non_empty([
            format!("Task assignment committed by {assigned_by}: {subject}"),
            format!("Task ID: {task_id}"),
            format!("Owner member ID: {owner_member_id}"),
            "This is a durable graph fact for observation; do not execute the assigned Task as Coordinator."
                .to_string(),
        ]),
        AgentMessage::TaskCompleted {
            task_id,
            subject,
            completed_by_member_id,
            output_summary,
            plan_revision_id,
            remaining_open_task_count,
        } => join_non_empty([
            format!("Task completed by {completed_by_member_id}: {subject}"),
            format!("Task ID: {task_id}"),
            output_summary.clone().unwrap_or_default(),
            plan_revision_id
                .as_ref()
                .map(|id| format!("Approved plan revision: {id}"))
                .unwrap_or_default(),
            format!("Remaining open tasks: {remaining_open_task_count}"),
            "Use the atomic completion-candidate snapshot in this Turn's system context before deciding the next step. When its state is ready, call org_run_complete directly; do not refresh task_list merely to confirm completion. When it is blocked, handle only the explicit blocker or wait for the next durable Team event.".to_string(),
        ]),
        AgentMessage::TaskTerminal {
            task_id,
            subject,
            terminal_status,
            terminal_by_member_id,
            reason_code,
            reason_message,
            remaining_open_task_count,
        } => join_non_empty([
            format!(
                "Task {} by {terminal_by_member_id}: {subject}",
                match terminal_status {
                    crate::coordination::agent_inbox::TaskTerminalStatus::Failed => "failed",
                    crate::coordination::agent_inbox::TaskTerminalStatus::Cancelled => "cancelled",
                }
            ),
            format!("Task ID: {task_id}"),
            format!("Reason ({reason_code}): {reason_message}"),
            format!("Remaining open tasks: {remaining_open_task_count}"),
        ]),
        AgentMessage::ExecModeSetRequest { mode, reason, .. } => join_non_empty([
            format!("Execution mode requested: {}", mode.as_str()),
            reason.clone().unwrap_or_default(),
        ]),
    }
}

fn join_non_empty(lines: impl IntoIterator<Item = String>) -> String {
    lines
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn render_payload(msg: &AgentMessage) -> String {
    match msg {
        AgentMessage::Plain { summary, text } => format!(
            "<plain summary=\"{}\">{}</plain>",
            xml_escape(summary),
            xml_escape(text)
        ),
        AgentMessage::ShutdownRequest { reason, .. } => match reason {
            Some(r) => format!("<shutdown_request reason=\"{}\"/>", xml_escape(r)),
            None => "<shutdown_request/>".to_string(),
        },
        AgentMessage::ShutdownResponse { accepted, note, .. } => format!(
            "<shutdown_response accepted=\"{}\">{}</shutdown_response>",
            accepted,
            note.as_deref().map(xml_escape).unwrap_or_default(),
        ),
        AgentMessage::PlanApprovalRequest {
            approval_id,
            plan_revision_id,
            source_task_id,
            plan_title,
            plan_path,
            plan_content,
            ..
        } => format!(
            "<plan_approval_request approval_id=\"{}\" plan_revision_id=\"{}\" source_task_id=\"{}\" title=\"{}\" path=\"{}\">{}</plan_approval_request>",
            xml_escape(approval_id),
            xml_escape(plan_revision_id),
            xml_escape(source_task_id),
            xml_escape(plan_title),
            xml_escape(plan_path),
            xml_escape(plan_content),
        ),
        AgentMessage::PlanApprovalResponse {
            accepted,
            feedback,
            next_mode,
            ..
        } => {
            let mode_attr = match next_mode {
                Some(mode) => format!(" next_mode=\"{}\"", xml_escape(mode.as_str())),
                None => String::new(),
            };
            format!(
                "<plan_approval_response accepted=\"{}\"{}>{}</plan_approval_response>",
                accepted,
                mode_attr,
                feedback.as_deref().map(xml_escape).unwrap_or_default(),
            )
        }
        AgentMessage::PlanDecisionCommitted {
            approval_id,
            plan_revision_id,
            source_task_id,
            outcome,
            decided_by,
            feedback,
            task_output_digest,
            remaining_open_task_count,
        } => format!(
            "<plan_decision_committed approval_id=\"{}\" plan_revision_id=\"{}\" source_task_id=\"{}\" outcome=\"{}\" decided_by=\"{}\" task_output_digest=\"{}\" remaining_open_task_count=\"{}\">{}</plan_decision_committed>",
            xml_escape(approval_id),
            xml_escape(plan_revision_id),
            xml_escape(source_task_id),
            match outcome {
                crate::coordination::agent_inbox::PlanDecisionOutcome::Approved => "approved",
                crate::coordination::agent_inbox::PlanDecisionOutcome::ChangesRequested =>
                    "changes_requested",
            },
            match decided_by {
                crate::coordination::agent_inbox::PlanDecisionActor::User => "user",
                crate::coordination::agent_inbox::PlanDecisionActor::Coordinator => "coordinator",
                crate::coordination::agent_inbox::PlanDecisionActor::Automatic => "automatic",
            },
            task_output_digest.as_deref().map(xml_escape).unwrap_or_default(),
            remaining_open_task_count,
            feedback.as_deref().map(xml_escape).unwrap_or_default(),
        ),
        AgentMessage::MemberTerminated {
            member_id,
            member_name,
            reason,
        } => format!(
            "<member_terminated member_id=\"{}\" member_name=\"{}\" reason=\"{}\"/>",
            xml_escape(member_id),
            xml_escape(member_name),
            // `reason` is a serde-snake_case enum; render its tag string
            // verbatim so the LLM can branch on it without re-parsing.
            xml_escape(match reason {
                MemberTerminationReason::Shutdown => "shutdown",
            }),
        ),
        AgentMessage::MemberIdle {
            member_id,
            member_name,
            reason,
            current_mode,
            summary,
            failure_reason,
            unfinished_task_ids,
        } => {
            // `reason` -> stable wire string for the LLM.
            let reason_str = match reason {
                MemberIdleReason::Available => "available",
                MemberIdleReason::Interrupted => "interrupted",
                MemberIdleReason::Failed => "failed",
            };
            // Optional fields rendered as inline attributes when present
            // so the LLM can read them in one pass; absent fields are
            // simply omitted (no empty attribute noise).
            let mode_attr = match current_mode {
                Some(mode) => format!(" current_mode=\"{}\"", xml_escape(mode.as_str())),
                None => String::new(),
            };
            let summary_attr = match summary {
                Some(s) if !s.trim().is_empty() => {
                    format!(" summary=\"{}\"", xml_escape(s))
                }
                _ => String::new(),
            };
            let failure_attr = match failure_reason {
                Some(s) if !s.trim().is_empty() => {
                    format!(" failure_reason=\"{}\"", xml_escape(s))
                }
                _ => String::new(),
            };
            let unfinished_attr = if unfinished_task_ids.is_empty() {
                String::new()
            } else {
                format!(
                    " unfinished_task_ids=\"{}\"",
                    xml_escape(&unfinished_task_ids.join(","))
                )
            };
            format!(
                "<member_idle member_id=\"{}\" member_name=\"{}\" reason=\"{}\"{}{}{}{}/>",
                xml_escape(member_id),
                xml_escape(member_name),
                xml_escape(reason_str),
                mode_attr,
                summary_attr,
                failure_attr,
                unfinished_attr,
            )
        }
        AgentMessage::TaskAssigned {
            task_id,
            subject,
            description,
            assigned_by,
            execution_mode,
            dependency_outputs,
        } => {
            let outputs = dependency_outputs
                .iter()
                .map(|output| {
                    let content = output.content.as_deref().unwrap_or_default();
                    let artifacts = output.artifact_ids.join(",");
                    format!(
                        "<dependency_output task_id=\"{}\" subject=\"{}\" produced_by_member_id=\"{}\" summary=\"{}\" artifacts=\"{}\">{}</dependency_output>",
                        xml_escape(&output.task_id),
                        xml_escape(&output.subject),
                        xml_escape(&output.produced_by_member_id),
                        xml_escape(&output.summary),
                        xml_escape(&artifacts),
                        xml_escape(content),
                    )
                })
                .collect::<String>();
            format!(
                "<task_assigned task_id=\"{}\" subject=\"{}\" assigned_by=\"{}\" execution_mode=\"{}\"><description>{}</description>{}<instructions>{}</instructions></task_assigned>",
                xml_escape(task_id),
                xml_escape(subject),
                xml_escape(assigned_by),
                execution_mode.as_wire(),
                xml_escape(description),
                outputs,
                xml_escape(task_lifecycle_instructions(*execution_mode)),
            )
        }
        AgentMessage::TaskAssignmentCommitted {
            task_id,
            owner_member_id,
            subject,
            assigned_by,
        } => format!(
            "<task_assignment_committed task_id=\"{}\" owner_member_id=\"{}\" subject=\"{}\" assigned_by=\"{}\"><instructions>This is a durable graph fact for observation; do not execute the assigned Task as Coordinator.</instructions></task_assignment_committed>",
            xml_escape(task_id),
            xml_escape(owner_member_id),
            xml_escape(subject),
            xml_escape(assigned_by),
        ),
        AgentMessage::TaskCompleted {
            task_id,
            subject,
            completed_by_member_id,
            output_summary,
            plan_revision_id,
            remaining_open_task_count,
        } => format!(
            "<task_completed task_id=\"{}\" subject=\"{}\" completed_by_member_id=\"{}\" plan_revision_id=\"{}\" remaining_open_task_count=\"{}\">{}</task_completed>",
            xml_escape(task_id),
            xml_escape(subject),
            xml_escape(completed_by_member_id),
            plan_revision_id.as_deref().map(xml_escape).unwrap_or_default(),
            remaining_open_task_count,
            output_summary.as_deref().map(xml_escape).unwrap_or_default(),
        ),
        AgentMessage::TaskTerminal {
            task_id,
            subject,
            terminal_status,
            terminal_by_member_id,
            reason_code,
            reason_message,
            remaining_open_task_count,
        } => format!(
            "<task_terminal task_id=\"{}\" subject=\"{}\" terminal_status=\"{}\" terminal_by_member_id=\"{}\" reason_code=\"{}\" remaining_open_task_count=\"{}\">{}</task_terminal>",
            xml_escape(task_id),
            xml_escape(subject),
            match terminal_status {
                crate::coordination::agent_inbox::TaskTerminalStatus::Failed => "failed",
                crate::coordination::agent_inbox::TaskTerminalStatus::Cancelled => "cancelled",
            },
            xml_escape(terminal_by_member_id),
            xml_escape(reason_code),
            remaining_open_task_count,
            xml_escape(reason_message),
        ),
        AgentMessage::ExecModeSetRequest { mode, reason, .. } => {
            let reason_attr = match reason {
                Some(r) if !r.trim().is_empty() => {
                    format!(" reason=\"{}\"", xml_escape(r))
                }
                _ => String::new(),
            };
            format!(
                "<exec_mode_set_request mode=\"{}\"{}/>",
                xml_escape(mode.as_str()),
                reason_attr,
            )
        }
    }
}

/// Minimal XML attribute-safe escape. Sufficient for the small set of
/// characters that show up in agent_id, sender names, payload action
/// strings, etc. Not a general-purpose XML escaper — we control all
/// inputs that flow through here.
pub(super) fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}
